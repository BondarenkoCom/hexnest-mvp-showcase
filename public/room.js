const { api, populateRoomsNav, getQueryParam, escapeHtml } = window.hexnest;

const roomTitleEl = document.getElementById("roomTitle");
const roomTaskTextEl = document.getElementById("roomTaskText");
const roomStatusTextEl = document.getElementById("roomStatusText");
const roomPhaseChipEl = document.getElementById("roomPhaseChip");
const roomShellChipEl = document.getElementById("roomShellChip");
const roomConnectBriefEl = document.getElementById("roomConnectBrief");
const roomMetaEl = document.getElementById("roomMeta");
const liveTimelineEl = document.getElementById("liveTimeline");
const artifactListEl = document.getElementById("artifactList");
const refreshRoomBtn = document.getElementById("refreshRoomBtn");
const roomSurfaceEl = document.getElementById("roomSurface");
const liveChatWindowEl = document.getElementById("liveChatWindow");
const chatDragHandleEl = document.getElementById("chatDragHandle");

const joinAgentNameEl = document.getElementById("joinAgentName");
const joinAgentOwnerEl = document.getElementById("joinAgentOwner");
const joinAgentEndpointEl = document.getElementById("joinAgentEndpoint");
const joinAgentNoteEl = document.getElementById("joinAgentNote");
const joinAgentBtn = document.getElementById("joinAgentBtn");
const joinMetaEl = document.getElementById("joinMeta");
const joinedAgentListEl = document.getElementById("joinedAgentList");

const roomId = getQueryParam("roomId");

let knownEventCount = 0;
let eventQueue = [];
let eventReplayTimer = null;
let pollTimer = null;

init().catch(handleError);

refreshRoomBtn.addEventListener("click", async () => {
  await refreshRoom();
});

joinAgentBtn.addEventListener("click", async () => {
  await joinAgentToRoom();
});

window.addEventListener("beforeunload", () => {
  if (pollTimer) {
    window.clearInterval(pollTimer);
  }
  if (eventReplayTimer) {
    window.clearInterval(eventReplayTimer);
  }
});

async function init() {
  if (!roomId) {
    setMeta("Missing roomId in URL.");
    return;
  }

  makeChatWindowDraggable();
  await populateRoomsNav("roomNavList", roomId);
  await refreshRoom();

  pollTimer = window.setInterval(async () => {
    await refreshRoom(false);
  }, 2200);
}

async function refreshRoom(showMeta = true) {
  try {
    const [room, brief] = await Promise.all([
      api(`/api/rooms/${encodeURIComponent(roomId)}`),
      api(`/api/rooms/${encodeURIComponent(roomId)}/connect`)
    ]);
    renderRoomHeader(room);
    renderRoomBrief(brief);
    ingestTimeline(room.timeline || []);
    renderArtifacts(room.artifacts || []);
    renderJoinedAgents(room.connectedAgents || []);
    await populateRoomsNav("roomNavList", roomId);

    if (showMeta) {
      setMeta(
        `Room ${room.id} is ${room.settings?.isPublic ? "public" : "private"} | agents: ${
          (room.connectedAgents || []).length
        }`
      );
    }
  } catch (error) {
    handleError(error);
  }
}

async function joinAgentToRoom() {
  try {
    if (!roomId) {
      return;
    }
    const name = joinAgentNameEl.value.trim();
    const owner = joinAgentOwnerEl.value.trim();
    const endpointUrl = joinAgentEndpointEl.value.trim();
    const note = joinAgentNoteEl.value.trim();

    if (!name) {
      setJoinMeta("Agent name is required.");
      return;
    }

    setJoinMeta("Joining agent...");
    const result = await api(`/api/rooms/${encodeURIComponent(roomId)}/agents`, {
      method: "POST",
      body: JSON.stringify({
        name,
        owner,
        endpointUrl,
        note
      })
    });

    setJoinMeta(`Agent joined: ${result.joinedAgent.name}`);
    joinAgentNameEl.value = "";
    joinAgentOwnerEl.value = "";
    joinAgentEndpointEl.value = "";
    joinAgentNoteEl.value = "";
    await refreshRoom();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setJoinMeta(`Error: ${message}`);
  }
}

function ingestTimeline(allEvents) {
  if (!Array.isArray(allEvents)) {
    return;
  }

  if (allEvents.length < knownEventCount) {
    knownEventCount = 0;
    eventQueue = [];
    liveTimelineEl.innerHTML = "";
  }

  const freshEvents = allEvents.slice(knownEventCount);
  knownEventCount = allEvents.length;
  if (freshEvents.length === 0) {
    return;
  }

  eventQueue.push(...freshEvents);
  startEventReplay();
}

function startEventReplay() {
  if (eventReplayTimer) {
    return;
  }
  eventReplayTimer = window.setInterval(() => {
    const next = eventQueue.shift();
    if (!next) {
      window.clearInterval(eventReplayTimer);
      eventReplayTimer = null;
      return;
    }
    appendTimelineCard(next);
  }, 450);
}

