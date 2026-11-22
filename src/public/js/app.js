
const socket = io();
const $ = (id) => document.getElementById(id);

// ==================================
// HTML 요소
// ==================================

const welcome = $("welcome");
const welcomeForm = welcome.querySelector("form");
const call = $("call");

const roomInput = $("roomInput");
const nicknameInput = $("nicknameInput");

const myFace = $("myFace");
const myVideoName = $("myVideoName");
const videoGrid = $("videoGrid");

const sharedPanel = $("sharedPanel");
const sharedScreen = $("sharedScreen");
const screenTitle = $("screenTitle");

const muteBtn = $("mute");
const cameraBtn = $("camera");
const screenShareBtn = $("screenShare");
const leaveRoomBtn = $("leaveRoom");
const camerasSelect = $("cameras");

const participantCount = $("participantCount");
const participantList = $("participantList");

const chatForm = $("chatForm");
const chatList = $("chatList");

// ==================================
// 기본 상태
// ==================================

let myStream = null;
let screenStream = null;

let roomName = null;
let myId = null;
let myNickname = "";

let muted = false;
let cameraOff = false;
let joining = false;
let leaving = false;
let screenBusy = false;

// 카메라/마이크 연결
const cameraPeers = new Map();

// 화면 공유 연결
const screenPeers = new Map();

// 참가자 정보
const participants = new Map();

// 화면 공유 중인 참가자
const activeSharers = new Set();

// 수신한 공유 화면
const remoteScreens = new Map();

// 연결 생성 전 도착한 ICE 후보
const earlyIce = new Map();

const rtcConfig = {
  iceServers: [
    {
      urls: "stun:stun.l.google.com:19302"
    }
  ]
};

welcome.hidden = false;
call.hidden = true;

// ==================================
// 공통 함수
// ==================================

function log(...args) {
  console.log("[Noom]", ...args);
}

function addMessage(message) {
  const li = document.createElement("li");
  li.textContent = message;

  chatList.appendChild(li);
  chatList.scrollTop = chatList.scrollHeight;
}

function getName(id) {
  return participants.get(id) || "참가자";
}

function sendSignal(to, type, data) {
  if (!roomName) return;

  socket.emit("signal", {
    to,
    type,
    data
  });
}

function iceKey(id, scope, sessionId = "") {
  return `${id}:${scope}:${sessionId}`;
}

function saveEarlyIce(id, scope, sessionId, candidate) {
  const key = iceKey(id, scope, sessionId);
  const queue = earlyIce.get(key) || [];

  queue.push(candidate);
  earlyIce.set(key, queue);
}

async function flushIce(id, scope, sessionId, pc) {
  const key = iceKey(id, scope, sessionId);
  const queue = earlyIce.get(key) || [];

  earlyIce.delete(key);

  for (const candidate of queue) {
    try {
      if (pc.signalingState !== "closed") {
        await pc.addIceCandidate(candidate);
      }
    } catch (error) {
      console.error("ICE 처리 오류:", error);
    }
  }
}

// ==================================
// 참가자 목록
// ==================================

function updateParticipantList(list) {
  participants.clear();
  participantList.innerHTML = "";

  for (const { id, nickname } of list) {
    participants.set(id, nickname);

    const li = document.createElement("li");
    li.className = "participantItem";

    const avatar = document.createElement("span");
    avatar.className = "participantAvatar";
    avatar.textContent =
      nickname.charAt(0).toUpperCase();

    const name = document.createElement("span");
    name.className = "participantName";

    name.textContent =
      id === myId
        ? `${nickname} (나)`
        : nickname;

    li.append(avatar, name);
    participantList.appendChild(li);

    const peer = cameraPeers.get(id);

    if (peer) {
      peer.name = nickname;
      peer.title.textContent = nickname;
    }
  }

  participantCount.textContent = list.length;
  updateScreenDisplay();
}

socket.on("participants_updated", (list) => {
  if (!roomName) return;

  updateParticipantList(list);
});

// ==================================
// 화면 공유 표시
// ==================================

