const taskInput = document.getElementById("taskInput");
const humanNote = document.getElementById("humanNote");
const createBtn = document.getElementById("createBtn");
const runBtn = document.getElementById("runBtn");
const finalizeBtn = document.getElementById("finalizeBtn");
const mainViewBtn = document.getElementById("mainViewBtn");
const newRoomBtn = document.getElementById("newRoomBtn");
const roomsRefreshBtn = document.getElementById("roomsRefreshBtn");
const roomMeta = document.getElementById("roomMeta");
const timelineEl = document.getElementById("timeline");
const artifactsEl = document.getElementById("artifacts");
const agentListEl = document.getElementById("agentList");
const roomListEl = document.getElementById("roomList");
const agentConnectTextEl = document.getElementById("agentConnectText");

let activeRoomId = null;
let availableAgents = [];
let roomsCache = [];
let connectInfo = null;

init().catch((error) => {
  setMeta(`Init error: ${error.message}`);
});

createBtn.addEventListener("click", async () => {
  try {
    const task = taskInput.value.trim();
    if (!task) {
      setMeta("Task is required.");
      return;
    }

    const selected = [...agentListEl.querySelectorAll("input[type=checkbox]:checked")].map(
      (x) => x.value
    );
    if (selected.length < 1) {
      setMeta("Select at least one agent.");
      return;
    }

    const room = await api("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ task, agentIds: selected })
    });

    activeRoomId = room.id;
    await loadRooms();
    await selectRoom(room.id);
    setMeta(`Room ${room.id} created.`);
  } catch (error) {
    handleError(error);
  }
});

runBtn.addEventListener("click", async () => {
  try {
    if (!activeRoomId) {
      return;
    }
    const room = await api(`/api/rooms/${activeRoomId}/run`, { method: "POST" });
    await renderRoom(room);
    await loadRooms();
    setMeta(`Run complete. Status: ${room.status}.`);
  } catch (error) {
    handleError(error);
  }
});

finalizeBtn.addEventListener("click", async () => {
  try {
    if (!activeRoomId) {
      return;
    }
    const note = humanNote.value.trim();
    const room = await api(`/api/rooms/${activeRoomId}/finalize`, {
      method: "POST",
      body: JSON.stringify({ note })
    });
    await renderRoom(room);
    await loadRooms();
    setMeta(`Room finalized at ${room.updatedAt}.`);
  } catch (error) {
    handleError(error);
  }
});

mainViewBtn.addEventListener("click", () => {
  resetToMainView("Main view. Choose a room from the left.");
});

newRoomBtn.addEventListener("click", () => {
  activeRoomId = null;
  renderRoomList();
  clearRoomPanels();
  updateActionState(null);
  setMeta("New room mode. Fill task and click Create Room.");
  taskInput.focus();
});

roomsRefreshBtn.addEventListener("click", async () => {
  try {
    await loadRooms();
    setMeta("Room list refreshed.");
  } catch (error) {
    handleError(error);
  }
});

function renderAgentList() {
  agentListEl.innerHTML = "";
  for (const agent of availableAgents) {
    const node = document.createElement("label");
    node.className = "agent-item";
    node.innerHTML = `
      <input type="checkbox" value="${agent.id}" checked />
      <span><strong>${agent.displayName}</strong> <small>(${agent.role})</small></span>
    `;
    agentListEl.appendChild(node);
  }
}

function renderRoomList() {
  roomListEl.innerHTML = "";

  if (roomsCache.length === 0) {
    const empty = document.createElement("div");
    empty.className = "room-empty";
    empty.textContent = "No rooms yet.";
    roomListEl.appendChild(empty);
    return;
  }

  for (const room of roomsCache) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `room-item ${room.id === activeRoomId ? "active" : ""}`;
    item.innerHTML = `
      <span class="room-head">
        <span class="room-id">${room.id.slice(0, 8)}</span>
        <span class="room-status status-${room.status}">${room.status}</span>
      </span>
      <span class="room-task">${escapeHtml(truncate(room.task, 56))}</span>
      <span class="room-phase">${room.phase}</span>
    `;
    item.addEventListener("click", () => {
      selectRoom(room.id).catch(handleError);
    });
    roomListEl.appendChild(item);
  }
}

async function init() {
  clearRoomPanels();
  const [agentsData, roomsData, connectData] = await Promise.all([
    api("/api/agents"),
    api("/api/rooms"),
    api("/api/connect/instructions")
  ]);
  availableAgents = agentsData.value || [];
  roomsCache = roomsData.value || [];
  connectInfo = connectData;
  renderAgentList();
  renderRoomList();
  renderConnectInfo(connectInfo, null);

  if (roomsCache.length > 0) {
    await selectRoom(roomsCache[0].id);
    setMeta(`Loaded latest room ${roomsCache[0].id}.`);
    return;
  }

  updateActionState(null);
  setMeta("No active room.");
}

