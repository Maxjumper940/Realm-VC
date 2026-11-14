(function () {
  const $ = (id) => document.getElementById(id);
  const getName = () => { try { return (localStorage.getItem("realmvcName") || "").trim(); } catch (e) { return ""; } };

  // ----- Intro (SharpCut-style) -----
  const intro = $("intro");
  if (intro) {
    const clock = $("introClock");
    const t0 = Date.now();
    const tick = setInterval(() => {
      const ms = Date.now() - t0;
      const s = Math.floor(ms / 1000), f = Math.floor((ms % 1000) / 1000 * 30);
      clock.textContent = "00:00:" + String(s).padStart(2, "0") + ":" + String(f).padStart(2, "0");
    }, 33);
    const name = getName();
    let total = 1600;
    if (name) {
      total = 3000;
      setTimeout(() => { $("introName").textContent = name + "."; $("introWelcome").hidden = false; }, 1300);
    }
    const close = () => { intro.classList.add("out"); setTimeout(() => { clearInterval(tick); intro.remove(); }, 650); };
    setTimeout(close, total);
    intro.addEventListener("click", close);
  }

  // ----- Names everywhere -----
  function refreshNames() {
    const n = getName();
    const me = $("meName"); if (me) me.textContent = n;
    const av = $("helloAvatar"); if (av) av.textContent = n ? n.charAt(0).toUpperCase() : "?";
    const hn = $("helloName"); if (hn) hn.textContent = n;
  }
  window.realmvcUiRefresh = () => { refreshNames(); renderRecent(); };
  const nameInput = $("nameInput"), namePreview = $("namePreview");
  if (nameInput && namePreview) {
    const upd = () => { namePreview.textContent = nameInput.value.trim() || "Veylin"; };
    nameInput.addEventListener("input", upd); upd();
  }

  // ----- Tabs -----
  function openTab(id) {
    document.querySelectorAll(".tab-page").forEach((p) => { p.hidden = p.dataset.page !== id; });
    document.querySelectorAll(".tabbar button").forEach((b) => {
      if (b.dataset.tab === id) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    window.scrollTo(0, 0);
    if (id === "recent") renderRecent();
  }
  document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => openTab(b.dataset.tab)));
  document.querySelectorAll("[data-goto]").forEach((b) => b.addEventListener("click", () => openTab(b.dataset.goto)));

  // ----- Banner carousel -----
  const SLIDES = [
    { t: "Up to 10 people. All free.", b: "One code, one tap, and your whole squad is in the call.", from: "#ff4fa8", to: "#8b2bff" },
    { t: "Talk while you play.", b: "Keeps running in the background while Minecraft is open.", from: "#ff1f7a", to: "#ff8cc6" },
    { t: "Mute from anywhere.", b: "Mute or end the call straight from your notification bar.", from: "#8b2bff", to: "#ff1f7a" }
  ];
  const banner = $("banner"), bText = $("bannerText"), dots = $("bannerDots");
  let si = 0;
  function showSlide(i) {
    si = i; const s = SLIDES[i];
    banner.style.background = `linear-gradient(135deg, ${s.from}, ${s.to})`;
    bText.innerHTML = `<span class="banner-title"></span><span class="banner-body"></span>`;
    bText.firstChild.textContent = s.t; bText.lastChild.textContent = s.b;
    bText.style.animation = "none"; void bText.offsetWidth; bText.style.animation = "";
    [...dots.children].forEach((d, n) => d.classList.toggle("on", n === i));
  }
  if (banner) {
    setInterval(() => showSlide((si + 1) % SLIDES.length), 4200);
    banner.addEventListener("click", () => $("btnCreate").click());
  }
  const tileJoin = $("tileJoin");
  if (tileJoin) tileJoin.addEventListener("click", () => {
    const j = $("joinCode"); j.focus(); j.scrollIntoView({ block: "center", behavior: "smooth" });
  });

  // ----- Recent rooms -----
  const loadRecent = () => { try { return JSON.parse(localStorage.getItem("realmvcRecent") || "[]"); } catch (e) { return []; } };
  function saveRecent(code, role) {
    if (!/^[A-Z0-9]{6}$/.test(code)) return;
    const list = loadRecent().filter((r) => r.code !== code);
    list.unshift({ code, role, at: Date.now() });
    try { localStorage.setItem("realmvcRecent", JSON.stringify(list.slice(0, 12))); } catch (e) {}
  }
  function ago(t) {
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return "just now"; if (m < 60) return m + " min ago";
    const h = Math.round(m / 60); if (h < 24) return h + " h ago";
    return Math.round(h / 24) + " d ago";
  }
  function useCode(code) {
    openTab("call");
    const j = $("joinCode"); j.value = code; j.focus();
  }
  function renderRecent() {
    const list = loadRecent();
    const strip = $("recentStrip"), ul = $("recentList");
    if (strip) {
      strip.innerHTML = "";
      if (!list.length) strip.innerHTML = '<p class="recent-empty">Rooms you create or join show up here.</p>';
      list.slice(0, 6).forEach((r) => {
        const b = document.createElement("button"); b.type = "button"; b.className = "recent-chip";
        b.innerHTML = "<b></b><span></span>"; b.firstChild.textContent = r.code; b.lastChild.textContent = r.role + " · " + ago(r.at);
        b.addEventListener("click", () => useCode(r.code)); strip.appendChild(b);
      });
    }
    if (ul) {
      ul.innerHTML = "";
      if (!list.length) ul.innerHTML = '<li><span class="recent-empty">No rooms yet.</span></li>';
      list.forEach((r) => {
        const li = document.createElement("li");
        li.innerHTML = '<div><b></b><div class="page-sub" style="margin:2px 0 0"></div></div><button class="btn ghost small" type="button">Use</button>';
        li.querySelector("b").textContent = r.code;
        li.querySelector(".page-sub").textContent = r.role + " · " + ago(r.at);
        li.querySelector("button").addEventListener("click", () => useCode(r.code));
        ul.appendChild(li);
      });
    }
  }
  const room = $("room"), codeEl = $("roomCodeDisplay"), roleEl = $("roomRole");
  if (room) new MutationObserver(() => {
    if (!room.hidden) {
      const code = (codeEl.textContent || "").trim();
      saveRecent(code, /your/i.test(roleEl.textContent || "") ? "Hosted" : "Joined");
    } else { renderRecent(); }
  }).observe(room, { attributes: true, attributeFilter: ["hidden"] });

  refreshNames(); renderRecent();
})();