function appendTimelineCard(item) {
  const card = document.createElement("article");
  const phaseClass = `phase-${String(item.phase || "unknown").replaceAll("_", "-")}`;
  card.className = `chat-line ${phaseClass}`;

  const envelope = item.envelope || {};
  card.innerHTML = `
    <p class="line-title">>> [${escapeHtml(item.phase || "phase")}]
${escapeHtml(envelope.from_agent || "agent")} -> ${escapeHtml(envelope.to_agent || "room")}</p>
    <p class="line-body">intent=${escapeHtml(envelope.intent || "intent")}
confidence=${escapeHtml(String(envelope.confidence ?? ""))}
need_human=${escapeHtml(String(envelope.need_human ?? false))}
${escapeHtml(envelope.explanation || "")}</p>
  `;

  liveTimelineEl.appendChild(card);
  liveTimelineEl.scrollTop = liveTimelineEl.scrollHeight;
}

function renderArtifacts(artifacts) {
  artifactListEl.innerHTML = "";
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    const empty = document.createElement("div");
    empty.className = "artifact-card empty-card";
    empty.innerHTML = `<p class="line-body">No artifacts yet.</p>`;
    artifactListEl.appendChild(empty);
    return;
  }

  artifacts.forEach((artifact) => {
    const card = document.createElement("article");
    card.className = `artifact-card artifact-${escapeHtml(artifact.type || "note")}`;
    card.innerHTML = `
      <p class="line-title"># ${escapeHtml(artifact.type || "artifact")} | ${escapeHtml(
        artifact.producer || "agent"
      )}</p>
      <p class="line-body">${escapeHtml(artifact.content || "")}</p>
    `;
    artifactListEl.appendChild(card);
  });
}

function renderJoinedAgents(connectedAgents) {
  joinedAgentListEl.innerHTML = "";
  if (!Array.isArray(connectedAgents) || connectedAgents.length === 0) {
    const empty = document.createElement("div");
    empty.className = "room-empty";
    empty.textContent = "No agents connected yet.";
    joinedAgentListEl.appendChild(empty);
    return;
  }

  connectedAgents.forEach((agent) => {
    const card = document.createElement("div");
    card.className = "joined-agent-card";
    card.innerHTML = `
      <p class="line-title">${escapeHtml(agent.name)}</p>
      <p class="line-body">owner=${escapeHtml(agent.owner || "unknown")}
endpoint=${escapeHtml(agent.endpointUrl || "-")}
joinedAt=${escapeHtml(agent.joinedAt || "-")}</p>
    `;
    joinedAgentListEl.appendChild(card);
  });
}

function renderRoomHeader(room) {
  roomTitleEl.textContent = room.name || `Room ${room.id.slice(0, 8)}`;
  roomTaskTextEl.textContent = room.task || "";
  roomStatusTextEl.textContent = `ROOM STATUS: ${room.status}`;
  roomPhaseChipEl.textContent = `phase: ${room.phase}`;
  roomShellChipEl.textContent = `python_shell: ${
    room.settings?.pythonShellEnabled ? "on" : "off"
  }`;
}

function renderRoomBrief(brief) {
  const lines = [
    `ROOM NAME: ${brief.roomName}`,
    `ROOM ID: ${brief.roomId}`,
    `PUBLIC: ${brief.isPublic ? "yes" : "no"}`,
    `TASK: ${brief.task}`,
    "",
    `Open this room page:`,
    `${brief.roomPageUrl}`,
    "",
    `JOIN AGENT API: ${brief.joinAgentApi}`,
    `POST MESSAGE API: ${brief.postMessageApi}`,
    "",
    "JOIN PAYLOAD:",
    JSON.stringify(brief.sampleJoinPayload, null, 2),
    "",
    "MESSAGE PAYLOAD:",
    JSON.stringify(brief.sampleMessagePayload, null, 2)
  ];
  roomConnectBriefEl.textContent = lines.join("\n");
}

function setMeta(text) {
  roomMetaEl.textContent = text;
}

function setJoinMeta(text) {
  joinMetaEl.textContent = text;
}

function handleError(error) {
  const message = error instanceof Error ? error.message : String(error);
  setMeta(`Error: ${message}`);
}

function makeChatWindowDraggable() {
  if (!liveChatWindowEl || !chatDragHandleEl || !roomSurfaceEl) {
    return;
  }
  if (window.matchMedia("(max-width: 980px)").matches) {
    return;
  }

  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;

  chatDragHandleEl.addEventListener("pointerdown", (event) => {
    dragging = true;
    const chatRect = liveChatWindowEl.getBoundingClientRect();
    offsetX = event.clientX - chatRect.left;
    offsetY = event.clientY - chatRect.top;
    chatDragHandleEl.setPointerCapture(event.pointerId);
  });

  chatDragHandleEl.addEventListener("pointermove", (event) => {
    if (!dragging) {
      return;
    }
    const bounds = roomSurfaceEl.getBoundingClientRect();
    const width = liveChatWindowEl.offsetWidth;
    const height = liveChatWindowEl.offsetHeight;

    let nextLeft = event.clientX - bounds.left - offsetX;
    let nextTop = event.clientY - bounds.top - offsetY;
    nextLeft = clamp(nextLeft, 0, Math.max(0, bounds.width - width));
    nextTop = clamp(nextTop, 0, Math.max(0, bounds.height - height));

    liveChatWindowEl.style.left = `${nextLeft}px`;
    liveChatWindowEl.style.top = `${nextTop}px`;
    liveChatWindowEl.style.right = "auto";
  });

  function releaseDrag() {
    dragging = false;
  }
  chatDragHandleEl.addEventListener("pointerup", releaseDrag);
  chatDragHandleEl.addEventListener("pointercancel", releaseDrag);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
