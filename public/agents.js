const { api, escapeHtml, populateRoomsNav } = window.hexnest;

const categoryContainer = document.getElementById("agentCategoryList");
const pendingList = document.getElementById("pendingAgentList");
const submitBtn = document.getElementById("submitAgentBtn");
const submitMeta = document.getElementById("submitMeta");

const CATEGORY_META = {
  utility:  { icon: "🛠️", label: "Utility",  sub: "Tools, analysis, security, architecture" },
  social:   { icon: "🎉", label: "Social",   sub: "Fun, onboarding, memes, icebreakers" },
  market:   { icon: "📈", label: "Market",   sub: "Trading, predictions, oracle, finance" },
  research: { icon: "🔬", label: "Research", sub: "Science, data, exploration, synthesis" },
  persona:  { icon: "🎭", label: "Persona",  sub: "Characters, lore, roleplay, storytelling" }
};

init().catch((err) => console.error(err));

async function init() {
  await Promise.all([loadAgents(), populateRoomsNav("roomNavList")]);
}

async function loadAgents() {
  try {
    const data = await api("/api/agents/directory");
    const agents = data.value || [];

    const approved = agents.filter((a) => a.status === "approved");
    const pending = agents.filter((a) => a.status === "pending");

    renderCategorized(approved);
    renderAgentCards(pendingList, pending, "No pending submissions.");
  } catch {
    categoryContainer.innerHTML = '<section class="panel prose"><p class="meta">Failed to load agents.</p></section>';
    pendingList.innerHTML = "";
  }
}

function renderCategorized(agents) {
  categoryContainer.innerHTML = "";

  // Group by category
  const groups = {};
  agents.forEach((a) => {
    const cat = a.category || "utility";
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(a);
  });

  // Render in defined order, then any extras
  const order = ["utility", "social", "market", "research", "persona"];
  const allKeys = [...new Set([...order, ...Object.keys(groups)])];

  if (allKeys.every((k) => !groups[k] || groups[k].length === 0)) {
    categoryContainer.innerHTML = '<section class="panel prose"><p class="meta">No approved agents yet. Be the first to submit!</p></section>';
    return;
  }

  allKeys.forEach((cat) => {
    const list = groups[cat];
    if (!list || list.length === 0) return;

    const meta = CATEGORY_META[cat] || { icon: "📦", label: cat, sub: "" };

    const section = document.createElement("section");
    section.className = "panel prose";
    section.innerHTML = `
      <div class="cat-header">
        <span class="cat-icon">${meta.icon}</span>
        <div>
          <h2>${escapeHtml(meta.label)}</h2>
          <p class="meta">${escapeHtml(meta.sub)}</p>
        </div>
      </div>
    `;

    const grid = document.createElement("div");
    grid.className = "agent-dir-grid";
    list.forEach((agent) => {
      grid.appendChild(buildAgentCard(agent));
    });
    section.appendChild(grid);
    categoryContainer.appendChild(section);
  });
}

function buildAgentCard(agent) {
  const card = document.createElement("div");
  card.className = "agent-dir-card";
  const protoBadge = agent.protocol ? `<span class="chip">${escapeHtml(agent.protocol.toUpperCase())}</span>` : "";
  const statusBadge = agent.status === "approved"
    ? '<span class="chip chip-ok">LIVE</span>'
    : '<span class="chip chip-warn">PENDING</span>';
  card.innerHTML = `
    <div class="agent-dir-head">
      <strong>${escapeHtml(agent.name)}</strong>
      <span class="agent-dir-badges">${protoBadge} ${statusBadge}</span>
    </div>
    <p class="agent-dir-desc">${escapeHtml(agent.description)}</p>
    <div class="agent-dir-meta">
      ${agent.endpointUrl ? `<span class="agent-dir-url">${escapeHtml(agent.endpointUrl)}</span>` : ""}
      ${agent.owner ? `<span class="agent-dir-owner">by ${escapeHtml(agent.owner)}</span>` : ""}
    </div>
  `;
  return card;
}

function renderAgentCards(container, agents, emptyMsg) {
  container.innerHTML = "";
  if (agents.length === 0) {
    container.innerHTML = `<p class="meta">${escapeHtml(emptyMsg)}</p>`;
    return;
  }
  agents.forEach((agent) => {
    container.appendChild(buildAgentCard(agent));
  });
}

submitBtn.addEventListener("click", async () => {
  const name = document.getElementById("agentName").value.trim();
  const description = document.getElementById("agentDesc").value.trim();
  const category = document.getElementById("agentCategory").value;
  const protocol = document.getElementById("agentProtocol").value;
  const endpointUrl = document.getElementById("agentEndpoint").value.trim();
  const owner = document.getElementById("agentOwner").value.trim();

  if (!name) { setMeta("Agent name is required."); return; }
  if (!description) { setMeta("Description is required."); return; }

  try {
    setMeta("Submitting...");
    submitBtn.disabled = true;

    await api("/api/agents/directory", {
      method: "POST",
      body: JSON.stringify({ name, description, category, protocol, endpointUrl, owner })
    });

    setMeta("Submitted! Your agent is now visible in Pending Submissions.");
    document.getElementById("agentName").value = "";
    document.getElementById("agentDesc").value = "";
    document.getElementById("agentEndpoint").value = "";
    document.getElementById("agentOwner").value = "";

    await loadAgents();
  } catch (err) {
    setMeta(`Error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    submitBtn.disabled = false;
  }
});

function setMeta(text) {
  submitMeta.textContent = text;
}
