// frontend/src/webrtc.js (replace entire file)
export function createHostPC(viewerSid, localStream, socket, room) {
  const pc = new RTCPeerConnection({
    iceServers: [
  { urls: "stun:stun.l.google.com:19302" },
  {
    urls: "turn:openrelay.metered.ca:80",
    username: "openrelayproject",
    credential: "openrelayproject"
  },
  {
    urls: "turn:openrelay.metered.ca:443",
    username: "openrelayproject",
    credential: "openrelayproject"
  },
  {
    urls: "turn:openrelay.metered.ca:443?transport=tcp",
    username: "openrelayproject",
    credential: "openrelayproject"
  }
]

  });

  if (localStream) {
    localStream.getTracks().forEach(track => {
      const sender = pc.addTrack(track, localStream);
      console.log(`[HOST PC ${viewerSid}] addTrack kind=${track.kind} id=${track.id}`);
    });
  } else {
    console.log(`[HOST PC ${viewerSid}] WARNING: no localStream when creating host PC`);
  }

  pc.onicecandidate = (e) => {
    console.log(`[HOST PC ${viewerSid}] onicecandidate ->`, !!e.candidate);
    if (e.candidate) socket.emit("webrtc_ice", { room, to: viewerSid, candidate: e.candidate });
  };

  pc.onconnectionstatechange = () => {
    console.log(`[HOST PC ${viewerSid}] connectionState ->`, pc.connectionState);
  };

  pc.onnegotiationneeded = async () => {
    console.log(`[HOST PC ${viewerSid}] negotiationneeded fired`);
    // we are doing manual offers on viewer-joined; don't auto-negotiate here
  };

  return pc;
}

export function createViewerPC(socket, room, hostSid, onRemoteStream) {
  const pc = new RTCPeerConnection({
    iceServers: [
  { urls: "stun:stun.l.google.com:19302" },
  {
    urls: "turn:openrelay.metered.ca:80",
    username: "openrelayproject",
    credential: "openrelayproject"
  },
  {
    urls: "turn:openrelay.metered.ca:443",
    username: "openrelayproject",
    credential: "openrelayproject"
  },
  {
    urls: "turn:openrelay.metered.ca:443?transport=tcp",
    username: "openrelayproject",
    credential: "openrelayproject"
  }
]

  });

  pc.ontrack = (e) => {
    const stream = e.streams && e.streams[0];
    console.log("[VIEWER PC] ontrack stream.id=", stream && stream.id);
    if (onRemoteStream) onRemoteStream(stream);
  };

  pc.onicecandidate = (e) => {
    console.log("[VIEWER PC] onicecandidate ->", !!e.candidate);
    if (e.candidate) socket.emit("webrtc_ice", { room, to: hostSid, candidate: e.candidate });
  };

  pc.onconnectionstatechange = () => {
    console.log("[VIEWER PC] connectionState ->", pc.connectionState);
  };

  return pc;
}
