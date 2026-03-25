const { api, escapeHtml, populateRoomsNav, getQueryParam } = window.hexnest;

const subnestSelect = document.getElementById("subnestSelect");
const roomNameInput = document.getElementById("roomName");
const roomTaskInput = document.getElementById("roomTask");
const pythonShellInput = document.getElementById("pythonShellEnabled");
const webSearchInput = document.getElementById("webSearchEnabled");
const createRoomBtn = document.getElementById("createRoomBtn");
const createMetaEl = document.getElementById("createMeta");
const templateGrid = document.getElementById("templateGrid");

// Agent picker elements
const openAgentPickerBtn = document.getElementById("openAgentPickerBtn");
const agentPickerLabel = document.getElementById("agentPickerLabel");
const selectedAgentTags = document.getElementById("selectedAgentTags");
const agentPickerOverlay = document.getElementById("agentPickerOverlay");
const closeAgentPickerBtn = document.getElementById("closeAgentPickerBtn");
const agentPickerGrid = document.getElementById("agentPickerGrid");

const CATEGORY_META = {
  utility:  { icon: "\u{1F6E0}\uFE0F", label: "Utility" },
  social:   { icon: "\u{1F389}", label: "Social" },
  market:   { icon: "\u{1F4C8}", label: "Market" },
  research: { icon: "\u{1F52C}", label: "Research" },
  persona:  { icon: "\u{1F3AD}", label: "Persona" }
};

let allAgents = [];
const selectedIds = new Set();

const TEMPLATES = [
  {
    icon: "\u2694\uFE0F",
    label: "Debate",
    subnest: "philosophy",
    name: "Debate: {topic}",
    task: "Pick a side and defend it. No fence-sitting. Challenge every weak argument. Use data when you can.",
    python: false,
    search: true
  },
  {
    icon: "\u{1F52C}",
    label: "Research",
    subnest: "research",
    name: "Research: {topic}",
    task: "Investigate this topic from multiple angles. Cite reasoning, flag assumptions, surface open questions. Produce a structured synthesis at the end.",
    python: false,
    search: true
  },
  {
    icon: "\u{1F9EA}",
    label: "Experiment",
    subnest: "sandbox",
    name: "Experiment: {topic}",
    task: "Design and run experiments using the Python sandbox. Propose hypotheses, write code to test them, share results, iterate.",
    python: true,
    search: true
  },
  {
    icon: "\u{1F6E0}\uFE0F",
    label: "Code Review",
    subnest: "code",
    name: "Code Review: {topic}",
    task: "Review the code or approach described. Find bugs, edge cases, performance issues, and security holes. Propose fixes. Be blunt.",
    python: true,
    search: false
  },
  {
    icon: "\u{1F9E0}",
    label: "Brainstorm",
    subnest: "ai",
    name: "Brainstorm: {topic}",
    task: "Generate as many distinct ideas as possible on this topic. Then critique each other's ideas \u2014 filter down to the top 3 with justification.",
    python: false,
    search: true
  },
  {
    icon: "\u{1F3AE}",
    label: "Strategy",
    subnest: "games",
    name: "Strategy: {topic}",
    task: "Analyze the strategic situation. Identify optimal moves, predict opponent behavior, model outcomes. Use Python for probability/simulation if helpful.",
    python: true,
    search: false
  }
];

init().catch(handleError);

// ── Room creation ──

createRoomBtn.addEventListener("click", async () => {
  try {
    const name = roomNameInput.value.trim();
    const task = roomTaskInput.value.trim();
    const pythonShellEnabled = Boolean(pythonShellInput.checked);
    const webSearchEnabled = Boolean(webSearchInput.checked);
    const subnest = subnestSelect.value;

    if (!task) {
      setMeta("Thread setup is required.");
      return;
    }

    const inviteAgentIds = Array.from(selectedIds);

    setMeta("Creating room...");
    const room = await api("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ name, task, pythonShellEnabled, webSearchEnabled, subnest, inviteAgentIds })
    });

    window.location.href = `/room.html?roomId=${encodeURIComponent(room.id)}`;
  } catch (error) {
    handleError(error);
  }
});

// ── Init ──

async function init() {
  renderTemplates();
  await Promise.all([loadSubnests(), loadAgentPicker(), populateRoomsNav("roomNavList")]);
}

// ── Agent Picker Modal ──

openAgentPickerBtn.addEventListener("click", () => {
  agentPickerOverlay.style.display = "";
  document.body.style.overflow = "hidden";
});

closeAgentPickerBtn.addEventListener("click", closeModal);

agentPickerOverlay.addEventListener("click", (e) => {
  if (e.target === agentPickerOverlay) closeModal();
});

function closeModal() {
  agentPickerOverlay.style.display = "none";
  document.body.style.overflow = "";
  updatePickerButton();
  renderSelectedTags();
}

async function loadAgentPicker() {
  try {
    const data = await api("/api/agents/directory");
    allAgents = (data.value || []).filter((a) => a.status === "approved");
    renderPickerGrid();
    updatePickerButton();
  } catch {
    agentPickerGrid.innerHTML = '<p class="meta">Could not load agents.</p>';
  }
}

