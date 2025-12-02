// frontend/src/App.jsx
import React, { useEffect, useRef, useState } from "react";
import io from "socket.io-client";
import { createHostPC, createViewerPC } from "./webrtc";
import "./App.css";

const SOCKET_SERVER = process.env.REACT_APP_SOCKET_URL || "http://localhost:8000";

export default function App() {
   // socket
   const socketRef = useRef(null);
   const [connected, setConnected] = useState(false);
 
   // room / identity
   const [room, setRoom] = useState("");
   const [name, setName] = useState("Guest");
   const [role, setRole] = useState("viewer"); // "host" or "viewer"
   const [createdRoom, setCreatedRoom] = useState("");
 
   // participants
   const [participants, setParticipants] = useState([]); // { sid, name, role }
 
   // local stream (host)
   const localStreamRef = useRef(null);
 
   // host: per-viewer peers
   const peersRef = useRef({}); // viewerSid -> RTCPeerConnection
   const pendingViewersRef = useRef(new Set());
 
   // viewer: single pc & hostSid
   const viewerPcRef = useRef(null);
   const hostSidRef = useRef(null);
 
   // video elements
   const localVideoRef = useRef(null);
   const remoteVideoRef = useRef(null);
 
   // chat
   const [chatMessages, setChatMessages] = useState([]);
   const [msg, setMsg] = useState("");
 
   // UI state
   const [isSharing, setIsSharing] = useState(false);
 
   // helper
   const pushChat = (m) => setChatMessages((c) => [...c, m]);

  // initialize socket
  useEffect(() => {
    const s = io(SOCKET_SERVER, { transports: ["websocket"], autoConnect: true });
    socketRef.current = s;

    s.on("connect", () => {
      console.log("socket connected", s.id);
      setConnected(true);
    });

    s.on("disconnect", () => {
      console.log("socket disconnected");
      setConnected(false);
    });

    // generic events
    s.on("joined", (data) => {
      console.log("joined ack", data);
      pushChat(`System: Joined room ${data.room}`);
    });

    s.on("user-joined", (u) => {
      pushChat(`System: ${u.name} (${u.role}) joined`);
      setParticipants((p) => [...p.filter(x => x.sid !== u.sid), { sid: u.sid, name: u.name, role: u.role }]);

    });

    s.on("user-left", (u) => {
      pushChat(`System: ${u.name} left`);
      setParticipants((p) => p.filter(x => x.sid !== u.sid));
    });

    s.on("chat-message", (m) => {
      setChatMessages((c) => [...c, `${m.name}: ${m.text}`]);
    });

    s.on("host-left", (d) => {
      pushChat("System: host disconnected");
      setIsSharing(false);
    });

    // Signaling: host gets notified when a viewer joins
    s.on("viewer-joined", ({ viewer_sid, viewer_name }) => {
      console.log("viewer-joined -> host should create PC for", viewer_sid);
      // host will create PC and send offer
      handleNewViewer(viewer_sid);
    });

    // Host receives answers from viewers
    s.on("webrtc_answer", async (data) => {
      const from = data.from;
      const answer = data.answer;
      const pc = peersRef.current[from];
      if (!pc) {
        console.warn("Host: no pc for answer from", from);
        return;
      }
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        console.log("Host: set remote desc (answer) from", from);
      } catch (e) {
        console.error("Host setRemoteDescription error:", e);
      }
    });

    // Host receives ICE candidates from viewers (forwarded)
    s.on("webrtc_ice", async (data) => {
      const from = data.from;
      const candidate = data.candidate;
      // If this is viewer->host candidate, it should target a host PC
      const pc = peersRef.current[from] || viewerPcRef.current;
      if (pc && candidate) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
          // console.log("Host/Viewer added ICE candidate from", from);
        } catch (e) {
          console.warn("addIceCandidate error", e);
        }
      }
    });

    // Viewer receives targeted offer from host
    s.on("webrtc_offer", async (data) => {
      const { from: hostSid, offer } = data;
      console.log("Viewer got offer from host", hostSid);
      hostSidRef.current = hostSid;
      if (!viewerPcRef.current) {
        viewerPcRef.current = createViewerPC(socketRef.current, room, hostSid, (stream) => {
          // assign incoming stream immediately
          if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = stream;
            remoteVideoRef.current.play().catch(() => {});
          }
        });
      }
      try {
        await viewerPcRef.current.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await viewerPcRef.current.createAnswer();
        await viewerPcRef.current.setLocalDescription(answer);
        // send answer directly to host
        socketRef.current.emit("webrtc_answer", { room, to: hostSid, answer });
        console.log("Viewer sent answer to host");
      } catch (e) {
        console.error("Viewer offer/answer error:", e);
      }
    });

    return () => {
      s.disconnect();
      socketRef.current = null;
    };
  }, []); // run once

  // ---------- Room creation / join ----------
  async function createRoom() {
  try {
    const res = await fetch(`${SOCKET_SERVER.replace(/\/$/, "")}/create-room`, { method: "POST" });
    const j = await res.json();
    setCreatedRoom(j.room);
    setRoom(j.room);
    pushChat(`System: Created room ${j.room}`);

    // wait until socket is connected
    const tryWait = (ms) => new Promise(res => setTimeout(res, ms));
    let attempts = 0;
    while (!socketRef.current || !socketRef.current.connected) {
      if (attempts++ > 20) {
        console.warn("Socket did not connect in time, please manually join the room as host");
        return;
      }
      await tryWait(100); // wait 100ms
    }

    // auto-join as host immediately after creating the room
    socketRef.current.emit("join_room", { room: j.room, name: name || "host", role: "host" });
    pushChat(`System: Auto-joined room ${j.room} as host`);
  } catch (e) {
    console.error("create room error", e);
    pushChat("System: failed to create room");
  }
}


  function joinRoom() {
  if (!room || room.trim() === "") return alert("Enter room code");
  const normalized = room.trim().toUpperCase();
  setRoom(normalized);
  const chosenRole = role === "host" ? "host" : "viewer";

  // ensure socket is connected
  if (!socketRef.current || !socketRef.current.connected) {
     pushChat("System: Socket not connected yet. Wait a moment and try again.");
     return;
  }

  socketRef.current.emit("join_room", { room: normalized, name, role: chosenRole });
  setParticipants((p) => [...p.filter(x => x.sid !== socketRef.current.id), { sid: socketRef.current.id, name, role: chosenRole }]);
}


  // ---------- Host: start screen share ----------
  async function startScreenShare() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true
    });

    localStreamRef.current = stream;
    setIsSharing(true);
    // Show host preview
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = stream;
      localVideoRef.current.muted = true;
      localVideoRef.current.play().catch(() => {});
    }

    console.log("Host: Screen share started.");

    // 🔥 IMPORTANT:
    // For every viewer that already joined, create PC + send offer NOW
    for (const viewerSid of Object.keys(peersRef.current)) {
      console.log("Host: existing viewer needs negotiation:", viewerSid);

      const pc = peersRef.current[viewerSid];

      // Add tracks if missing
      stream.getTracks().forEach(track => {
        pc.addTrack(track, stream);
        console.log("Host: added track for viewer", viewerSid, track.kind);
      });

      // Create fresh offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      socketRef.current.emit("webrtc_offer", {
        room,
        to: viewerSid,
        offer
      });

      console.log("Host: sent offer to viewer", viewerSid);
    }

    // If NO PCs exist yet (most likely your case), but viewers already joined,
    // then create PCs for them now.
    if (pendingViewersRef.current.size > 0) {
      console.log("Host: pending viewers:", pendingViewersRef.current);

      for (const viewerSid of pendingViewersRef.current) {
        console.log("Host: creating PC NOW for pending viewer:", viewerSid);
        await handleNewViewer(viewerSid);
      }

      pendingViewersRef.current.clear();
      const tracks = stream.getVideoTracks();
      if (tracks && tracks[0]) {
        tracks[0].addEventListener("ended", () => {
          stopScreenShare();
        });
      }
    }

  } catch (e) {
    console.error("Host screen share failed:", e);
    pushChat("System: screen share failed.");
  }
}