function updateScreenDisplay() {
  let stream = null;
  let title = "공유 화면";

  if (screenStream) {
    stream = screenStream;
    title = "내 화면 공유";
  } else {
    for (const id of activeSharers) {
      const remote = remoteScreens.get(id);

      if (!remote) continue;

      const track = remote.getVideoTracks()[0];

      if (
        track &&
        track.readyState === "live" &&
        !track.muted
      ) {
        stream = remote;
        title = `${getName(id)}의 화면 공유`;
        break;
      }
    }
  }

  if (sharedScreen.srcObject !== stream) {
    sharedScreen.srcObject = stream;
  }

  screenTitle.textContent = title;
  sharedPanel.hidden = !stream;

  $("meetingLayout").classList.toggle(
    "sharing",
    !!stream
  );

  if (stream) {
    sharedScreen.play().catch((error) => {
      log("공유 영상 재생 대기:", error.message);
    });
  }
}

// 공유 중인 사람이 있는지 확인
function updateShareButton() {
  const otherSharing = [...activeSharers].some(
    (id) => id !== myId
  );

  screenShareBtn.disabled =
    screenBusy || (otherSharing && !screenStream);

  if (!screenStream) {
    screenShareBtn.textContent = otherSharing
      ? "Someone Is Sharing"
      : "Share Screen";
  }
}

// 공유 시작 알림
socket.on("screen_share_started", ({ id }) => {
  if (!roomName || id === myId) return;

  activeSharers.add(id);
  updateShareButton();
  updateScreenDisplay();
});

// 공유 종료 알림
socket.on("screen_share_stopped", ({ id }) => {
  activeSharers.delete(id);
  remoteScreens.delete(id);

  const session = screenPeers.get(id);

  if (session && session.role === "receive") {
    closeScreenPeer(id);
  }

  updateShareButton();
  updateScreenDisplay();
});

// ==================================
// 카메라 목록
// ==================================

async function getCameras() {
  try {
    const devices =
      await navigator.mediaDevices.enumerateDevices();

    const current = myStream
      ?.getVideoTracks()[0]
      ?.getSettings().deviceId;

    camerasSelect.innerHTML = "";

    for (const device of devices) {
      if (device.kind !== "videoinput") continue;

      const option = document.createElement("option");

      option.value = device.deviceId;
      option.textContent =
        device.label || "Camera";

      option.selected =
        device.deviceId === current;

      camerasSelect.appendChild(option);
    }
  } catch (error) {
    console.error("카메라 목록 오류:", error);
  }
}

// ==================================
// 카메라/마이크 가져오기
// ==================================

async function getMedia(deviceId) {
  let newStream = null;

  try {
    newStream =
      await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: deviceId
          ? { deviceId: { exact: deviceId } }
          : { facingMode: "user" }
      });

    const videoTrack =
      newStream.getVideoTracks()[0];

    const audioTrack =
      newStream.getAudioTracks()[0];

    videoTrack.enabled = !cameraOff;
    audioTrack.enabled = !muted;

    const changes = [];

    for (const peer of cameraPeers.values()) {
      changes.push(
        peer.videoSender.replaceTrack(videoTrack)
      );

      changes.push(
        peer.audioSender.replaceTrack(audioTrack)
      );
    }

    await Promise.all(changes);

    const oldStream = myStream;
    myStream = newStream;

    myFace.srcObject = myStream;

    oldStream?.getTracks().forEach((track) => {
      track.stop();
    });

    await getCameras();

    return true;
  } catch (error) {
    console.error("미디어 오류:", error);

    newStream?.getTracks().forEach((track) => {
      track.stop();
    });

    alert("카메라와 마이크 권한을 확인해 줘.");
    return false;
  }
}

// ==================================
// 마이크 / 카메라 버튼
// ==================================

muteBtn.addEventListener("click", () => {
  muted = !muted;

  myStream?.getAudioTracks().forEach((track) => {
    track.enabled = !muted;
  });

  muteBtn.textContent =
    muted ? "Unmute" : "Mute";
});

