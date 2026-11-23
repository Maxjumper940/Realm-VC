// Capture and playback settings for a Realm VC call.
//
// Android WebView treats a getUserMedia request that asks for echo cancellation
// or noise suppression as a voice call. Two things follow, and both make the
// other people sound muffled:
//
//   * The mic is opened on the voice-communication input and run through the
//     platform noise suppressor. On current WebView builds that processing is
//     still done at 16 kHz, so everything above 8 kHz is gone before Opus sees
//     it, and the suppressor dulls the consonants that sit between 2 and 4 kHz.
//   * Playback is opened as USAGE_VOICE_COMMUNICATION. Android routes that to
//     the earpiece, runs the voice downlink DSP, and refuses to let a
//     third-party screen recorder capture it. The recorder then falls back to
//     the microphone and records the earpiece across the phone body, which is
//     the recording that has almost no energy above 1 kHz.
//
// Leaving the platform effects off (exact: false, not merely a preferred
// false) keeps the stream in media mode: 48 kHz capture, USAGE_MEDIA playback
// on the speaker or headphones. Opus is pinned to full-band 64 kbps so a peer
// that advertises a voice-device playback rate cannot pull the encoder back
// down to narrowband. Echo on the speaker is handled by VoiceGuard, not by
// the platform canceller.

(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.RealmCallAudio = api;
})(typeof self !== "undefined" ? self : this, function () {
  var OPUS_BITRATE = "64000";

  function micConstraints() {
    return {
      echoCancellation: { exact: false },
      noiseSuppression: { exact: false },
      autoGainControl: { exact: false },
      googEchoCancellation: { exact: false },
      googNoiseSuppression: { exact: false },
      googAutoGainControl: { exact: false },
      googHighpassFilter: { exact: false },
      channelCount: { ideal: 1 },
      sampleRate: { ideal: 48000 }
    };
  }

  function fallbackConstraints() {
    return {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      sampleRate: 48000,
      channelCount: 1
    };
  }

  function mergeOpusFmtp(body) {
    var map = {};
    var order = [];
    String(body || "").split(";").forEach(function (part) {
      if (!part) return;
      var eq = part.indexOf("=");
      var key = eq < 0 ? part : part.slice(0, eq);
      var val = eq < 0 ? "" : part.slice(eq + 1);
      if (!Object.prototype.hasOwnProperty.call(map, key)) order.push(key);
      map[key] = val;
    });
    function set(key, val) {
      if (!Object.prototype.hasOwnProperty.call(map, key)) order.push(key);
      map[key] = val;
    }
    set("maxplaybackrate", "48000");
    set("sprop-maxcapturerate", "48000");
    set("maxaveragebitrate", OPUS_BITRATE);
    set("stereo", "0");
    set("sprop-stereo", "0");
    set("useinbandfec", "1");
    if (!map.minptime) set("minptime", "10");
    return order.map(function (key) {
      return map[key] === "" ? key : key + "=" + map[key];
    }).join(";");
  }

  function tuneSdp(sdp) {
    if (!sdp || sdp.indexOf("opus/48000") < 0) return sdp;
    var nl = sdp.indexOf("\r\n") >= 0 ? "\r\n" : "\n";
    var lines = sdp.split(/\r?\n/);
    var opus = {};
    lines.forEach(function (line) {
      var rtp = line.match(/^a=rtpmap:(\d+)\s+opus\/48000/i);
      if (rtp) opus[rtp[1]] = true;
    });
    var have = {};
    var out = lines.map(function (line) {
      var fmtp = line.match(/^a=fmtp:(\d+)\s+(.*)$/);
      if (fmtp && opus[fmtp[1]]) {
        have[fmtp[1]] = true;
        return "a=fmtp:" + fmtp[1] + " " + mergeOpusFmtp(fmtp[2]);
      }
      return line;
    });
    var inserted = [];
    out.forEach(function (line, idx) {
      var rtp = line.match(/^a=rtpmap:(\d+)\s+opus\/48000/i);
      if (rtp && !have[rtp[1]]) {
        have[rtp[1]] = true;
        inserted.push({ idx: idx, line: "a=fmtp:" + rtp[1] + " " + mergeOpusFmtp("") });
      }
    });
    for (var i = inserted.length - 1; i >= 0; i--) {
      out.splice(inserted[i].idx + 1, 0, inserted[i].line);
    }
    return out.join(nl);
  }

  function tuneSenders(pc) {
    if (!pc || !pc.getSenders) return;
    var senders;
    try { senders = pc.getSenders(); } catch (e) { return; }
    senders.forEach(function (sender) {
      if (!sender.track || sender.track.kind !== "audio" || !sender.getParameters) return;
      try {
        var params = sender.getParameters();
        if (!params.encodings || !params.encodings.length) params.encodings = [{}];
        params.encodings[0].maxBitrate = parseInt(OPUS_BITRATE, 10);
        sender.setParameters(params);
      } catch (err) {}
    });
  }

  function retune(desc) {
    if (!desc || !desc.sdp) return desc;
    var sdp = tuneSdp(desc.sdp);
    if (sdp === desc.sdp) return desc;
    return { type: desc.type, sdp: sdp };
  }

  // PeerJS builds its RTCPeerConnection internally. Patching the constructor
  // is what makes every offer and answer carry the full-band Opus line.
  function install(scope) {
    var Orig = scope && scope.RTCPeerConnection;
    if (!Orig || Orig.__realmPatched) return;
    function patch(pc) {
      ["createOffer", "createAnswer"].forEach(function (name) {
        var orig = pc[name];
        if (typeof orig !== "function") return;
        pc[name] = function () {
          var args = arguments;
          return Promise.resolve(orig.apply(pc, args)).then(function (desc) {
            return retune(desc);
          });
        };
      });
      var setLocal = pc.setLocalDescription && pc.setLocalDescription.bind(pc);
      if (setLocal) {
        pc.setLocalDescription = function (desc) {
          return setLocal(retune(desc));
        };
      }
      var setRemote = pc.setRemoteDescription && pc.setRemoteDescription.bind(pc);
      if (setRemote) {
        pc.setRemoteDescription = function (desc) {
          return setRemote(retune(desc));
        };
      }
      if (pc.addEventListener) {
        pc.addEventListener("negotiationneeded", function () { tuneSenders(pc); });
        pc.addEventListener("connectionstatechange", function () { tuneSenders(pc); });
      }
      return pc;
    }
    function Patched(config) {
      var pc = new Orig(config);
      return patch(pc);
    }
    Patched.prototype = Orig.prototype;
    Patched.__realmPatched = true;
    scope.RTCPeerConnection = Patched;
  }

  return {
    OPUS_BITRATE: OPUS_BITRATE,
    micConstraints: micConstraints,
    fallbackConstraints: fallbackConstraints,
    tuneSdp: tuneSdp,
    install: install
  };
});
