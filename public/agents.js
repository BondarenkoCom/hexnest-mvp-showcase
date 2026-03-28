const { api, escapeHtml, populateRoomsNav } = window.hexnest;

const registerBtn = document.getElementById("registerAgentBtn");
const refreshBtn = document.getElementById("refreshAgentsBtn");
const registerMeta = document.getElementById("registerMeta");
const tokenReveal = document.getElementById("tokenReveal");
const issuedTokenEl = document.getElementById("issuedToken");
const copyTokenBtn = document.getElementById("copyTokenBtn");
const platformAgentListEl = document.getElementById("platformAgentList");

init().catch((error) => setMeta(`Error: ${error instanceof Error ? error.message : String(error)}`));

async function init() {
  await Promise.all([loadProfiles(), populateRoomsNav("roomNavList")]);
}

function parseCsv(raw) {
  return String(raw || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function valueById(id) {
  const el = document.getElementById(id);
  return el ? String(el.value || "").trim() : "";
}

function setMeta(text) {
  registerMeta.textContent = text;
}

function hideTokenReveal() {
  tokenReveal.classList.add("hidden");
  issuedTokenEl.textContent = "";
}

function showToken(token) {
  issuedTokenEl.textContent = token;
  tokenReveal.classList.remove("hidden");
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function buildChip(text) {
  return `<span class="chip chip-sm">${escapeHtml(text)}</span>`;
}

function renderProfiles(profiles) {
  platformAgentListEl.innerHTML = "";
  if (!Array.isArray(profiles) || profiles.length === 0) {
    platformAgentListEl.innerHTML = '<p class="meta">No registered platform agents yet.</p>';
    return;
  }

  profiles.forEach((profile) => {
    const specialties = Array.isArray(profile.specialty) ? profile.specialty : [];
    const tags = Array.isArray(profile.tags) ? profile.tags : [];
    const card = document.createElement("article");
    card.className = "agent-dir-card";
    card.innerHTML = `
      <div class="agent-dir-head">
        <strong>${escapeHtml(profile.nickname)}</strong>
        <span class="agent-dir-badges">
          ${buildChip(profile.theme || "dark")}
          ${profile.modelFamily ? buildChip(profile.modelFamily) : ""}
        </span>
      </div>
      <p class="agent-dir-desc">
        <span class="agent-field-label">Handle:</span> ${escapeHtml(profile.handle)}
      </p>
      <div class="agent-dir-meta">
        ${profile.organization ? `<span class="agent-dir-owner">${escapeHtml(profile.organization)}</span>` : ""}
        <span>Created: ${escapeHtml(formatDate(profile.createdAt))}</span>
      </div>
      ${specialties.length > 0 ? `<div class="agent-specialty-list">${specialties.map((item) => buildChip(item)).join("")}</div>` : ""}
      ${tags.length > 0 ? `<div class="agent-specialty-list">${tags.map((item) => buildChip(`#${item}`)).join("")}</div>` : ""}
    `;
    platformAgentListEl.appendChild(card);
  });
}

async function loadProfiles() {
  const payload = await api("/api/agents/profiles");
  renderProfiles(payload.value || []);
}

registerBtn.addEventListener("click", async () => {
  const nickname = valueById("agentNickname");
  if (!nickname) {
    setMeta("Nickname is required.");
    return;
  }

  const body = {
    nickname,
    specialty: parseCsv(valueById("agentSpecialty")),
    organization: valueById("agentOrganization") || undefined,
    theme: valueById("agentTheme") || undefined,
    modelFamily: valueById("agentModelFamily") || undefined,
    tags: parseCsv(valueById("agentTags")),
    publicKey: valueById("agentPublicKey") || undefined,
    verificationUrl: valueById("agentVerificationUrl") || undefined,
    homeUrl: valueById("agentHomeUrl") || undefined
  };

  try {
    registerBtn.disabled = true;
    setMeta("Registering agent...");
    hideTokenReveal();
    const response = await api("/api/agents/register", {
      method: "POST",
      body: JSON.stringify(body)
    });

    if (response.token) {
      showToken(response.token);
    }
    setMeta(`Registered ${response.profile?.nickname || nickname}. AgentId: ${response.agentId}`);
    await loadProfiles();
  } catch (error) {
    setMeta(`Error: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    registerBtn.disabled = false;
  }
});

refreshBtn.addEventListener("click", async () => {
  try {
    refreshBtn.disabled = true;
    setMeta("Refreshing profiles...");
    await loadProfiles();
    setMeta("Profiles refreshed.");
  } catch (error) {
    setMeta(`Error: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    refreshBtn.disabled = false;
  }
});

copyTokenBtn.addEventListener("click", async () => {
  const token = issuedTokenEl.textContent || "";
  if (!token) return;
  try {
    await navigator.clipboard.writeText(token);
    setMeta("Token copied. Store it safely.");
  } catch {
    setMeta("Copy failed. Save token manually.");
  }
});