cameraBtn.addEventListener("click", () => {
  cameraOff = !cameraOff;

  myStream?.getVideoTracks().forEach((track) => {
    track.enabled = !cameraOff;
  });

  cameraBtn.textContent = cameraOff
    ? "Turn Camera On"
    : "Turn Camera Off";
});

camerasSelect.addEventListener("change", async () => {
  await getMedia(camerasSelect.value);
});

// ==================================
// 참가자 영상 카드
// ==================================

function createVideoCard(id, nickname) {
  const card = document.createElement("div");
  card.className = "videoCard";
  card.dataset.peerId = id;

  const title = document.createElement("h3");
  title.textContent = nickname;

  const video = document.createElement("video");

  video.autoplay = true;
  video.playsInline = true;

  card.append(title, video);
  videoGrid.appendChild(card);

  return { card, title, video };
}

// ==================================
// 채팅 채널
// ==================================

function setupDataChannel(peer, channel) {
  peer.channel = channel;

  channel.addEventListener("message", (event) => {
    if (cameraPeers.get(peer.id) !== peer) return;

    addMessage(`${peer.name}: ${event.data}`);
  });

  channel.addEventListener("error", (error) => {
    console.error("채팅 오류:", error);
  });
}

// ==================================
// 카메라 WebRTC 연결
// ==================================

function createCameraPeer(id, nickname) {
  if (cameraPeers.has(id)) {
    return cameraPeers.get(id);
  }

  if (!myStream) return null;

  const pc = new RTCPeerConnection(rtcConfig);

  const { card, title, video } =
    createVideoCard(id, nickname);

  const remoteStream = new MediaStream();

  // 카메라와 마이크만 이 연결로 전송
  const audioSender = pc.addTrack(
    myStream.getAudioTracks()[0],
    myStream
  );

  const videoSender = pc.addTrack(
    myStream.getVideoTracks()[0],
    myStream
  );

  const peer = {
    id,
    name: nickname,
    pc,
    card,
    title,
    video,
    audioSender,
    videoSender,
    remoteStream,
    channel: null
  };

  cameraPeers.set(id, peer);

  pc.addEventListener("icecandidate", (event) => {
    if (
      event.candidate &&
      cameraPeers.get(id) === peer
    ) {
      sendSignal(id, "ice", {
        scope: "camera",
        candidate: event.candidate
      });
    }
  });

  pc.addEventListener("track", (event) => {
    if (cameraPeers.get(id) !== peer) return;

    log(
      "카메라/마이크 수신:",
      getName(id),
      event.track.kind
    );

    if (
      !remoteStream.getTracks().includes(event.track)
    ) {
      remoteStream.addTrack(event.track);
    }

    video.srcObject = remoteStream;

    video.play().catch((error) => {
      log("상대방 영상 재생 대기:", error.message);
    });
  });

  pc.addEventListener(
    "connectionstatechange",
    () => {
      if (cameraPeers.get(id) !== peer) return;

      log(
        getName(id),
        "카메라 연결:",
        pc.connectionState
      );

      if (pc.connectionState === "failed") {
        addMessage(
          `${getName(id)}와 카메라 연결에 실패했어.`
        );
      }
    }
  );

  pc.addEventListener("datachannel", (event) => {
    setupDataChannel(peer, event.channel);
  });

  return peer;
}

// ==================================
// 카메라 연결 요청
// ==================================

async function callCameraPeer(id, nickname) {
  const peer = createCameraPeer(id, nickname);

  if (!peer) return;

  try {
    const channel =
      peer.pc.createDataChannel("chat");

    setupDataChannel(peer, channel);

    const offer = await peer.pc.createOffer();

    await peer.pc.setLocalDescription(offer);

    if (cameraPeers.get(id) !== peer) return;

    sendSignal(id, "offer", {
      scope: "camera",
      description: peer.pc.localDescription
    });
  } catch (error) {
    console.error("카메라 Offer 오류:", error);
  }
}

// ==================================
// 화면 공유 WebRTC 연결
// ==================================

function closeScreenPeer(id) {
  const session = screenPeers.get(id);

  if (!session) return;

  screenPeers.delete(id);

  session.pc.close();

  if (session.role === "receive") {
    remoteScreens.delete(id);
  }

  earlyIce.delete(
    iceKey(id, "screen", session.sessionId)
  );
}