async function loadRooms() {
  const data = await api("/api/rooms");
  roomsCache = data.value || [];
  renderRoomList();

  if (activeRoomId && !roomsCache.some((room) => room.id === activeRoomId)) {
    resetToMainView("Selected room is gone. Pick another one.");
  }
}

async function selectRoom(roomId) {
  activeRoomId = roomId;
  renderRoomList();
  const [room, brief] = await Promise.all([
    api(`/api/rooms/${roomId}`),
    api(`/api/rooms/${roomId}/connect`)
  ]);
  await renderRoom(room);
  renderConnectInfo(connectInfo, brief);
  setMeta(`Viewing room ${room.id} (${room.status}).`);
}

async function renderRoom(room) {
  updateActionState(room);
  timelineEl.innerHTML = "";
  artifactsEl.innerHTML = "";

  if (!room.timeline || room.timeline.length === 0) {
    appendEmptyCard(timelineEl, "No timeline events yet.");
  }

  (room.timeline || []).forEach((item) => {
    const phaseClass = `phase-${String(item.phase).replaceAll("_", "-")}`;
    const card = document.createElement("div");
    card.className = `card timeline-card ${phaseClass}`;
    card.innerHTML = `
      <p class="title">>> [${item.phase}] ${item.envelope.from_agent} -> ${item.envelope.to_agent}</p>
      <p class="mono">intent=${item.envelope.intent}\nconfidence=${item.envelope.confidence}\nneed_human=${item.envelope.need_human}\n${item.envelope.explanation}</p>
    `;
    timelineEl.appendChild(card);
  });

  if (!room.artifacts || room.artifacts.length === 0) {
    appendEmptyCard(artifactsEl, "No artifacts yet.");
  }

  (room.artifacts || []).forEach((artifact) => {
    const card = document.createElement("div");
    card.className = `card artifact-card artifact-${artifact.type}`;
    card.innerHTML = `
      <p class="title">## ${artifact.type} | ${artifact.label} | ${artifact.producer}</p>
      <p class="mono">${escapeHtml(artifact.content)}</p>
    `;
    artifactsEl.appendChild(card);
  });
}

function updateActionState(room) {
  if (!room) {
    runBtn.disabled = true;
    finalizeBtn.disabled = true;
    return;
  }

  runBtn.disabled = room.status === "finalized";
  finalizeBtn.disabled = room.status !== "awaiting_human";
}

function appendEmptyCard(parent, text) {
  const card = document.createElement("div");
  card.className = "card empty-card";
  card.innerHTML = `<p class="mono">${escapeHtml(text)}</p>`;
  parent.appendChild(card);
}

function resetToMainView(message) {
  activeRoomId = null;
  renderRoomList();
  clearRoomPanels();
  updateActionState(null);
  renderConnectInfo(connectInfo, null);
  setMeta(message);
}

function clearRoomPanels() {
  timelineEl.innerHTML = "";
  artifactsEl.innerHTML = "";
  appendEmptyCard(timelineEl, "Pick room from left or create a new one.");
  appendEmptyCard(artifactsEl, "Artifacts appear after room run.");
}

function setMeta(text) {
  roomMeta.textContent = text;
}

function renderConnectInfo(info, roomBrief) {
  if (!agentConnectTextEl) {
    return;
  }

  if (!info) {
    agentConnectTextEl.textContent = "Connect info is unavailable.";
    return;
  }

  const lines = [
    `BASE URL: ${info.baseUrl}`,
    `TRANSPORT: ${info.transport}`,
    "",
    "ROOM CREATE (POST):",
    `${info.endpoints.createRoom}`,
    "",
    "PAYLOAD:",
    `{"task":"your task","agentIds":["planner","skeptic"]}`,
    "",
    "RUN FLOW:",
    `1) POST ${info.endpoints.createRoom}`,
    `2) POST ${info.endpoints.runRoom.replace("{roomId}", "<roomId>")}`,
    `3) GET  ${info.endpoints.getRoom.replace("{roomId}", "<roomId>")}`,
    `4) POST ${info.endpoints.finalizeRoom.replace("{roomId}", "<roomId>")}`
  ];

  if (roomBrief) {
    lines.push("");
    lines.push(`SELECTED ROOM: ${roomBrief.roomId}`);
    lines.push(`roomApi: ${roomBrief.roomApi}`);
    lines.push(`runApi: ${roomBrief.runApi}`);
    lines.push(`finalizeApi: ${roomBrief.finalizeApi}`);
  }

  agentConnectTextEl.textContent = lines.join("\n");
}

function truncate(text, size) {
  if (text.length <= size) {
    return text;
  }
  return `${text.slice(0, Math.max(0, size - 3))}...`;
}

function handleError(error) {
  const message = error instanceof Error ? error.message : String(error);
  setMeta(`Error: ${message}`);
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function api(url, options = {}) {
  const request = {
    headers: {
      "Content-Type": "application/json"
    },
    ...options
  };
  const res = await fetch(url, request);
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || `HTTP ${res.status}`);
  }
  return res.json();
}
