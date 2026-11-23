import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const chromePath = process.env.CHROME || "/opt/google/chrome/chrome";
const port = 9333;
const httpPort = 8766;
const profile = "/tmp/chrome-voice-guard";
const page = `http://127.0.0.1:${httpPort}/test/browser-guard.html?v=${Date.now()}`;

const httpd = spawn("python3", ["-m", "http.server", String(httpPort), "--bind", "127.0.0.1"], {
  cwd: "/workspace",
  stdio: "ignore"
});

const chrome = spawn(chromePath, [
  "--headless=new",
  "--disable-gpu",
  "--no-sandbox",
  "--no-first-run",
  "--disable-dev-shm-usage",
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${port}`,
  "about:blank"
], { stdio: "ignore" });

function die(msg) {
  chrome.kill("SIGKILL");
  httpd.kill("SIGKILL");
  console.error(msg);
  process.exit(1);
}

async function waitForJson() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch (e) {}
    await delay(100);
  }
  die("Chrome DevTools did not come up");
}

await waitForJson();
const created = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(page)}`, { method: "PUT" });
if (!created.ok) die("could not open the check page: " + created.status);
const target = await created.json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve);
  ws.addEventListener("error", () => reject(new Error("websocket failed")));
});

let id = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
function send(method, params) {
  const msgId = ++id;
  return new Promise((resolve) => {
    pending.set(msgId, resolve);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}

await send("Runtime.enable");
let result = "";
for (let i = 0; i < 40; i++) {
  const reply = await send("Runtime.evaluate", {
    expression: "window.__result",
    awaitPromise: true,
    returnByValue: true
  });
  const value = reply.result && reply.result.result && reply.result.result.value;
  if (typeof value === "string" && value) {
    result = value;
    break;
  }
  if (i === 39) console.error(JSON.stringify(reply).slice(0, 2000));
  await delay(100);
}
ws.close();
chrome.kill("SIGKILL");
httpd.kill("SIGKILL");
if (!result.startsWith("ok")) die(result || "no result from the page");
console.log(result);
process.exit(0);