// 화면 공유 연결 생성
function createScreenPeer(id, role, sessionId) {
  const existing = screenPeers.get(id);

  if (existing) {
    if (
      existing.role === role &&
      existing.sessionId === sessionId
    ) {
      return existing;
    }

    closeScreenPeer(id);
  }

  const pc = new RTCPeerConnection(rtcConfig);

  const session = {
    id,
    role,
    sessionId,
    pc
  };

  screenPeers.set(id, session);

  pc.addEventListener("icecandidate", (event) => {
    if (
      event.candidate &&
      screenPeers.get(id) === session
    ) {
      sendSignal(id, "ice", {
        scope: "screen",
        sessionId,
        candidate: event.candidate
      });
    }
  });

  // 상대방의 공유 화면 수신
  if (role === "receive") {
    pc.addEventListener("track", (event) => {
      if (screenPeers.get(id) !== session) return;
      if (event.track.kind !== "video") return;

      log("공유 화면 영상 수신:", getName(id));

      const stream = new MediaStream([
        event.track
      ]);

      const show = () => {
        if (screenPeers.get(id) !== session) return;

        remoteScreens.set(id, stream);
        updateScreenDisplay();
      };

      const hide = () => {
        if (remoteScreens.get(id) === stream) {
          remoteScreens.delete(id);
          updateScreenDisplay();
        }
      };

      event.track.addEventListener("unmute", show);
      event.track.addEventListener("mute", hide);
      event.track.addEventListener("ended", hide);

      if (!event.track.muted) {
        show();
      }
    });
  }

  pc.addEventListener(
    "connectionstatechange",
    () => {
      if (screenPeers.get(id) !== session) return;

      log(
        getName(id),
        "화면 공유 연결:",
        pc.connectionState
      );
    }
  );

  return session;
}

// 공유 화면을 특정 참가자에게 전송
async function callScreenPeer(id) {
  if (!screenStream || !roomName) return;

  // 현재는 한 사람만 공유하도록 제한
  const otherSharing = [...activeSharers].some(
    (sharer) => sharer !== myId
  );

  if (otherSharing) return;

  const track = screenStream.getVideoTracks()[0];

  if (!track || track.readyState !== "live") {
    return;
  }

  const sessionId =
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const session =
    createScreenPeer(id, "send", sessionId);

  try {
    session.pc.addTrack(track, screenStream);

    const offer =
      await session.pc.createOffer();

    await session.pc.setLocalDescription(offer);

    if (screenPeers.get(id) !== session) return;

    sendSignal(id, "offer", {
      scope: "screen",
      sessionId,
      description: session.pc.localDescription
    });
  } catch (error) {
    console.error("화면 공유 Offer 오류:", error);
    closeScreenPeer(id);
  }
}

// ==================================
// WebRTC 신호 처리
// ==================================

