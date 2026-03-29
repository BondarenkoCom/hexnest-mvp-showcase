const { api, populateRoomsNav, escapeHtml } = window.hexnest;

const LOG_REFRESH_MS = 10000;
const MATRIX_LIMIT = 10;
const RADAR_BLIP_LIMIT = 18;

init().catch((error) => {
  console.error(error);
});

async function init() {
  await Promise.all([
    populateRoomsNav("roomNavList"),
    refreshScanner()
  ]);
  setInterval(() => {
    void refreshScanner();
  }, LOG_REFRESH_MS);
}

async function refreshScanner() {
  try {
    const [statusRes, candidatesRes, logsRes] = await Promise.all([
      api("/api/discovery/status"),
      api("/api/discovery/candidates"),
      api("/api/discovery/logs?limit=220")
    ]);

    const candidates = Array.isArray(candidatesRes.value) ? candidatesRes.value : [];
    const logs = Array.isArray(logsRes.value) ? logsRes.value : [];

    renderTopState(statusRes, candidates, logs);
    renderRadar(candidates);
    renderLogs(logs);
    renderCandidates(candidates);
  } catch (error) {
    renderError(error instanceof Error ? error.message : String(error));
  }
}

function renderTopState(statusRes, candidates, logs) {
  const found = candidates.length;
  const contacted = logs.filter((item) =>
    item.type === "candidate.contact_queued" ||
    item.type === "candidate.status_changed"
  ).length;
  const responded = logs.filter((item) => item.type === "probe.responded").length;
  const queue = candidates.filter((item) => item.status === "qualified").length;
  const qualified = candidates.filter((item) =>
    item.status === "qualified" || item.status === "approved" || item.status === "connected"
  ).length;
  const outreach = candidates.filter((item) =>
    item.status === "approved" || item.status === "connected"
  ).length;

  setText("scanFound", String(found));
  setText("scanContacted", String(contacted));
  setText("scanResponded", String(responded));
  setText("scanQueue", String(queue));
  setText("phaseDiscoveryValue", String(found));
  setText("phaseQualificationValue", String(qualified));
  setText("phaseOutreachValue", String(outreach));
  setText("scanState", statusRes.running ? "SCANNING" : "ONLINE");

  if (statusRes.lastRun?.finishedAt) {
    setText("scanLastRun", `Last run: ${formatTime(statusRes.lastRun.finishedAt)}`);
  } else {
    setText("scanLastRun", "No runs yet");
  }
}

function renderLogs(logs) {
  const el = document.getElementById("scanLogFeed");
  if (!el) return;

  if (!logs.length) {
    el.innerHTML = `<div class="scan-log-line level-warn">[WAIT] No discovery logs yet.</div>`;
    return;
  }

  const lines = logs.slice(-120).reverse().map((item) => {
    const level = item.level === "error" ? "level-error" : item.level === "warn" ? "level-warn" : "level-info";
    const ts = formatTime(item.timestamp);
    const source = item.source ? `[${escapeHtml(item.source)}]` : "";
    const candidate = item.candidateId ? `<span class="scan-log-candidate">${escapeHtml(item.candidateId)}</span>` : "";
    return `
      <div class="scan-log-line ${level}">
        <span class="scan-log-time">${escapeHtml(ts)}</span>
        <span class="scan-log-type">${escapeHtml(item.type || "event")}</span>
        <span class="scan-log-source">${source}</span>
        <span class="scan-log-summary">${escapeHtml(item.summary || "")}</span>
        ${candidate}
      </div>
    `;
  });

  el.innerHTML = lines.join("");
}

function renderCandidates(candidates) {
  const el = document.getElementById("scanCandidateList");
  const meta = document.getElementById("scanCandidateMeta");
  if (!el) return;

  if (!candidates.length) {
    el.innerHTML = `<div class="scan-candidate-empty">No candidates discovered yet.</div>`;
    if (meta) meta.textContent = "Top 10 by trust score";
    return;
  }

  const hidden = Math.max(0, candidates.length - MATRIX_LIMIT);
  if (meta) {
    meta.textContent = hidden > 0 ? `Top 10 by trust score (+${hidden} hidden)` : "Top 10 by trust score";
  }

  const rows = candidates.slice(0, MATRIX_LIMIT).map((item) => {
    const scoreClass = item.trustScore >= 80 ? "score-high" : item.trustScore >= 60 ? "score-mid" : "score-low";
    const protocols = Array.isArray(item.protocols) ? item.protocols.join(", ") : "";
    const caps = Array.isArray(item.capabilities) ? item.capabilities.slice(0, 3).join(" | ") : "";
    const endpoint = item.endpointUrl || item.homepageUrl || "n/a";
    return `
      <article class="scan-candidate-row">
        <div class="scan-candidate-main">
          <h3>${escapeHtml(item.title || "Unknown candidate")}</h3>
          <p class="scan-candidate-desc">${escapeHtml(item.description || "No description")}</p>
          <p class="scan-candidate-endpoint">${escapeHtml(endpoint)}</p>
        </div>
        <div class="scan-candidate-meta">
          <span class="scan-candidate-score ${scoreClass}">${escapeHtml(String(item.trustScore || 0))}</span>
          <span class="scan-candidate-badge">${escapeHtml(item.status || "new")}</span>
          <span class="scan-candidate-badge">${escapeHtml(item.joinability || "unknown")}</span>
          <span class="scan-candidate-proto">${escapeHtml(protocols)}</span>
          <span class="scan-candidate-caps">${escapeHtml(caps)}</span>
        </div>
      </article>
    `;
  });

  el.innerHTML = rows.join("");
}

function renderRadar(candidates) {
  const el = document.getElementById("scannerBlips");
  if (!el) return;

  const rows = candidates.slice(0, RADAR_BLIP_LIMIT).map((candidate) => {
    const trust = Math.max(0, Math.min(100, Number(candidate.trustScore) || 0));
    const angle = hashToUnit(candidate.id, 17) * Math.PI * 2;
    const jitter = hashToUnit(candidate.id, 39);
    const radius = 14 + ((100 - trust) / 100) * 31 + jitter * 4;
    const x = 50 + Math.cos(angle) * radius;
    const y = 50 + Math.sin(angle) * radius;
    const size = trust >= 80 ? 9 : trust >= 60 ? 7 : 6;
    const levelClass = trust >= 80 ? "high" : trust >= 60 ? "mid" : "low";
    const activeClass = candidate.status === "connected" ? "active" : "";
    const style = `left:${x.toFixed(2)}%;top:${y.toFixed(2)}%;width:${size}px;height:${size}px;`;
    const title = escapeHtml(`${candidate.title} (${trust})`);
    return `<span class="scanner-blip ${levelClass} ${activeClass}" style="${style}" title="${title}"></span>`;
  });

  el.innerHTML = rows.join("");
}

function renderError(message) {
  setText("scanState", "ERROR");
  const logs = document.getElementById("scanLogFeed");
  if (logs) {
    logs.innerHTML = `<div class="scan-log-line level-error">[ERROR] ${escapeHtml(message)}</div>`;
  }
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = value;
  }
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || "");
  return date.toISOString().replace("T", " ").replace("Z", "Z");
}

function hashToUnit(value, salt) {
  const input = `${String(value || "")}:${salt}`;
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash % 10000) / 10000;
}
