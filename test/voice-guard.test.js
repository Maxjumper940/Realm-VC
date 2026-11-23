const test = require("node:test");
const assert = require("node:assert/strict");
const VG = require("../android/assets/voice-guard.js");

function rms(buf, from, to) {
  var a = from || 0;
  var b = to == null ? buf.length : to;
  var s = 0;
  var n = 0;
  for (var i = a; i < b; i++) { s += buf[i] * buf[i]; n++; }
  return Math.sqrt(s / Math.max(1, n));
}

function peak(buf, from, to) {
  var a = from || 0;
  var b = to == null ? buf.length : to;
  var m = 0;
  for (var i = a; i < b; i++) {
    var v = buf[i] < 0 ? -buf[i] : buf[i];
    if (v > m) m = v;
  }
  return m;
}

function clipFraction(buf, from, to, level) {
  var a = from || 0;
  var b = to == null ? buf.length : to;
  var c = 0;
  var n = 0;
  var lim = level == null ? 0.98 : level;
  for (var i = a; i < b; i++) {
    n++;
    var v = buf[i] < 0 ? -buf[i] : buf[i];
    if (v >= lim) c++;
  }
  return c / Math.max(1, n);
}

function corr(a, b, from, to) {
  var s = 0, ea = 0, eb = 0;
  for (var i = from; i < to; i++) {
    s += a[i] * b[i];
    ea += a[i] * a[i];
    eb += b[i] * b[i];
  }
  return s / Math.sqrt(ea * eb + 1e-12);
}

// Near-end speech: vowel bursts, quiet enough that an unbounded speech AGC wants to boost.
function voiceAt(i, sr) {
  var t = i / sr;
  var cycle = t % 0.65;
  var gate = cycle < 0.32 ? 1 : 0;
  var amp = 0.045 * gate;
  return amp * (
    Math.sin(2 * Math.PI * 170 * t) +
    0.45 * Math.sin(2 * Math.PI * 340 * t) +
    0.2 * Math.sin(2 * Math.PI * 510 * t)
  );
}

// A different talker, used as far-end on headphones.
function otherAt(i, sr) {
  var t = i / sr;
  var cycle = (t + 0.2) % 0.55;
  var gate = cycle < 0.28 ? 1 : 0;
  var amp = 0.08 * gate;
  return amp * (
    Math.sin(2 * Math.PI * 240 * t) +
    0.4 * Math.sin(2 * Math.PI * 480 * t)
  );
}

// Model of the platform auto-gain this app used to request.
// It ratchets gain upward on every speech frame toward a target and will not
// come back down, up to +30 dB. Echo that re-enters the mic is speech-shaped,
// so the integrator keeps going until the samples sit on the rails.
function unboundedAgcState() { return { gain: 1 }; }
function unboundedAgc(mic, out, st) {
  var sum = 0;
  for (var i = 0; i < mic.length; i++) sum += mic[i] * mic[i];
  var level = Math.sqrt(sum / mic.length);
  var speech = level > 0.008;
  if (speech && level * st.gain < 0.12) st.gain *= 1.12;
  var max = Math.pow(10, 30 / 20);
  if (st.gain > max) st.gain = max;
  for (var j = 0; j < mic.length; j++) {
    var y = mic[j] * st.gain;
    if (y > 1) y = 1;
    else if (y < -1) y = -1;
    out[j] = y;
  }
}

// Speaker loop: what she sends comes back from the other phones and is played
// on her speaker, then the mic hears it a few milliseconds later.
function runLoop(mode, opts) {
  var sr = opts.sr;
  var seconds = opts.seconds;
  var n = Math.floor(seconds * sr);
  var block = Math.round(sr * 0.02);
  var ac = Math.round(opts.acousticMs / 1000 * sr);
  var net = Math.round(opts.networkMs / 1000 * sr);
  var k = opts.k;
  var ret = opts.returnGain;
  var send = new Float32Array(n);
  var dry = new Float32Array(n);
  var proc = mode === "guard" ? VG.createProcessor(sr) : null;
  var agc = unboundedAgcState();
  for (var b = 0; b < n; b += block) {
    var len = Math.min(block, n - b);
    var mic = new Float32Array(len);
    var ref = new Float32Array(len);
    for (var j = 0; j < len; j++) {
      var i = b + j;
      dry[i] = voiceAt(i, sr);
      var played = (i - net >= 0) ? send[i - net] * ret : 0;
      if (opts.farEnd === "other") played = otherAt(i, sr);
      ref[j] = played;
      var heard = 0;
      if (opts.farEnd === "other") {
        heard = (i - ac >= 0) ? k * otherAt(i - ac, sr) : 0;
      } else if (i - ac - net >= 0) {
        heard = k * send[i - ac - net] * ret;
      }
      mic[j] = dry[i] + heard;
    }
    var out = new Float32Array(len);
    if (mode === "guard") proc.process(mic, ref, out);
    else unboundedAgc(mic, out, agc);
    for (var j2 = 0; j2 < len; j2++) send[b + j2] = out[j2];
  }
  return { send: send, dry: dry, sr: sr, n: n };
}