socket.on("signal", async ({
  from,
  type,
  data
}) => {
  if (!roomName || !data) return;

  const scope = data.scope;

  if (scope !== "camera" && scope !== "screen") {
    return;
  }

  const sessionId =
    scope === "screen" ? data.sessionId : "";

  // ICE가 Offer보다 먼저 도착한 경우
  if (type === "ice") {
    const session = scope === "camera"
      ? cameraPeers.get(from)
      : screenPeers.get(from);

    const pc = scope === "camera"
      ? session?.pc
      : session?.sessionId === sessionId
        ? session.pc
        : null;

    if (!pc || !pc.remoteDescription) {
      saveEarlyIce(
        from,
        scope,
        sessionId,
        data.candidate
      );
      return;
    }

    try {
      await pc.addIceCandidate(data.candidate);
    } catch (error) {
      console.error("ICE 수신 오류:", error);
    }

    return;
  }

  try {
    if (scope === "camera") {
      let peer = cameraPeers.get(from);

      if (type === "offer") {
        if (!peer) {
          peer = createCameraPeer(
            from,
            getName(from)
          );
        }

        if (!peer) return;

        await peer.pc.setRemoteDescription(
          data.description
        );

        const answer =
          await peer.pc.createAnswer();

        await peer.pc.setLocalDescription(answer);

        sendSignal(from, "answer", {
          scope: "camera",
          description: peer.pc.localDescription
        });

        await flushIce(
          from,
          "camera",
          "",
          peer.pc
        );
      }

      if (type === "answer" && peer) {
        await peer.pc.setRemoteDescription(
          data.description
        );

        await flushIce(
          from,
          "camera",
          "",
          peer.pc
        );
      }

      return;
    }

    // 화면 공유 신호
    if (scope === "screen") {
      if (type === "offer") {
        const session = createScreenPeer(
          from,
          "receive",
          sessionId
        );

        // 상대방 공유 영상만 받기
        await session.pc.setRemoteDescription(
          data.description
        );

        const answer =
          await session.pc.createAnswer();

        await session.pc.setLocalDescription(
          answer
        );

        sendSignal(from, "answer", {
          scope: "screen",
          sessionId,
          description: session.pc.localDescription
        });

        await flushIce(
          from,
          "screen",
          sessionId,
          session.pc
        );

        return;
      }

      if (type === "answer") {
        const session = screenPeers.get(from);

        if (
          !session ||
          session.role !== "send" ||
          session.sessionId !== sessionId
        ) {
          return;
        }

        await session.pc.setRemoteDescription(
          data.description
        );

        await flushIce(
          from,
          "screen",
          sessionId,
          session.pc
        );
      }
    }
  } catch (error) {
    console.error(
      `${scope} ${type} 신호 오류:`,
      error
    );
  }
});

// ==================================
// 새 참가자 입장
// ==================================

// 기존 참가자는 새 사람의 카메라 Offer를 기다림.
// 화면 공유 중이면 새 사람에게 공유 Offer를 보냄.
socket.on("peer_joined", async ({ id, nickname }) => {
  if (!roomName) return;

  participants.set(id, nickname);

  if (screenStream) {
    await callScreenPeer(id);
  }
});

// ==================================
// 참가자 퇴장
// ==================================

function removeCameraPeer(id) {
  const peer = cameraPeers.get(id);

  if (!peer) return;

  cameraPeers.delete(id);

  try {
    peer.channel?.close();
  } catch (error) {
    console.error(error);
  }

  peer.pc.close();
  peer.video.srcObject = null;
  peer.card.remove();
}

function removePeer(id) {
  removeCameraPeer(id);
  closeScreenPeer(id);

  activeSharers.delete(id);
  remoteScreens.delete(id);

  earlyIce.delete(iceKey(id, "camera"));

  updateShareButton();
  updateScreenDisplay();
}

socket.on("peer_left", ({ id }) => {
  if (!roomName) return;

  const nickname = getName(id);

  removePeer(id);

  addMessage(`${nickname}님이 퇴장했어.`);
});

// ==================================
// 화면 공유 시작
// ==================================

async function startScreenShare() {
  if (
    !roomName ||
    !myStream ||
    screenStream ||
    screenBusy
  ) {
    return;
  }

  const otherSharing = [...activeSharers].some(
    (id) => id !== myId
  );

  if (otherSharing) {
    alert("다른 참가자가 화면을 공유 중이야.");
    return;
  }

  screenBusy = true;
  updateShareButton();

  let stream = null;

  try {
    stream =
      await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false
      });

    const track = stream.getVideoTracks()[0];

    if (!track || !roomName) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    screenStream = stream;

    activeSharers.add(myId);

    // 모든 참가자에게 화면 공유 시작 알림
    socket.emit("screen_share_start");

    updateScreenDisplay();

    screenShareBtn.textContent = "Stop Sharing";

    // 참가자마다 별도 공유 연결 생성
    const ids = [...participants.keys()].filter(
      (id) => id !== myId
    );

    await Promise.allSettled(
      ids.map((id) => callScreenPeer(id))
    );

    track.addEventListener(
      "ended",
      () => {
        stopScreenShare();
      },
      { once: true }
    );
  } catch (error) {
    console.error("화면 공유 시작 오류:", error);

    if (screenStream === stream) {
      await stopScreenShare();
    } else {
      stream?.getTracks().forEach((t) => t.stop());
    }

    if (error.name !== "NotAllowedError") {
      alert("화면 공유를 시작하지 못했어.");
    }
  } finally {
    screenBusy = false;
    updateShareButton();
  }
}

