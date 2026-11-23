(function () {
  const MAX_PEOPLE = 10;
  const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const PEER_PREFIX = "rvc-";
  const ICE_CONFIG = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun.relay.metered.ca:80" },
      // Relay servers so phones on mobile data / different networks can still hear each other.
      { urls: ["turn:openrelay.metered.ca:80", "turn:openrelay.metered.ca:443", "turn:openrelay.metered.ca:443?transport=tcp", "turns:openrelay.metered.ca:443"],
        username: "openrelayproject", credential: "openrelayproject" },
      { urls: ["turn:freestun.net:3478", "turn:freestun.net:3478?transport=tcp", "turns:freestun.net:5349"],
        username: "free", credential: "free" }
    ],
    iceCandidatePoolSize: 2
  };
  const PEER_OPTIONS = {
    host: "0.peerjs.com",
    port: 443,
    path: "/",
    secure: true,
    debug: 1,
    config: ICE_CONFIG
  };

  const nameScreen = document.getElementById("nameScreen");
  const nameForm = document.getElementById("nameForm");
  const nameInput = document.getElementById("nameInput");
  const nameError = document.getElementById("nameError");
  const helloName = document.getElementById("helloName");
  const helloAvatar = document.getElementById("helloAvatar");
  const btnEditName = document.getElementById("btnEditName");
  let myName = "";
  try { myName = (localStorage.getItem("realmvcName") || "").trim(); } catch (e) {}
  function cleanName(n) { return String(n || "").replace(/\s+/g, " ").trim().slice(0, 20); }
  const home = document.getElementById("home");
  const room = document.getElementById("room");
  const homeError = document.getElementById("homeError");
  const joinInput = document.getElementById("joinCode");
  const btnCreate = document.getElementById("btnCreate");
  const btnJoin = document.getElementById("btnJoin");
  const btnMute = document.getElementById("btnMute");
  const btnLeave = document.getElementById("btnLeave");
  const btnCopy = document.getElementById("btnCopy");
  const btnShare = document.getElementById("btnShare");
  const roomCodeDisplay = document.getElementById("roomCodeDisplay");
  const roomStatus = document.getElementById("roomStatus");
  const roomRole = document.getElementById("roomRole");
  const peopleList = document.getElementById("people");

  let localStream = null;
  let micStream = null;
  let voiceGuard = null;
  let peer = null;
  let roomCode = "";
  let isHost = false;
  let muted = false;
  let leaving = false;
  const remotes = new Map(); // peerId -> { conn, call, el }

  function setHomeError(msg) {
    if (!msg) {
      homeError.hidden = true;
      homeError.textContent = "";
      return;
    }
    homeError.hidden = false;
    homeError.textContent = msg;
  }

  function setBusy(busy) {
    btnCreate.disabled = busy;
    btnJoin.disabled = busy;
    joinInput.disabled = busy;
  }

  function randomCode() {
    let out = "";
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    for (let i = 0; i < 6; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    return out;
  }

  function normalizeCode(raw) {
    return String(raw || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 6);
  }

  function hostIdFor(code) {
    return PEER_PREFIX + code;
  }

  function native() {
    return typeof RealmVC !== "undefined" ? RealmVC : null;
  }

  function recordableAudio() {
    try { return localStorage.getItem("realmvcRecordable") === "1"; } catch (e) { return false; }
  }

  function micConstraints() {
    // autoGainControl must stay off. It is an adaptive gain with a very high
    // ceiling. Recording mode also turns the platform echo canceller off so the
    // call plays as normal media (Realm Recorder can capture that; it cannot
    // capture voice-call audio). On the phone speaker the mic then hears the
    // call, and the auto-gain keeps raising the level while you talk until the
    // words clip. The same stack happens with the canceller requested, because
    // this WebView plays remote audio from an <audio> tag that often is not the
    // canceller's reference. VoiceGuard caps the level, subtracts that playback,
    // and limits peaks. It does not play the mic back out the speaker.
    var recordable = recordableAudio();
    return {
      echoCancellation: !recordable,
      noiseSuppression: true,
      autoGainControl: false
    };
  }

  async function getMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("This Android WebView cannot capture audio. Update Android System WebView and try again.");
    }
    const raw = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(), video: false });
    const track = raw.getAudioTracks()[0];
    if (track && track.applyConstraints) {
      try { await track.applyConstraints(micConstraints()); } catch (e) {}
    }
    micStream = raw;
    if (voiceGuard) {
      try { voiceGuard.close(); } catch (e) {}
      voiceGuard = null;
    }
    if (typeof VoiceGuard !== "undefined" && VoiceGuard.attach) {
      try { voiceGuard = await VoiceGuard.attach(raw); } catch (e) { voiceGuard = null; }
    }
    return (voiceGuard && voiceGuard.stream) || raw;
  }

  function sendTrack() {
    const guarded = voiceGuard && voiceGuard.isRunning() && voiceGuard.stream && voiceGuard.stream.getAudioTracks()[0];
    if (guarded) return guarded;
    return micStream && micStream.getAudioTracks()[0];
  }

  function refreshSendTrack() {
    const track = sendTrack();
    if (!track || !peer) return;
    remotes.forEach((info) => {
      const pc = info.call && info.call.peerConnection;
      if (!pc || !pc.getSenders) return;
      pc.getSenders().forEach((sender) => {
        if (sender.track && sender.track.kind === "audio" && sender.track !== track) {
          try { sender.replaceTrack(track); } catch (e) {}
        }
      });
    });
  }

  function showRoom() {
    home.hidden = true;
    room.hidden = false;
    roomCodeDisplay.textContent = roomCode;
    roomRole.textContent = isHost ? "Your room" : "Joined room";
    renderPeople();
  }

  function showNameScreen() {
    room.hidden = true;
    home.hidden = true;
    nameScreen.hidden = false;
    nameInput.value = myName;
    setTimeout(() => nameInput.focus(), 50);
  }

  function showHome() {
    if (!myName) { showNameScreen(); return; }
    room.hidden = true;
    nameScreen.hidden = true;
    home.hidden = false;
    helloName.textContent = myName;
    helloAvatar.textContent = myName.charAt(0).toUpperCase();
    if (window.realmvcUiRefresh) window.realmvcUiRefresh();
    roomCodeDisplay.textContent = "——————";
    roomStatus.textContent = "";
  }

  function renderPeople() {
    const items = [];
    items.push({
      name: "You",
      meta: muted ? "Muted" : "Microphone on",
      live: !muted
    });
    remotes.forEach((info, id) => {
      items.push({
        name: info.name || shortName(id),
        meta: info.stream ? "Connected" : "Connecting…",
        live: !!info.stream
      });
    });
    peopleList.innerHTML = items.map((p) => (
      `<li><span class="who"><span class="dot${p.live ? "" : " off"}"></span><span class="rv-name">${escapeHtml(p.name)}</span></span><span class="meta">${escapeHtml(p.meta)}</span></li>`
    )).join("");
    const total = 1 + remotes.size;
    if (!leaving) {
      if (total >= MAX_PEOPLE) {
        roomStatus.textContent = "Room is full (" + MAX_PEOPLE + " of " + MAX_PEOPLE + ").";
      } else if (isHost) {
        roomStatus.textContent = total === 1
          ? "Waiting for others. Share the code to invite up to " + (MAX_PEOPLE - 1) + " people."
          : `${total} of ${MAX_PEOPLE} in the room.`;
      } else {
        roomStatus.textContent = `${total} of ${MAX_PEOPLE} in the room.`;
      }
    }
  }

  function shortName(id) {
    const trimmed = String(id || "").replace(PEER_PREFIX, "");
    return "Guest " + trimmed.slice(-4).toUpperCase();
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function ensureRemote(id) {
    if (!remotes.has(id)) remotes.set(id, { conn: null, call: null, stream: null, since: Date.now() });
    return remotes.get(id);
  }

  function attachStream(id, stream) {
    const info = ensureRemote(id);
    info.stream = stream;
    let audio = document.getElementById("audio-" + id);
    if (!audio) {
      audio = document.createElement("audio");
      audio.id = "audio-" + id;
      audio.autoplay = true;
      audio.setAttribute("playsinline", "true");
      audio.style.display = "none";
      document.body.appendChild(audio);
    }
    audio.srcObject = stream;
    const play = audio.play();
    if (play && play.catch) play.catch(() => {});
    if (voiceGuard) voiceGuard.addRemote(id, stream);
    renderPeople();
  }

  function dropRemote(id, reason) {
    const info = remotes.get(id);
    if (!info) return;
    try { if (info.call) info.call.close(); } catch (e) {}
    try { if (info.conn) info.conn.close(); } catch (e) {}
    const audio = document.getElementById("audio-" + id);
    if (audio) {
      audio.srcObject = null;
      audio.remove();
    }
    if (voiceGuard) voiceGuard.removeRemote(id);
    remotes.delete(id);
    renderPeople();
    if (reason) roomStatus.textContent = reason;
  }

  function sendTo(conn, payload) {
    if (conn && conn.open) conn.send(payload);
  }

  function broadcast(payload, exceptId) {
    remotes.forEach((info, id) => {
      if (id !== exceptId) sendTo(info.conn, payload);
    });
  }

  function handleMessage(fromId, data) {
    if (!data || typeof data !== "object") return;
    if (data.type === "hello") {
      const info = ensureRemote(fromId);
      info.name = cleanName(data.name) || info.name;
      renderPeople();
    } else if (data.type === "welcome") {
      const others = Array.isArray(data.peers) ? data.peers : [];
      others.forEach((otherId) => {
        if (otherId && otherId !== peer.id) connectToPeer(otherId, true);
      });
      renderPeople();
    } else if (data.type === "peer-joined") {
      // The new peer will call us for media; just reserve a slot in the list.
      if (data.id && data.id !== peer.id) ensureRemote(data.id);
      renderPeople();
    } else if (data.type === "peer-left") {
      dropRemote(data.id, "Someone left the room.");
    } else if (data.type === "room-full") {
      roomStatus.textContent = "That room is full (" + MAX_PEOPLE + " people).";
      leaveRoom("That room is full (" + MAX_PEOPLE + " people).");
    } else if (data.type === "host-left") {
      roomStatus.textContent = "The host left. You can keep talking or leave.";
    }
  }

  function hookDataConnection(conn, expectIncoming) {
    const id = conn.peer;
    const info = ensureRemote(id);
    info.conn = conn;
    conn.on("open", () => { conn._everOpen = true; sendTo(conn, { type: "hello", name: myName }); });
    if (conn.metadata && conn.metadata.name) info.name = cleanName(conn.metadata.name);
    conn.on("data", (data) => handleMessage(id, data));
    conn.on("close", () => dropRemote(id, "Someone disconnected."));
    conn.on("error", () => dropRemote(id, "A connection dropped."));
    if (!expectIncoming) {
      // Host or initiator may still be opening.
    }
    renderPeople();
  }

  function hookMediaCall(call) {
    const id = call.peer;
    const info = ensureRemote(id);
    info.call = call;
    call.on("stream", (stream) => attachStream(id, stream));
    call.on("close", () => dropRemote(id, "Someone disconnected."));
    call.on("error", () => dropRemote(id, "A voice link dropped."));
  }

  function connectToPeer(otherId, alsoCall) {
    if (!peer || otherId === peer.id || remotes.has(otherId) && remotes.get(otherId).conn) {
      if (alsoCall && remotes.has(otherId) && !remotes.get(otherId).call && localStream) {
        const call = peer.call(otherId, localStream);
        hookMediaCall(call);
      }
      return;
    }
    const conn = peer.connect(otherId, { reliable: true, metadata: { name: myName } });
    hookDataConnection(conn, false);
    conn.on("open", () => {});
    if (alsoCall && localStream) {
      const call = peer.call(otherId, localStream);
      hookMediaCall(call);
    }
  }

  function bindPeerEvents(createdAsHost) {
    peer.on("connection", (conn) => {
      if (createdAsHost && remotes.size >= MAX_PEOPLE - 1) {
        conn.on("open", () => {
          sendTo(conn, { type: "room-full" });
          setTimeout(() => conn.close(), 400);
        });
        return;
      }
      hookDataConnection(conn, true);
      conn.on("open", () => {
        if (createdAsHost) {
          const others = [];
          remotes.forEach((_, id) => {
            if (id !== conn.peer) others.push(id);
          });
          sendTo(conn, { type: "welcome", peers: others });
          broadcast({ type: "peer-joined", id: conn.peer }, conn.peer);
        }
      });
    });

    peer.on("call", (call) => {
      if (localStream) call.answer(localStream);
      hookMediaCall(call);
    });

    peer.on("disconnected", () => {
      if (!leaving && peer && !peer.destroyed) {
        roomStatus.textContent = "Reconnecting…";
        try { peer.reconnect(); } catch (e) {}
      }
    });
  }

  function createPeer(id) {
    return new Promise((resolve, reject) => {
      const opts = Object.assign({}, PEER_OPTIONS);
      const instance = id ? new Peer(id, opts) : new Peer(opts);
      const timer = setTimeout(() => {
        try { instance.destroy(); } catch (e) {}
        reject(new Error("Could not reach the call network. Check your internet connection and try again."));
      }, 12000);
      instance.on("open", () => {
        clearTimeout(timer);
        resolve(instance);
      });
      instance.on("error", (err) => {
        clearTimeout(timer);
        const type = err && err.type;
        if (type === "unavailable-id") {
          reject(Object.assign(new Error("id-taken"), { type }));
        } else if (type === "peer-unavailable") {
          reject(new Error("No room was found with that code."));
        } else if (type === "network" || type === "server-error" || type === "socket-error") {
          reject(new Error("Could not reach the call network. Check your internet connection and try again."));
        } else {
          reject(new Error((err && err.message) || "A call error occurred."));
        }
      });
    });
  }

  async function startHost(preferredCode) {
    setHomeError("");
    setBusy(true);
    try {
      localStream = await getMic();
      let attempts = 0;
      let code = (typeof preferredCode === "string" && preferredCode.length === 6) ? preferredCode : randomCode();
      while (attempts < 6) {
        try {
          peer = await createPeer(hostIdFor(code));
          break;
        } catch (err) {
          if (err && err.type === "unavailable-id") {
            if (preferredCode) throw new Error("That room code is still in use.");
            code = randomCode();
            attempts += 1;
            continue;
          }
          throw err;
        }
      }
      if (!peer) throw new Error("Could not create a room. Please try again.");
      isHost = true;
      roomCode = code;
      leaving = false;
      bindPeerEvents(true);
      showRoom();
      const bridge = native();
      if (bridge) { if (bridge.onCallStartedRole) bridge.onCallStartedRole(roomCode, true); else bridge.onCallStarted(roomCode); }
    } catch (err) {
      cleanupMedia();
      setHomeError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  async function startJoin(rawCode) {
    const code = normalizeCode(rawCode);
    if (code.length !== 6) {
      setHomeError("Enter the 6-character room code.");
      return;
    }
    setHomeError("");
    setBusy(true);
    try {
      localStream = await getMic();
      peer = await createPeer(null);
      isHost = false;
      roomCode = code;
      leaving = false;
      bindPeerEvents(false);
      const dest = hostIdFor(code);
      const conn = peer.connect(dest, { reliable: true, metadata: { name: myName } });
      hookDataConnection(conn, false);
      const opened = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("No room was found with that code, or the host is offline.")), 25000);
        conn.on("open", () => { clearTimeout(timer); resolve(true); });
        conn.on("error", () => {
          clearTimeout(timer);
          reject(new Error("No room was found with that code, or the host is offline."));
        });
        peer.on("error", (err) => {
          if (err && err.type === "peer-unavailable") {
            clearTimeout(timer);
            reject(new Error("No room was found with that code."));
          }
        });
      });
      if (!opened) throw new Error("Could not join that room.");
      const call = peer.call(dest, localStream);
      hookMediaCall(call);
      showRoom();
      const bridge = native();
      if (bridge) { if (bridge.onCallStartedRole) bridge.onCallStartedRole(roomCode, false); else bridge.onCallStarted(roomCode); }
    } catch (err) {
      cleanupMedia();
      setHomeError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  function cleanupMedia() {
    remotes.forEach((_, id) => dropRemote(id));
    remotes.clear();
    if (voiceGuard) {
      try { voiceGuard.close(); } catch (e) {}
      voiceGuard = null;
    }
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
    }
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    if (peer) {
      try { peer.destroy(); } catch (e) {}
      peer = null;
    }
    muted = false;
    btnMute.setAttribute("aria-pressed", "false");
    btnMute.textContent = "Mute";
  }

  function leaveRoom(message) {
    leaving = true;
    broadcast({ type: isHost ? "host-left" : "peer-left", id: peer ? peer.id : undefined });
    cleanupMedia();
    const bridge = native();
    if (bridge) bridge.onCallEnded();
    showHome();
    if (message) setHomeError(message);
    leaving = false;
  }

  nameForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const n = cleanName(nameInput.value);
    if (n.length < 2) { nameError.textContent = "Enter your name (at least 2 letters)."; nameError.hidden = false; return; }
    nameError.hidden = true;
    myName = n;
    try { localStorage.setItem("realmvcName", n); } catch (err) {}
    showHome();
  });
  btnEditName.addEventListener("click", showNameScreen);
  showHome();

  btnCreate.addEventListener("click", () => startHost());
  // Called by the app after Android restarted the call page in the background.
  window.realmvcRejoin = async (code, wasHost) => {
    if (localStream || peer) return;
    for (let i = 0; i < 4 && !localStream; i++) {
      if (wasHost) await startHost(code); else await startJoin(code);
      if (localStream) break;
      if (wasHost) { await startJoin(code); if (localStream) break; }
      await new Promise((r) => setTimeout(r, 3000));
    }
  };
  btnJoin.addEventListener("click", () => startJoin(joinInput.value));
  joinInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") startJoin(joinInput.value);
  });
  joinInput.addEventListener("input", () => {
    const caret = joinInput.selectionStart;
    const normalized = normalizeCode(joinInput.value);
    if (joinInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "") !== normalized) {
      joinInput.value = normalized;
      try { joinInput.setSelectionRange(caret, caret); } catch (e) {}
    }
  });

  btnMute.addEventListener("click", () => {
    if (!localStream && !micStream) return;
    muted = !muted;
    [micStream, localStream, voiceGuard && voiceGuard.stream].forEach((s) => {
      if (s) s.getAudioTracks().forEach((t) => { t.enabled = !muted; });
    });
    btnMute.setAttribute("aria-pressed", muted ? "true" : "false");
    btnMute.textContent = muted ? "Unmute" : "Mute";
    renderPeople();
    const b = native();
    if (b && b.onMuteChanged) b.onMuteChanged(muted);
  });
  window.realmvcToggleMute = () => btnMute.click();
  window.realmvcHangup = () => { if (localStream) leaveRoom(); };

  // If the WebView suspends the guard while Minecraft is in front, send the raw
  // mic (auto-gain already off) instead of going silent. Swap back when it runs.
  setInterval(refreshSendTrack, 1000);

  // realmvcSweep: anyone still "Connecting…" after 30s, or whose link closed, is removed so the room doesn't fill with ghosts.
  setInterval(() => {
    if (!peer) return;
    const now = Date.now();
    remotes.forEach((info, id) => {
      const dead = info.conn && info.conn.open === false && info.conn._everOpen;
      if ((!info.stream && now - (info.since || now) > 30000) || dead) {
        dropRemote(id, "Someone couldn't connect and was removed.");
      }
    });
  }, 5000);

  btnLeave.addEventListener("click", () => leaveRoom());
  btnCopy.addEventListener("click", () => {
    const bridge = native();
    if (bridge) bridge.copyCode(roomCode);
    else if (navigator.clipboard) navigator.clipboard.writeText(roomCode);
  });
  btnShare.addEventListener("click", () => {
    const bridge = native();
    if (bridge) bridge.shareCode(roomCode);
  });
})();