test("unbounded auto-gain on a speaker loop climbs into a clipped scream", () => {
  var r = runLoop("agc", {
    sr: 16000, seconds: 4, acousticMs: 18, networkMs: 40, k: 0.62, returnGain: 1
  });
  var lateFrom = Math.floor(r.n * 0.65);
  var lateRms = rms(r.send, lateFrom, r.n);
  var clips = clipFraction(r.send, lateFrom, r.n, 0.98);
  assert.ok(clips > 0.15, "expected sustained clipping, got " + clips);
  assert.ok(lateRms > 0.45, "expected scream-level rms, got " + lateRms);
});

test("speaker loop stays at a stable speech level with the guard", () => {
  var r = runLoop("guard", {
    sr: 16000, seconds: 4, acousticMs: 18, networkMs: 40, k: 0.62, returnGain: 1
  });
  var midFrom = Math.floor(1.2 * r.sr);
  var midTo = Math.floor(2.2 * r.sr);
  var lateFrom = Math.floor(2.8 * r.sr);
  var midRms = rms(r.send, midFrom, midTo);
  var lateRms = rms(r.send, lateFrom, r.n);
  var latePeak = peak(r.send, lateFrom, r.n);
  var clips = clipFraction(r.send, lateFrom, r.n, 0.98);
  assert.ok(clips < 0.005, "clipped fraction " + clips);
  assert.ok(latePeak <= VG.LIMIT + 0.001, "peak " + latePeak);
  assert.ok(lateRms < 0.22, "late rms ran away: " + lateRms);
  assert.ok(lateRms < midRms * 1.6 + 0.02, "level grew from " + midRms + " to " + lateRms);
  assert.ok(lateRms > 0.015, "voice was gated away: " + lateRms);
  // Her own voice is still in the send. A canceller that deletes the talker fails this.
  var likeness = corr(r.send, r.dry, lateFrom, r.n);
  assert.ok(likeness > 0.45, "sent audio no longer matches her voice: " + likeness);
});

test("headphones: far-end playback is not treated as her voice, level stays put", () => {
  var r = runLoop("guard", {
    sr: 16000, seconds: 3.5, acousticMs: 12, networkMs: 0, k: 0.02, returnGain: 0, farEnd: "other"
  });
  var from = Math.floor(1.0 * r.sr);
  var lateRms = rms(r.send, from, r.n);
  var earlyRms = rms(r.send, Math.floor(0.4 * r.sr), Math.floor(1.2 * r.sr));
  assert.ok(peak(r.send, from, r.n) <= VG.LIMIT + 0.001);
  assert.ok(clipFraction(r.send, from, r.n, 0.98) === 0);
  assert.ok(Math.abs(lateRms - earlyRms) < 0.05, "rms drifted " + earlyRms + " -> " + lateRms);
  var likeness = corr(r.send, r.dry, from, r.n);
  assert.ok(likeness > 0.85, "headphones path distorted her voice: " + likeness);
});

test("a pure speaker echo is attenuated once the canceller locks", () => {
  var sr = 16000;
  var seconds = 2.5;
  var n = Math.floor(seconds * sr);
  var block = Math.round(sr * 0.02);
  var delay = Math.round(0.028 * sr);
  var proc = VG.createProcessor(sr);
  var micAll = new Float32Array(n);
  var outAll = new Float32Array(n);
  var refAll = new Float32Array(n);
  for (var i = 0; i < n; i++) refAll[i] = otherAt(i, sr);
  for (var b = 0; b < n; b += block) {
    var len = Math.min(block, n - b);
    var mic = new Float32Array(len);
    var ref = refAll.subarray(b, b + len);
    for (var j = 0; j < len; j++) {
      var i2 = b + j;
      mic[j] = i2 >= delay ? 0.75 * refAll[i2 - delay] : 0;
      micAll[i2] = mic[j];
    }
    var out = new Float32Array(len);
    proc.process(mic, ref, out);
    for (var j2 = 0; j2 < len; j2++) outAll[b + j2] = out[j2];
  }
  var echoRms = rms(micAll, Math.floor(1.6 * sr), n);
  var leftRms = rms(outAll, Math.floor(1.6 * sr), n);
  assert.ok(echoRms > 0.02, "fixture echo was silent");
  assert.ok(leftRms < echoRms * 0.45, "echo leftover " + leftRms + " vs " + echoRms);
});