// ==================================
// 화면 공유 중지
// ==================================

async function stopScreenShare() {
  if (!screenStream) return;

  const stream = screenStream;
  screenStream = null;

  if (roomName) {
    socket.emit("screen_share_stop");
  }

  activeSharers.delete(myId);

  for (const [id, session] of [...screenPeers]) {
    if (session.role === "send") {
      closeScreenPeer(id);
    }
  }

  stream.getTracks().forEach((track) => {
    track.stop();
  });

  screenShareBtn.textContent = "Share Screen";

  updateShareButton();
  updateScreenDisplay();
}

screenShareBtn.addEventListener("click", async () => {
  if (screenBusy) return;

  if (screenStream) {
    screenBusy = true;
    updateShareButton();

    try {
      await stopScreenShare();
    } finally {
      screenBusy = false;
      updateShareButton();
    }
  } else {
    await startScreenShare();
  }
});

// ==================================
// 회의실 입장
// ==================================

welcomeForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (joining || roomName) return;

  const name = roomInput.value.trim();
  const nickname = nicknameInput.value.trim();

  if (!name || !nickname) return;

  joining = true;

  const ready = await getMedia();

  if (!ready) {
    joining = false;
    return;
  }

  socket.emit(
    "join_room",
    name,
    nickname,
    async (result) => {
      joining = false;

      if (!result?.ok) {
        alert(result?.message || "입장 실패");

        myStream?.getTracks().forEach((t) => {
          t.stop();
        });

        myStream = null;
        myFace.srcObject = null;
        return;
      }

      roomName = name;
      myId = result.myId;
      myNickname = nickname;

      myVideoName.textContent =
        `${nickname} (나)`;

      welcome.hidden = true;
      call.hidden = false;

      updateParticipantList([
        ...result.existing,
        {
          id: myId,
          nickname
        }
      ]);

      // 새 참가자가 기존 참가자들에게
      // 카메라 연결을 요청함
      for (const member of result.existing) {
        await callCameraPeer(
          member.id,
          member.nickname
        );
      }

      roomInput.value = "";
    }
  );
});

// ==================================
// 전체 채팅
// ==================================

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const input = chatForm.querySelector("input");
  const message = input.value.trim();

  if (!message) return;

  let delivered = 0;

  for (const peer of cameraPeers.values()) {
    if (peer.channel?.readyState === "open") {
      peer.channel.send(message);
      delivered++;
    }
  }

  addMessage(`${myNickname} (나): ${message}`);

  if (delivered === 0) {
    addMessage("아직 연결된 참가자가 없어.");
  }

  input.value = "";
});

// ==================================
// 회의실 퇴장
// ==================================

leaveRoomBtn.addEventListener("click", async () => {
  if (leaving) return;
  leaving = true;

  try {
    if (screenStream) {
      await stopScreenShare();
    }

    socket.emit("leave_room");

    for (const id of [...cameraPeers.keys()]) {
      removePeer(id);
    }

    for (const id of [...screenPeers.keys()]) {
      closeScreenPeer(id);
    }

    myStream?.getTracks().forEach((track) => {
      track.stop();
    });

    myStream = null;
    myFace.srcObject = null;

    participants.clear();
    activeSharers.clear();
    remoteScreens.clear();
    earlyIce.clear();

    roomName = null;
    myId = null;
    myNickname = "";

    muted = false;
    cameraOff = false;

    participantList.innerHTML = "";
    participantCount.textContent = "0";
    chatList.innerHTML = "";

    muteBtn.textContent = "Mute";
    cameraBtn.textContent = "Turn Camera Off";
    screenShareBtn.textContent = "Share Screen";

    updateScreenDisplay();
    updateShareButton();

    call.hidden = true;
    welcome.hidden = false;
  } finally {
    leaving = false;
  }
});
