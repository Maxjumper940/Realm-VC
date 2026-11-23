// Send-path guard for Realm VC.
//
// The platform auto-gain (getUserMedia autoGainControl) is an integrator with a
// very high ceiling. Recording mode turns the platform echo canceller off so
// Android plays the call as ordinary media that Realm Recorder can capture, and
// on a phone speaker the mic then hears that playback. The auto-gain treats the
// growing loop as speech that is still too quiet and keeps raising gain until
// the words clip into a scream. Headphones only hide it because the mic no
// longer hears the speaker.
//
// This guard replaces that integrator:
//   * a leaky NLMS canceller subtracts playback (the reference) from the mic
//   * a leveler may boost a quiet mic, but only up to a hard ceiling, and it
//     backs off when the level is already high
//   * a soft limiter stops a sample from reaching full scale
// None of these steps multiply the gain by itself.

(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.VoiceGuard = api;
})(typeof self !== "undefined" ? self : this, function () {
  var MAX_GAIN = 2.5;       // +8 dB. High enough for a quiet mic, low enough that a phone speaker cannot howl away.
  var MIN_GAIN = 0.25;
  var TARGET_RMS = 0.07;
  var NOISE_RMS = 0.01;     // below this, do not boost (the failure mode where silence is amplified into a roar)
  var LIMIT = 0.92;

  function createProcessor(sampleRate) {
    var sr = sampleRate > 0 ? sampleRate : 48000;
    var gain = 1;
    var ringLen = Math.ceil(sr * 0.28);
    var refRing = new Float32Array(ringLen);
    var micRing = new Float32Array(ringLen);
    var rpos = 0;
    var taps = 24;
    var w = new Float32Array(taps);
    var minLag = Math.max(1, Math.round(sr * 0.006));
    var maxLag = Math.min(ringLen - taps - 2, Math.round(sr * 0.14));
    var lag = Math.round(sr * 0.02);
    if (lag < minLag) lag = minLag;
    if (lag > maxLag) lag = maxLag;
    var sinceCorr = 0;
    var corrEvery = Math.max(1, Math.round(sr * 0.06));
    var envMic = 0;
    var envRef = 0;
    var envCoef = Math.exp(-1 / (sr * 0.02));
    var hpMicX = 0, hpMicY = 0, hpRefX = 0, hpRefY = 0;
    var confident = 0; // 0..1, how sure we are the filter matches the speaker path
    var lastCorr = 0;

    function at(ring, delay) {
      var i = rpos - delay;
      i %= ringLen;
      if (i < 0) i += ringLen;
      return ring[i];
    }

    function highpass(x, which) {
      // One-pole highpass, ~50 Hz. Removes DC that would otherwise look like echo.
      var y;
      if (which === 0) {
        y = x - hpMicX + 0.995 * hpMicY;
        hpMicX = x;
        hpMicY = y;
      } else {
        y = x - hpRefX + 0.995 * hpRefY;
        hpRefX = x;
        hpRefY = y;
      }
      return y;
    }

    function corrAt(L, win, stride) {
      var c = 0, em = 0, er = 0;
      for (var k = 0; k < win; k += stride) {
        var m = at(micRing, k);
        var x = at(refRing, L + k);
        c += m * x;
        em += m * m;
        er += x * x;
      }
      if (er < 1e-6 || em < 1e-6) return -1;
      return c / Math.sqrt(em * er);
    }

    function updateLag() {
      var win = Math.round(sr * 0.03);
      var step = Math.max(1, Math.round(sr * 0.002));
      var stride = Math.max(1, Math.round(sr * 0.00025));
      var peak = -1;
      for (var L = minLag; L <= maxLag; L += step) {
        var corr = corrAt(L, win, stride);
        if (corr > peak) peak = corr;
      }
      lastCorr = peak < 0 ? 0 : peak;
      // A vowel correlates with itself at every pitch period, so several lags
      // look almost equally good. The speaker-to-mic path is the earliest one.
      if (peak > 0.72) {
        var earliest = -1;
        for (var L2 = minLag; L2 <= maxLag; L2 += step) {
          if (corrAt(L2, win, stride) > peak - 0.08) { earliest = L2; break; }
        }
        if (earliest > 0) {
          if (Math.abs(earliest - lag) > Math.round(sr * 0.008)) w.fill(0);
          lag = earliest;
          confident = Math.min(1, confident + 0.4);
        }
      } else if (peak < 0.45) {
        confident *= 0.45;
      }
    }

    function process(mic, ref, out) {
      var n = mic.length;
      if (!n) return;
      var sumSq = 0;
      var adaptLeak = Math.exp(-1 / (sr * 8));
      var idleLeak = Math.exp(-1 / (sr * 2));
      for (var i = 0; i < n; i++) {
        var m = highpass(mic[i] || 0, 0);
        var r = highpass(ref ? (ref[i] || 0) : 0, 1);
        if (!isFinite(m)) m = 0;
        if (!isFinite(r)) r = 0;
        refRing[rpos] = r;
        micRing[rpos] = m;

        sinceCorr++;
        if (sinceCorr >= corrEvery) {
          sinceCorr = 0;
          updateLag();
        }

        var y = 0;
        var pwr = 0;
        for (var t = 0; t < taps; t++) {
          var x = at(refRing, lag + t);
          y += w[t] * x;
          pwr += x * x;
        }
        envMic = envCoef * envMic + (1 - envCoef) * m * m;
        envRef = envCoef * envRef + (1 - envCoef) * r * r;

        // Subtract playback only after the delay estimate has locked.
        // Before that, y is a guess and would carve a hole in her voice.
        var err = m - y;
        var e = confident > 0.5 ? err : m;

        // Adapt only on a clean echo (mic matches playback). While she is talking
        // over the far end, lastCorr drops and the filter stays where it was.
        var farOnly = lastCorr > 0.72 && envRef > 2e-5 && confident > 0.35;
        if (farOnly && pwr > 1e-6) {
          var step = (0.25 * err) / (pwr + 1e-4);
          if (step > 0.5) step = 0.5;
          else if (step < -0.5) step = -0.5;
          var wsum = 0;
          for (var t2 = 0; t2 < taps; t2++) {
            var x2 = at(refRing, lag + t2);
            var c = w[t2] * adaptLeak + step * x2;
            if (c > 1.5) c = 1.5;
            else if (c < -1.5) c = -1.5;
            w[t2] = c;
            wsum += c * c;
          }
          if (wsum > 2.5) {
            var s = Math.sqrt(2.5 / wsum);
            for (var t3 = 0; t3 < taps; t3++) w[t3] *= s;
          }
        } else if (envRef < 1e-6) {
          for (var t4 = 0; t4 < taps; t4++) w[t4] *= idleLeak;
          confident *= 0.999;
        }

        // Residual echo that is still larger than the leftover voice gets turned down,
        // and only when the filter has locked onto the speaker path.
        if (confident > 0.6 && envRef > envMic && Math.abs(y) > Math.abs(e) + 0.02) {
          e *= 0.4;
        }

        if (!isFinite(e)) {
          e = 0;
          w.fill(0);
          confident = 0;
        }
        out[i] = e;
        sumSq += e * e;
        rpos++;
        if (rpos === ringLen) rpos = 0;
      }

      var rms = Math.sqrt(sumSq / n);
      var desired;
      if (rms < NOISE_RMS) {
        // Do not chase silence. Drift back toward unity so a quiet room is not amplified.
        desired = 1;
      } else {
        desired = TARGET_RMS / rms;
      }
      if (desired > MAX_GAIN) desired = MAX_GAIN;
      if (desired < MIN_GAIN) desired = MIN_GAIN;
      // While playback is in the reference, do not boost. Boosting a leftover
      // echo is how the platform auto-gain ran away. A quiet mic is still
      // lifted when nobody is coming out of the speaker.
      if (confident > 0.5 && envRef > 2e-5 && desired > 1) desired = 1;
      var dt = n / sr;
      if (desired > gain) {
        // Slow boost: a feedback loop must not be able to outrun the canceller.
        gain = Math.min(desired, gain + 0.45 * dt);
      } else {
        // Fast cut when the mic is already loud (echo showed up, or a shout).
        var cut = 1 - Math.exp(-dt / 0.04);
        gain += (desired - gain) * cut;
      }
      if (gain > MAX_GAIN) gain = MAX_GAIN;
      if (gain < MIN_GAIN) gain = MIN_GAIN;
      if (!isFinite(gain)) gain = 1;

      for (var j = 0; j < n; j++) out[j] = softLimit(out[j] * gain);
    }

    function stats() {
      var energy = 0;
      for (var t = 0; t < taps; t++) energy += w[t] * w[t];
      return { gain: gain, lag: lag, confident: confident, tapEnergy: energy, envMic: envMic, envRef: envRef };
    }

    return { process: process, stats: stats };
  }

  function softLimit(x) {
    if (!isFinite(x)) return 0;
    var a = x < 0 ? -x : x;
    if (a <= 0.7) return x;
    var sign = x < 0 ? -1 : 1;
    var over = (a - 0.7) / (1 - 0.7);
    var y = 0.7 + (LIMIT - 0.7) * Math.tanh(over);
    return sign * y;
  }

  function processorSource() {
    // createProcessor closes over these. The worklet gets its own copy of the
    // function text, so the numbers have to be declared in that scope too.
    return "var MAX_GAIN = " + MAX_GAIN + ";\n" +
      "var MIN_GAIN = " + MIN_GAIN + ";\n" +
      "var TARGET_RMS = " + TARGET_RMS + ";\n" +
      "var NOISE_RMS = " + NOISE_RMS + ";\n" +
      "var LIMIT = " + LIMIT + ";\n" +
      "var createProcessor = " + createProcessor.toString() + ";\n" +
      "var softLimit = " + softLimit.toString() + ";\n";
  }

  function workletSource() {
    return processorSource() + [
      "class RealmVcGuardProcessor extends AudioWorkletProcessor {",
      "  constructor() { super(); this.g = createProcessor(sampleRate); }",
      "  process(inputs, outputs) {",
      "    var input = inputs[0];",
      "    var output = outputs[0];",
      "    if (!input || !input[0] || !output || !output[0]) return true;",
      "    var mic = input[0];",
      "    var ref = input[1];",
      "    var n = mic.length;",
      "    if (!ref || ref.length !== n) {",
      "      ref = new Float32Array(n);",
      "    }",
      "    try { this.g.process(mic, ref, output[0]); }",
      "    catch (err) {",
      "      for (var i = 0; i < n; i++) output[0][i] = softLimit(mic[i] || 0);",
      "    }",
      "    for (var c = 1; c < output.length; c++) if (output[c]) output[c].set(output[0]);",
      "    return true;",
      "  }",
      "}",
      "registerProcessor('realmvc-guard', RealmVcGuardProcessor);"
    ].join("\n");
  }

  // Builds the graph that WebRTC sends. `rawStream` is the microphone.
  // Remote playback streams are tapped as the echo reference and are not played
  // again here — the call page already plays them. Playing the mic out of the
  // speaker would be a hard feedback loop and would still not put the mic into
  // Realm Recorder (the recorder skips the mic while this app holds it).
  function attach(rawStream) {
    var Ctx = typeof AudioContext !== "undefined" ? AudioContext : null;
    if (!Ctx || !rawStream) return Promise.resolve(passthrough(rawStream));
    var ctx = new Ctx({ latencyHint: "interactive" });
    var resume = function () { if (ctx.state !== "running") ctx.resume().catch(function () {}); };
    var remotes = new Map();
    var closed = false;
    var node = null;
    var processor = null;
    var source = null;
    var refGain = null;
    var dest = null;
    var timer = 0;

    function running() { return !closed && ctx.state === "running" && !!(node || processor); }

    function finish(stream) {
      timer = setInterval(resume, 1500);
      document.addEventListener("visibilitychange", resume);
      return {
        stream: stream,
        isRunning: running,
        addRemote: function (id, mediaStream) {
          if (closed || !refGain) return;
          this.removeRemote(id);
          try {
            var src = ctx.createMediaStreamSource(mediaStream);
            src.connect(refGain);
            remotes.set(id, src);
          } catch (e) {}
        },
        removeRemote: function (id) {
          var src = remotes.get(id);
          if (!src) return;
          try { src.disconnect(); } catch (e) {}
          remotes.delete(id);
        },
        close: function () {
          if (closed) return;
          closed = true;
          clearInterval(timer);
          document.removeEventListener("visibilitychange", resume);
          remotes.forEach(function (src) { try { src.disconnect(); } catch (e) {} });
          remotes.clear();
          try { if (source) source.disconnect(); } catch (e) {}
          try { if (node) node.disconnect(); } catch (e) {}
          try { if (processor) processor.disconnect(); } catch (e) {}
          try { ctx.close(); } catch (e) {}
        }
      };
    }

    function wireMerger(inputNode) {
      refGain = ctx.createGain();
      refGain.gain.value = 1;
      var merger = ctx.createChannelMerger(2);
      source.connect(merger, 0, 0);
      refGain.connect(merger, 0, 1);
      merger.connect(inputNode);
      dest = ctx.createMediaStreamDestination();
      inputNode.connect(dest);
      return dest.stream;
    }

    function useScriptProcessor() {
      processor = ctx.createScriptProcessor(2048, 2, 1);
      var guard = createProcessor(ctx.sampleRate);
      processor.onaudioprocess = function (ev) {
        var micBuf = ev.inputBuffer.getChannelData(0);
        var refBuf = ev.inputBuffer.numberOfChannels > 1 ? ev.inputBuffer.getChannelData(1) : null;
        if (!refBuf || refBuf.length !== micBuf.length) refBuf = new Float32Array(micBuf.length);
        var outBuf = ev.outputBuffer.getChannelData(0);
        try { guard.process(micBuf, refBuf, outBuf); }
        catch (err) {
          for (var i = 0; i < micBuf.length; i++) outBuf[i] = softLimit(micBuf[i] || 0);
        }
      };
      return finish(wireMerger(processor));
    }

    source = ctx.createMediaStreamSource(rawStream);
    var ready = ctx.resume().catch(function () {});
    if (ctx.audioWorklet && typeof ctx.audioWorklet.addModule === "function") {
      var blob = new Blob([workletSource()], { type: "application/javascript" });
      var url = URL.createObjectURL(blob);
      return ready.then(function () {
        return ctx.audioWorklet.addModule(url);
      }).then(function () {
        URL.revokeObjectURL(url);
        node = new AudioWorkletNode(ctx, "realmvc-guard", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          channelCount: 2,
          channelCountMode: "explicit",
          channelInterpretation: "discrete"
        });
        return finish(wireMerger(node));
      }).catch(function () {
        try { URL.revokeObjectURL(url); } catch (e) {}
        return useScriptProcessor();
      });
    }
    return ready.then(function () { return useScriptProcessor(); });
  }

  function passthrough(rawStream) {
    return {
      stream: rawStream,
      isRunning: function () { return false; },
      addRemote: function () {},
      removeRemote: function () {},
      close: function () {}
    };
  }

  return {
    MAX_GAIN: MAX_GAIN,
    MIN_GAIN: MIN_GAIN,
    TARGET_RMS: TARGET_RMS,
    NOISE_RMS: NOISE_RMS,
    LIMIT: LIMIT,
    createProcessor: createProcessor,
    softLimit: softLimit,
    attach: attach,
    workletSource: workletSource
  };
});
