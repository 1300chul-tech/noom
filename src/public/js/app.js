
const socket = io();

// HTML 요소
const myFace = document.getElementById("myFace");
const muteBtn = document.getElementById("mute");
const cameraBtn = document.getElementById("camera");
const camerasSelect = document.getElementById("cameras");

const welcome = document.getElementById("welcome");
const welcomeForm = welcome.querySelector("form");

const call = document.getElementById("call");
const myPeerFace = document.getElementById("myPeerFace");

const chatForm = document.getElementById("chatForm");
const chatList = document.getElementById("chatList");

// 초기 화면
welcome.hidden = false;
call.hidden = true;

// 상태 변수
let myStream;
let muted = false;
let cameraOff = false;
let roomName;
let myPeerConnection;
let myDataChannel;

// 카메라 목록
async function getCameras() {
  try {
    const devices =
      await navigator.mediaDevices.enumerateDevices();

    const cameras = devices.filter(
      (device) => device.kind === "videoinput"
    );

    const currentCamera =
      myStream.getVideoTracks()[0]?.getSettings().deviceId;

    camerasSelect.innerHTML = "";

    cameras.forEach((camera) => {
      const option = document.createElement("option");

      option.value = camera.deviceId;
      option.innerText = camera.label || "Camera";

      if (camera.deviceId === currentCamera) {
        option.selected = true;
      }

      camerasSelect.appendChild(option);
    });
  } catch (error) {
    console.error("카메라 목록 오류:", error);
  }
}

// 카메라와 마이크
async function getMedia(deviceId) {
  const initialConstraints = {
    audio: true,
    video: { facingMode: "user" },
  };

  const cameraConstraints = {
    audio: true,
    video: {
      deviceId: { exact: deviceId },
    },
  };

  try {
    if (myStream) {
      myStream.getTracks().forEach((track) => track.stop());
    }

    myStream = await navigator.mediaDevices.getUserMedia(
      deviceId ? cameraConstraints : initialConstraints
    );

    myFace.srcObject = myStream;

    myStream.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });

    myStream.getVideoTracks().forEach((track) => {
      track.enabled = !cameraOff;
    });

    if (!deviceId) {
      await getCameras();
    }

    if (myPeerConnection) {
      const videoTrack = myStream.getVideoTracks()[0];

      const videoSender = myPeerConnection
        .getSenders()
        .find((sender) => sender.track?.kind === "video");

      if (videoSender && videoTrack) {
        await videoSender.replaceTrack(videoTrack);
      }

      const audioTrack = myStream.getAudioTracks()[0];

      const audioSender = myPeerConnection
        .getSenders()
        .find((sender) => sender.track?.kind === "audio");

      if (audioSender && audioTrack) {
        await audioSender.replaceTrack(audioTrack);
      }
    }

    return true;
  } catch (error) {
    console.error("카메라/마이크 오류:", error);
    alert("카메라와 마이크 권한을 확인해 줘.");
    return false;
  }
}

// 마이크 버튼
function handleMuteClick() {
  if (!myStream) return;

  muted = !muted;

  myStream.getAudioTracks().forEach((track) => {
    track.enabled = !muted;
  });

  muteBtn.innerText = muted ? "Unmute" : "Mute";
}

// 카메라 버튼
function handleCameraClick() {
  if (!myStream) return;

  cameraOff = !cameraOff;

  myStream.getVideoTracks().forEach((track) => {
    track.enabled = !cameraOff;
  });

  cameraBtn.innerText = cameraOff
    ? "Turn Camera On"
    : "Turn Camera Off";
}

// 카메라 변경
async function handleCameraChange() {
  await getMedia(camerasSelect.value);
}

muteBtn.addEventListener("click", handleMuteClick);
cameraBtn.addEventListener("click", handleCameraClick);
camerasSelect.addEventListener(
  "change",
  handleCameraChange
);

// 회의 시작
async function initCall() {
  const mediaReady = await getMedia();

  if (!mediaReady) return false;

  makeConnection();

  welcome.hidden = true;
  call.hidden = false;

  return true;
}

// 방 입장
async function handleWelcomeSubmit(event) {
  event.preventDefault();

  const input = welcomeForm.querySelector("input");
  roomName = input.value.trim();

  if (!roomName) return;

  const ready = await initCall();

  if (!ready) return;

  socket.emit("join_room", roomName);
  input.value = "";
}

welcomeForm.addEventListener(
  "submit",
  handleWelcomeSubmit
);

// 채팅 메시지 표시
function addMessage(message) {
  const li = document.createElement("li");
  li.innerText = message;
  chatList.appendChild(li);
}

// 채팅 전송
function handleChatSubmit(event) {
  event.preventDefault();

  const input = chatForm.querySelector("input");
  const message = input.value.trim();

  if (!message) return;

  if (
    myDataChannel &&
    myDataChannel.readyState === "open"
  ) {
    myDataChannel.send(message);
    addMessage(`You: ${message}`);
    input.value = "";
  } else {
    addMessage("아직 상대방과 연결되지 않았어.");
  }
}

chatForm.addEventListener(
  "submit",
  handleChatSubmit
);

// Socket.IO

socket.on("welcome", async () => {
  if (!myPeerConnection) return;

  myDataChannel =
    myPeerConnection.createDataChannel("chat");

  myDataChannel.addEventListener(
    "message",
    (event) => {
      addMessage(`Peer: ${event.data}`);
    }
  );

  const offer =
    await myPeerConnection.createOffer();

  await myPeerConnection.setLocalDescription(offer);

  socket.emit("offer", offer, roomName);
});

socket.on("offer", async (offer) => {
  if (!myPeerConnection) return;

  myPeerConnection.addEventListener(
    "datachannel",
    (event) => {
      myDataChannel = event.channel;

      myDataChannel.addEventListener(
        "message",
        (messageEvent) => {
          addMessage(`Peer: ${messageEvent.data}`);
        }
      );
    }
  );

  await myPeerConnection.setRemoteDescription(offer);

  const answer =
    await myPeerConnection.createAnswer();

  await myPeerConnection.setLocalDescription(answer);

  socket.emit("answer", answer, roomName);
});

socket.on("answer", async (answer) => {
  if (!myPeerConnection) return;

  await myPeerConnection.setRemoteDescription(answer);
});

socket.on("ice", async (ice) => {
  if (!myPeerConnection) return;

  try {
    await myPeerConnection.addIceCandidate(ice);
  } catch (error) {
    console.error("ICE 오류:", error);
  }
});

// WebRTC 연결
function makeConnection() {
  myPeerConnection = new RTCPeerConnection();

  myPeerConnection.addEventListener(
    "icecandidate",
    (event) => {
      if (event.candidate) {
        socket.emit(
          "ice",
          event.candidate,
          roomName
        );
      }
    }
  );

  myPeerConnection.addEventListener(
    "track",
    (event) => {
      myPeerFace.srcObject = event.streams[0];
    }
  );

  myStream.getTracks().forEach((track) => {
    myPeerConnection.addTrack(track, myStream);
  });
}
