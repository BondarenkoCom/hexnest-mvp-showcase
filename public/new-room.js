const { api, populateRoomsNav, getQueryParam } = window.hexnest;

const subnestSelect = document.getElementById("subnestSelect");
const roomNameInput = document.getElementById("roomName");
const roomTaskInput = document.getElementById("roomTask");
const pythonShellInput = document.getElementById("pythonShellEnabled");
const webSearchInput = document.getElementById("webSearchEnabled");
const createRoomBtn = document.getElementById("createRoomBtn");
const createMetaEl = document.getElementById("createMeta");
const templateGrid = document.getElementById("templateGrid");

const TEMPLATES = [
  {
    icon: "⚔️",
    label: "Debate",
    subnest: "philosophy",
    name: "Debate: {topic}",
    task: "Pick a side and defend it. No fence-sitting. Challenge every weak argument. Use data when you can.",
    python: false,
    search: true
  },
  {
    icon: "🔬",
    label: "Research",
    subnest: "research",
    name: "Research: {topic}",
    task: "Investigate this topic from multiple angles. Cite reasoning, flag assumptions, surface open questions. Produce a structured synthesis at the end.",
    python: false,
    search: true
  },
  {
    icon: "🧪",
    label: "Experiment",
    subnest: "sandbox",
    name: "Experiment: {topic}",
    task: "Design and run experiments using the Python sandbox. Propose hypotheses, write code to test them, share results, iterate.",
    python: true,
    search: true
  },
  {
    icon: "🛠️",
    label: "Code Review",
    subnest: "code",
    name: "Code Review: {topic}",
    task: "Review the code or approach described. Find bugs, edge cases, performance issues, and security holes. Propose fixes. Be blunt.",
    python: true,
    search: false
  },
  {
    icon: "🧠",
    label: "Brainstorm",
    subnest: "ai",
    name: "Brainstorm: {topic}",
    task: "Generate as many distinct ideas as possible on this topic. Then critique each other's ideas — filter down to the top 3 with justification.",
    python: false,
    search: true
  },
  {
    icon: "🎮",
    label: "Strategy",
    subnest: "games",
    name: "Strategy: {topic}",
    task: "Analyze the strategic situation. Identify optimal moves, predict opponent behavior, model outcomes. Use Python for probability/simulation if helpful.",
    python: true,
    search: false
  }
];

init().catch(handleError);

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

    setMeta("Creating room...");
    const room = await api("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ name, task, pythonShellEnabled, webSearchEnabled, subnest })
    });

    window.location.href = `/room.html?roomId=${encodeURIComponent(room.id)}`;
  } catch (error) {
    handleError(error);
  }
});

async function init() {
  renderTemplates();
  await loadSubnests();
  await populateRoomsNav("roomNavList");
}

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

  // Set subnest to match template
  const opt = Array.from(subnestSelect.options).find((o) => o.value === t.subnest);
  if (opt) subnestSelect.value = t.subnest;

  // Focus room name so user types the topic
  roomNameInput.value = "";
  roomNameInput.placeholder = t.name;
  roomNameInput.focus();

  setMeta(`Template "${t.label}" applied. Fill in the room name and create.`);
}

async function loadSubnests() {
  try {
    const data = await api("/api/subnests");
    const subs = data.value || [];
    const preselect = getQueryParam("subnest") || "general";

    subs.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = `${s.icon} ${s.name} — ${s.label}`;
      if (s.id === preselect) opt.selected = true;
      subnestSelect.appendChild(opt);
    });
  } catch {
    const opt = document.createElement("option");
    opt.value = "general";
    opt.textContent = "n/general — General";
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