function stopScreenShare() {
  if (localStreamRef.current) {
    localStreamRef.current.getTracks().forEach(track => track.stop());
    localStreamRef.current = null;
  }
  setIsSharing(false);

  pushChat("System: Screen share stopped");

  // tell server
  socketRef.current &&
    socketRef.current.emit("host_state", { room, is_sharing: false });
}

  // ---------- Host: when new viewer joins create PC and send offer ----------
    async function handleNewViewer(viewerSid) {
    // create PC if not present
    if (peersRef.current[viewerSid]) {
      console.log("Host: pc already exists for", viewerSid);
      return;
    }

    const pc = createHostPC(viewerSid, null /* we will add tracks later when available */, socketRef.current, room);

    // store pc
    peersRef.current[viewerSid] = pc;

    // add connectionstate handler
    pc.onconnectionstatechange = () => {
      console.log("Host PC for", viewerSid, "state:", pc.connectionState);
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        try { pc.close(); } catch {}
        delete peersRef.current[viewerSid];
      }
    };

    // If local stream already exists, add tracks & create offer now
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => pc.addTrack(track, localStreamRef.current));
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socketRef.current.emit("webrtc_offer", { room, to: viewerSid, offer });
        console.log("Host: created+sent offer to", viewerSid);
      } catch (err) {
        console.error("Host createOffer error for", viewerSid, err);
      }
    } else {
      // no local stream yet; mark this viewer to be handled when host shares
      pendingViewersRef.current.add(viewerSid);
      console.log("Host: pending viewer (waiting for screen) ->", viewerSid);
    }
  }


  // ---------- Chat ----------
  function sendChat() {
    if (!msg) return;
    socketRef.current.emit("chat_message", { room, name, text: msg });
    setChatMessages((c) => [...c, `Me: ${msg}`]);
    setMsg("");
  }
