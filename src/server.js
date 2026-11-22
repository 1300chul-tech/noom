
import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();

app.set("view engine", "pug");
app.set("views", process.cwd() + "/src/views");

app.use(
  "/public",
  express.static(process.cwd() + "/src/public")
);

app.get("/", (req, res) => {
  res.render("home");
});

const httpServer = http.createServer(app);
const io = new Server(httpServer);

const MAX_PARTICIPANTS = 10;
const rooms = new Map();

// 방 이름 -> Map(소켓 ID, 닉네임)
function getParticipants(roomName) {
  const room = rooms.get(roomName);

  if (!room) return [];

  return [...room.entries()].map(([id, nickname]) => ({
    id,
    nickname
  }));
}

function updateParticipants(roomName) {
  io.to(roomName).emit(
    "participants_updated",
    getParticipants(roomName)
  );
}

io.on("connection", (socket) => {
  socket.on("join_room", (roomName, nickname, callback) => {
    if (
      typeof roomName !== "string" ||
      !roomName.trim() ||
      typeof nickname !== "string" ||
      !nickname.trim()
    ) {
      return callback?.({
        ok: false,
        message: "방 이름과 닉네임을 입력해 줘."
      });
    }

    if (socket.data.roomName) {
      return callback?.({
        ok: false,
        message: "이미 회의실에 들어와 있어."
      });
    }

    const name = roomName.trim().slice(0, 80);
    const displayName = nickname.trim().slice(0, 30);

    let room = rooms.get(name);

    if (!room) {
      room = new Map();
      rooms.set(name, room);
    }

    if (room.size >= MAX_PARTICIPANTS) {
      return callback?.({
        ok: false,
        message: "최대 10명까지 입장할 수 있어."
      });
    }

    const existing = getParticipants(name);

    room.set(socket.id, displayName);
    socket.join(name);

    socket.data.roomName = name;
    socket.data.nickname = displayName;
    socket.data.sharing = false;

    callback?.({
      ok: true,
      myId: socket.id,
      existing
    });

    updateParticipants(name);

    socket.to(name).emit("peer_joined", {
      id: socket.id,
      nickname: displayName
    });

    // 이미 공유 중인 참가자가 있다면 새 참가자에게 알림
    for (const member of existing) {
      const other = io.sockets.sockets.get(member.id);

      if (other?.data.sharing) {
        socket.emit("screen_share_started", {
          id: member.id,
          nickname: member.nickname
        });
      }
    }
  });

  // WebRTC 신호를 특정 참가자에게 전달
  socket.on("signal", ({ to, type, data } = {}) => {
    const name = socket.data.roomName;
    if (!name || typeof to !== "string") return;

    const room = rooms.get(name);

    if (!room?.has(to) || to === socket.id) {
      return;
    }

    if (!["offer", "answer", "ice"].includes(type)) {
      return;
    }

    io.to(to).emit("signal", {
      from: socket.id,
      type,
      data
    });
  });

  // 화면 공유 시작
  socket.on("screen_share_start", () => {
    const name = socket.data.roomName;
    if (!name) return;

    socket.data.sharing = true;

    socket.to(name).emit("screen_share_started", {
      id: socket.id,
      nickname: socket.data.nickname
    });
  });

  // 화면 공유 종료
  socket.on("screen_share_stop", () => {
    const name = socket.data.roomName;
    if (!name) return;

    socket.data.sharing = false;

    socket.to(name).emit("screen_share_stopped", {
      id: socket.id
    });
  });

  function leaveRoom() {
    const name = socket.data.roomName;
    if (!name) return;

    if (socket.data.sharing) {
      socket.to(name).emit("screen_share_stopped", {
        id: socket.id
      });
    }

    socket.to(name).emit("peer_left", {
      id: socket.id
    });

    socket.leave(name);

    const room = rooms.get(name);
    room?.delete(socket.id);

    if (room?.size === 0) {
      rooms.delete(name);
    } else {
      updateParticipants(name);
    }

    delete socket.data.roomName;
    delete socket.data.nickname;
    delete socket.data.sharing;
  }

  socket.on("leave_room", leaveRoom);
  socket.on("disconnecting", leaveRoom);
});

const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Listening on port ${PORT}`);
});
