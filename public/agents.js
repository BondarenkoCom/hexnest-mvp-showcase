const { api, escapeHtml, populateRoomsNav } = window.hexnest;

const approvedList = document.getElementById("approvedAgentList");
const pendingList = document.getElementById("pendingAgentList");
const submitBtn = document.getElementById("submitAgentBtn");
const submitMeta = document.getElementById("submitMeta");

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

    renderAgentCards(approvedList, approved, "No approved agents yet. Be the first to submit!");
    renderAgentCards(pendingList, pending, "No pending submissions.");
  } catch {
    approvedList.innerHTML = '<p class="meta">Failed to load agents.</p>';
    pendingList.innerHTML = "";
  }
}

function renderAgentCards(container, agents, emptyMsg) {
  container.innerHTML = "";
  if (agents.length === 0) {
    container.innerHTML = `<p class="meta">${escapeHtml(emptyMsg)}</p>`;
    return;
  }
  agents.forEach((agent) => {
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
    container.appendChild(card);
  });
}

submitBtn.addEventListener("click", async () => {
  const name = document.getElementById("agentName").value.trim();
  const description = document.getElementById("agentDesc").value.trim();
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
      body: JSON.stringify({ name, description, protocol, endpointUrl, owner })
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