const requestFullscreen = (el) => {
    if (!el) return;
    if (el.requestFullscreen) el.requestFullscreen();
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    else if (el.msRequestFullscreen) el.msRequestFullscreen();
  };

  const handleRemoteDoubleClick = () => {
    requestFullscreen(remoteVideoRef.current);
  };
  const handleLocalDoubleClick = () => {
    requestFullscreen(localVideoRef.current);
  };
  // ---------- UI ----------
  return (
  <div className="app-container">

    {/* ---- HEADER ---- */}
    <div className="header">
      <div className="title">🎥 WatchTogether</div>
      <div className={`status ${connected ? "online" : "offline"}`}>
        {connected ? "● Online" : "○ Offline"}
      </div>
    </div>

    {/* ---- ROOM SETTINGS ---- */}
    <div className="section card">
      <div className="row">
        <label>Room:</label>
        <input
          value={room}
          onChange={(e) => setRoom(e.target.value.toUpperCase())}
        />
        <button onClick={createRoom}>Create</button>
        {createdRoom && <span className="tag">Created: {createdRoom}</span>}
      </div>

      <div className="row">
        <label>Name:</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <label style={{ marginLeft: 12 }}>Role:</label>
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="viewer">Viewer</option>
          <option value="host">Host</option>
        </select>

        <button className="primary-btn" onClick={joinRoom}>Join</button>
      </div>
    </div>

    {/* ---- VIDEO AREA ---- */}
    <div className="video-area">

      {/* Host Preview */}
      {role === "host" && (
        <div className="video-box card">
          <div className="video-label">Your Screen (Preview)</div>
          <video
            ref={localVideoRef}
            autoPlay
            muted
            playsInline
            onDoubleClick={handleLocalDoubleClick}
          />
          <div className="btn-row">
            <button className="primary-btn" onClick={startScreenShare}>
              Start Screen Share
            </button>
          </div>
        </div>
      )}

      {/* Viewer remote screen */}
      {role === "viewer" && (
        <div className="video-box card">
          <div className="video-label">Host Screen</div>
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            onDoubleClick={handleRemoteDoubleClick}
          />
          <div className="hint">Double-click for fullscreen</div>
        </div>
      )}
    </div>

    {/* ---- CHAT ---- */}
    <div className="chat-box card">
      <div className="chat-title">💬 Chat</div>

      <div className="chat-messages">
        {chatMessages.map((c, i) => <div key={i} className="chat-line">{c}</div>)}
      </div>

      <div className="chat-input">
        <input
          value={msg}
          onChange={(e) => setMsg(e.target.value)}
          placeholder="Type a message…"
          onKeyDown={(e) => e.key === "Enter" && sendChat()}
        />
        <button className="primary-btn" onClick={sendChat}>Send</button>
      </div>
    </div>

  </div>
);
}