test("quiet noise is not amplified toward a scream", () => {
  var sr = 16000;
  var n = sr * 3;
  var block = 320;
  var proc = VG.createProcessor(sr);
  var outAll = new Float32Array(n);
  var seed = 1;
  function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647 * 2 - 1; }
  for (var b = 0; b < n; b += block) {
    var len = Math.min(block, n - b);
    var mic = new Float32Array(len);
    var ref = new Float32Array(len);
    for (var j = 0; j < len; j++) mic[j] = 0.0015 * rnd();
    var out = new Float32Array(len);
    proc.process(mic, ref, out);
    for (var j2 = 0; j2 < len; j2++) outAll[b + j2] = out[j2];
  }
  assert.ok(rms(outAll, sr, n) < 0.02, "noise rms " + rms(outAll, sr, n));
  assert.ok(proc.stats().gain <= VG.MAX_GAIN + 1e-6);
  assert.ok(proc.stats().gain < 1.35, "gain chased the noise floor: " + proc.stats().gain);
});

test("gain has a hard ceiling and does not accumulate without bound", () => {
  var sr = 16000;
  var n = sr * 3;
  var block = 320;
  var proc = VG.createProcessor(sr);
  var gains = [];
  for (var b = 0; b < n; b += block) {
    var mic = new Float32Array(block);
    var ref = new Float32Array(block);
    for (var j = 0; j < block; j++) {
      var t = (b + j) / sr;
      mic[j] = 0.012 * Math.sin(2 * Math.PI * 200 * t);
    }
    var out = new Float32Array(block);
    proc.process(mic, ref, out);
    gains.push(proc.stats().gain);
    for (var j2 = 0; j2 < block; j2++) {
      assert.ok(Math.abs(out[j2]) <= VG.LIMIT + 0.001);
      assert.ok(isFinite(out[j2]));
    }
  }
  var maxG = Math.max.apply(null, gains);
  assert.ok(maxG <= VG.MAX_GAIN + 1e-6, "gain " + maxG);
  // After the ceiling is reached the value stays there. It does not keep multiplying.
  var tail = gains.slice(gains.length - 20);
  var lo = Math.min.apply(null, tail);
  var hi = Math.max.apply(null, tail);
  assert.ok(hi - lo < 0.08, "gain still walking: " + lo + ".." + hi);
});

test("a full-band mic is not low-passed: 3 kHz stays with the vowel", () => {
  var sr = 48000;
  var proc = VG.createProcessor(sr);
  var n = sr;
  var block = 480;
  var oLow = 0;
  var oHigh = 0;
  var counted = 0;
  for (var b = 0; b < n; b += block) {
    var mic = new Float32Array(block);
    var ref = new Float32Array(block);
    for (var j = 0; j < block; j++) {
      var t = (b + j) / sr;
      mic[j] = 0.08 * Math.sin(2 * Math.PI * 200 * t) + 0.04 * Math.sin(2 * Math.PI * 3000 * t);
    }
    var out = new Float32Array(block);
    proc.process(mic, ref, out);
    if (b < sr * 0.3) continue;
    for (var j2 = 0; j2 < block; j2++) {
      var t2 = (b + j2) / sr;
      oLow += out[j2] * Math.sin(2 * Math.PI * 200 * t2);
      oHigh += out[j2] * Math.sin(2 * Math.PI * 3000 * t2);
      counted++;
    }
  }
  var aLow = Math.abs(2 * oLow / counted);
  var aHigh = Math.abs(2 * oHigh / counted);
  // Input amplitudes are 0.08 and 0.04, so the high tone is half the low one.
  // A low-pass that ate consonants would drop this ratio toward zero.
  var ratio = aHigh / aLow;
  assert.ok(aLow > 0.01, "low tone missing " + aLow);
  assert.ok(ratio > 0.35, "3 kHz collapsed against 200 Hz: " + ratio);
});

test("a full-scale impulse cannot come out clipped past the limiter", () => {
  var proc = VG.createProcessor(16000);
  var mic = new Float32Array(320);
  var ref = new Float32Array(320);
  mic[10] = 8;
  mic[11] = -6;
  var out = new Float32Array(320);
  proc.process(mic, ref, out);
  for (var i = 0; i < out.length; i++) {
    assert.ok(Math.abs(out[i]) <= VG.LIMIT + 0.001, "sample " + i + " = " + out[i]);
    assert.ok(isFinite(out[i]));
  }
});
