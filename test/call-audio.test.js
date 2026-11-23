const test = require("node:test");
const assert = require("node:assert/strict");
const CA = require("../android/assets/call-audio.js");

test("mic constraints disable platform voice processing and ask for 48 kHz", () => {
  var c = CA.micConstraints();
  assert.deepEqual(c.echoCancellation, { exact: false });
  assert.deepEqual(c.noiseSuppression, { exact: false });
  assert.deepEqual(c.autoGainControl, { exact: false });
  assert.deepEqual(c.googEchoCancellation, { exact: false });
  assert.deepEqual(c.googNoiseSuppression, { exact: false });
  assert.deepEqual(c.googAutoGainControl, { exact: false });
  assert.deepEqual(c.sampleRate, { ideal: 48000 });
  var fb = CA.fallbackConstraints();
  assert.equal(fb.echoCancellation, false);
  assert.equal(fb.noiseSuppression, false);
  assert.equal(fb.autoGainControl, false);
  assert.equal(fb.sampleRate, 48000);
});

test("opus fmtp is pinned to full-band and a consonant-safe bitrate", () => {
  var sdp = [
    "v=0",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111 0",
    "a=rtpmap:111 opus/48000/2",
    "a=fmtp:111 minptime=10;useinbandfec=1;maxplaybackrate=16000;usedtx=1",
    "a=rtpmap:0 PCMU/8000",
    ""
  ].join("\r\n");
  var tuned = CA.tuneSdp(sdp);
  var fmtp = tuned.split("\r\n").filter((l) => l.indexOf("a=fmtp:111") === 0)[0];
  assert.ok(fmtp, "opus fmtp missing");
  assert.ok(fmtp.indexOf("maxplaybackrate=48000") >= 0, fmtp);
  assert.ok(fmtp.indexOf("maxplaybackrate=16000") < 0, fmtp);
  assert.ok(fmtp.indexOf("sprop-maxcapturerate=48000") >= 0, fmtp);
  assert.ok(fmtp.indexOf("maxaveragebitrate=64000") >= 0, fmtp);
  assert.ok(fmtp.indexOf("stereo=0") >= 0, fmtp);
  assert.ok(fmtp.indexOf("useinbandfec=1") >= 0, fmtp);
  assert.ok(fmtp.indexOf("minptime=10") >= 0, fmtp);
  assert.ok(fmtp.indexOf("usedtx=1") >= 0, fmtp);
  assert.ok(tuned.indexOf("a=rtpmap:0 PCMU/8000") >= 0);
  assert.equal(CA.tuneSdp(tuned), tuned);
});

test("install rewrites offers from the peer connection the page constructs", async () => {
  function Fake() {}
  Fake.prototype.createOffer = function () {
    return Promise.resolve({
      type: "offer",
      sdp: "a=rtpmap:111 opus/48000/2\r\na=fmtp:111 maxplaybackrate=8000\r\n"
    });
  };
  Fake.prototype.createAnswer = function () {
    return Promise.resolve({ type: "answer", sdp: "a=rtpmap:111 opus/48000/2\r\n" });
  };
  Fake.prototype.setLocalDescription = function (desc) {
    this.local = desc;
    return Promise.resolve();
  };
  Fake.prototype.setRemoteDescription = function (desc) {
    this.remote = desc;
    return Promise.resolve();
  };
  Fake.prototype.addEventListener = function () {};
  var scope = { RTCPeerConnection: Fake };
  CA.install(scope);
  var pc = new scope.RTCPeerConnection({ iceServers: [] });
  var offer = await pc.createOffer();
  assert.ok(offer.sdp.indexOf("maxplaybackrate=48000") >= 0, offer.sdp);
  assert.ok(offer.sdp.indexOf("maxplaybackrate=8000") < 0, offer.sdp);
  var answer = await pc.createAnswer();
  assert.ok(answer.sdp.indexOf("a=fmtp:111 ") >= 0, answer.sdp);
  await pc.setRemoteDescription({ type: "answer", sdp: "a=rtpmap:111 opus/48000/2\r\na=fmtp:111 maxplaybackrate=8000\r\n" });
  assert.ok(pc.remote.sdp.indexOf("maxaveragebitrate=64000") >= 0, pc.remote.sdp);
});

test("an opus payload with no fmtp line gets one", () => {
  var sdp = "a=rtpmap:111 opus/48000/2\na=rtcp-mux\n";
  var tuned = CA.tuneSdp(sdp);
  assert.ok(tuned.indexOf("a=fmtp:111 ") >= 0, tuned);
  assert.ok(tuned.indexOf("maxplaybackrate=48000") >= 0, tuned);
  assert.ok(tuned.indexOf("a=rtcp-mux") >= 0, tuned);
});
