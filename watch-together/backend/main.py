# backend/main.py
import os
import uuid
import string
import random
import asyncio
from typing import Dict, Any
from fastapi import FastAPI
import socketio
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import JSONResponse

# Config
ROOM_CODE_LEN = 6
ALPHABET = string.ascii_uppercase + string.digits

def gen_room_code(n=ROOM_CODE_LEN):
    return ''.join(random.choice(ALPHABET) for _ in range(n))

# Use async Socket.IO server
sio = socketio.AsyncServer(async_mode="asgi", cors_allowed_origins='*')
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # restrict in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
asgi_app = socketio.ASGIApp(sio, other_asgi_app=app)

# In-memory room store. For production use Redis (shown later)
rooms: Dict[str, Dict[str, Any]] = {}  # room_code -> metadata

@app.get("/health")
async def health():
    return JSONResponse({"ok": True})

@app.post("/create-room")
async def create_room():
    # create a room with a code and empty metadata
    for _ in range(5):
        code = gen_room_code()
        if code not in rooms:
            break
    rooms[code] = {
        "host_sid": None,
        "participants": {},   # sid -> {name, role}
        "created_at": asyncio.get_event_loop().time(),
    }
    return {"room": code}

@app.get("/room/{room_code}")
async def get_room(room_code: str):
    meta = rooms.get(room_code.upper())
    if not meta:
        return JSONResponse({"error": "room not found"}, status_code=404)
    return {"room": room_code.upper(), "meta": {"participants": list(meta["participants"].values()), "host_online": bool(meta["host_sid"])}}

# Socket.IO events
@sio.event
async def connect(sid, environ):
    print("connect", sid)

@sio.event
async def disconnect(sid):
    print("disconnect", sid)
    # remove user from any rooms they were part of
    for code, meta in list(rooms.items()):
        if sid in meta["participants"]:
            name = meta["participants"].pop(sid).get("name")
            await sio.emit("user-left", {"sid": sid, "name": name}, room=code)
            # if they were host, unset host_sid
            if meta.get("host_sid") == sid:
                meta["host_sid"] = None
                await sio.emit("host-left", {"msg": "host disconnected"}, room=code)
        # optional: cleanup empty rooms older than some threshold
        if not meta["participants"] and not meta["host_sid"]:
            # keep small TTL or remove immediately: here keep for 10 minutes. (simpler: remove immediately)
            # del rooms[code]
            pass

@sio.event
async def create_room_client(sid, data):
    # alternate: client can request room create via socket event
    code = gen_room_code()
    rooms[code] = {
        "host_sid": None,
        "participants": {},
        "created_at": asyncio.get_event_loop().time(),
    }
    await sio.emit("room-created", {"room": code}, to=sid)

@sio.event
async def join_room(sid, data):
    """
    data = { room: 'ABC123', name: 'Alice', role: 'host'|'viewer' }
    """
    room = data.get("room", "").upper()
    name = data.get("name", "Guest")
    role = data.get("role", "viewer")
    if room not in rooms:
        await sio.emit("join-error", {"error": "room-not-found"}, to=sid)
        return
    meta = rooms[room]
    # add to participants
    meta["participants"][sid] = {"sid": sid, "name": name, "role": role}
    await sio.enter_room(sid, room)

    if role == "host":
        meta["host_sid"] = sid
        # notify room that host came online
        await sio.emit("user-joined", {"sid": sid, "name": name, "role": role}, room=room)
        await sio.emit("joined", {"room": room, "meta": {"host_online": True}}, to=sid)
        return

    # role == viewer
    await sio.emit("user-joined", {"sid": sid, "name": name, "role": role}, room=room)

    # If host is online, notify the host that a new viewer joined (so host can create offer for this viewer)
    host_sid = meta.get("host_sid")
    if host_sid:
        await sio.emit("viewer-joined", {"viewer_sid": sid, "viewer_name": name}, to=host_sid)

    # ack to the joining viewer
    await sio.emit("joined", {"room": room, "meta": {"host_online": bool(meta.get("host_sid"))}}, to=sid)

# Signaling pass-through events:
# Offer, Answer, ICE candidates - forwarded to either a target or to the room (if intended for host)
# --- add/replace these handlers in backend/main.py ---
@sio.event
async def webrtc_offer(sid, data):
    room = data.get("room", "").upper()
    target = data.get("to")
    print(f"[SERVER] webrtc_offer from={sid} room={room} to={target}")
    if target:
        await sio.emit("webrtc_offer", {"from": sid, "offer": data.get("offer")}, to=target)
        print(f"[SERVER] forwarded offer from {sid} -> {target}")
    else:
        await sio.emit("webrtc_offer", {"from": sid, "offer": data.get("offer")}, room=room, skip_sid=sid)
        print(f"[SERVER] broadcasted offer from {sid} to room {room}")

@sio.event
async def webrtc_answer(sid, data):
    to = data.get("to")
    print(f"[SERVER] webrtc_answer from={sid} to={to}")
    if to:
        await sio.emit("webrtc_answer", {"from": sid, "answer": data.get("answer")}, to=to)
        print(f"[SERVER] forwarded answer from {sid} -> {to}")

@sio.event
async def webrtc_ice(sid, data):
    to = data.get("to")
    room = data.get("room")
    print(f"[SERVER] webrtc_ice from={sid} to={to} room={room}")
    if to:
        await sio.emit("webrtc_ice", {"from": sid, "candidate": data.get("candidate")}, to=to)
        print(f"[SERVER] forwarded ice from {sid} -> {to}")
    else:
        await sio.emit("webrtc_ice", {"from": sid, "candidate": data.get("candidate")}, room=room, skip_sid=sid)
        print(f"[SERVER] broadcasted ice from {sid} to room {room}")
# --- end replacement ---

# Chat
@sio.event
async def chat_message(sid, data):
    # data: { room, text, name }
    room = data.get("room", "").upper()
    await sio.emit("chat-message", {"from": sid, "name": data.get("name"), "text": data.get("text")}, room=room)

# Helper: allow host to ping server with state updates (optional)
@sio.event
async def host_state(sid, data):
    # data: { room, is_sharing: bool, extra... }
    room = data.get("room", "").upper()
    if room in rooms and rooms[room].get("host_sid") == sid:
        rooms[room]["host_state"] = data
        await sio.emit("host-state", data, room=room)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(asgi_app, host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))