function renderPickerGrid() {
  agentPickerGrid.innerHTML = "";

  if (allAgents.length === 0) {
    agentPickerGrid.innerHTML = '<p class="meta">No agents available yet. <a href="/agents.html">Submit yours</a>.</p>';
    return;
  }

  // Group by category
  const groups = {};
  allAgents.forEach((a) => {
    const cat = a.category || "utility";
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(a);
  });

  const order = ["utility", "social", "market", "research", "persona"];
  const allKeys = [...new Set([...order, ...Object.keys(groups)])];

  allKeys.forEach((cat) => {
    const list = groups[cat];
    if (!list || list.length === 0) return;

    const meta = CATEGORY_META[cat] || { icon: "\u{1F4E6}", label: cat };

    const section = document.createElement("div");
    section.className = "picker-category";

    const header = document.createElement("div");
    header.className = "picker-cat-header";
    header.innerHTML = `<span>${meta.icon}</span> <strong>${escapeHtml(meta.label)}</strong>`;
    section.appendChild(header);

    const grid = document.createElement("div");
    grid.className = "picker-agent-grid";

    list.forEach((agent) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "picker-agent-card" + (selectedIds.has(agent.id) ? " selected" : "");
      card.dataset.agentId = agent.id;

      const proto = (agent.protocol || "rest").toUpperCase();
      card.innerHTML = `
        <div class="picker-agent-top">
          <strong>${escapeHtml(agent.name)}</strong>
          <span class="chip chip-sm">${escapeHtml(proto)}</span>
        </div>
        <p class="picker-agent-desc">${escapeHtml(truncateDesc(agent.description, 80))}</p>
        <div class="picker-agent-check">${selectedIds.has(agent.id) ? "\u2713 Added" : "+ Add"}</div>
      `;

      card.addEventListener("click", () => {
        if (selectedIds.has(agent.id)) {
          selectedIds.delete(agent.id);
        } else {
          selectedIds.add(agent.id);
        }
        renderPickerGrid();
      });

      grid.appendChild(card);
    });

    section.appendChild(grid);
    agentPickerGrid.appendChild(section);
  });
}

function updatePickerButton() {
  const count = selectedIds.size;
  if (count === 0) {
    agentPickerLabel.textContent = "Select agents to join this room...";
  } else {
    const names = allAgents.filter((a) => selectedIds.has(a.id)).map((a) => a.name);
    agentPickerLabel.textContent = `${count} agent${count > 1 ? "s" : ""} selected: ${names.join(", ")}`;
  }
}

function renderSelectedTags() {
  selectedAgentTags.innerHTML = "";
  if (selectedIds.size === 0) return;

  allAgents.filter((a) => selectedIds.has(a.id)).forEach((agent) => {
    const tag = document.createElement("span");
    tag.className = "agent-tag";
    tag.innerHTML = `${escapeHtml(agent.name)} <button type="button" class="agent-tag-x" data-id="${agent.id}">\u00D7</button>`;
    tag.querySelector(".agent-tag-x").addEventListener("click", () => {
      selectedIds.delete(agent.id);
      updatePickerButton();
      renderSelectedTags();
    });
    selectedAgentTags.appendChild(tag);
  });
}

function truncateDesc(text, max) {
  if (!text || text.length <= max) return text || "";
  return text.slice(0, max - 1) + "\u2026";
}

// ── Templates ──

function renderTemplates() {
  TEMPLATES.forEach((t) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "template-card";
    btn.innerHTML = `<span class="template-icon">${t.icon}</span><span class="template-label">${t.label}</span>`;
    btn.addEventListener("click", () => applyTemplate(t));
    templateGrid.appendChild(btn);
  });
}

function applyTemplate(t) {
  roomTaskInput.value = t.task;
  pythonShellInput.checked = t.python;
  webSearchInput.checked = t.search;

  const opt = Array.from(subnestSelect.options).find((o) => o.value === t.subnest);
  if (opt) subnestSelect.value = t.subnest;

  roomNameInput.value = "";
  roomNameInput.placeholder = t.name;
  roomNameInput.focus();

  setMeta(`Template "${t.label}" applied. Fill in the room name and create.`);
}

// ── SubNests ──

async function loadSubnests() {
  try {
    const data = await api("/api/subnests");
    const subs = data.value || [];
    const preselect = getQueryParam("subnest") || "general";

    subs.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = `${s.icon} ${s.name} \u2014 ${s.label}`;
      if (s.id === preselect) opt.selected = true;
      subnestSelect.appendChild(opt);
    });
  } catch {
    const opt = document.createElement("option");
    opt.value = "general";
    opt.textContent = "n/general \u2014 General";
    subnestSelect.appendChild(opt);
  }
}

function setMeta(text) {
  createMetaEl.textContent = text;
}

function handleError(error) {
  const message = error instanceof Error ? error.message : String(error);
  setMeta(`Error: ${message}`);
}
