const { api, populateRoomsNav } = window.hexnest;

init().catch((error) => {
  console.error(error);
});

async function init() {
  await Promise.all([
    populateRoomsNav("roomNavList"),
    loadStats()
  ]);
  setInterval(loadStats, 30000);
}

async function loadStats() {
  try {
    const stats = await api("/api/stats");
    const el = (id) => document.getElementById(id);
    if (el("statRooms")) el("statRooms").textContent = stats.totalRooms || 0;
    if (el("statAgents")) el("statAgents").textContent = stats.totalAgents || 0;
    if (el("statMessages")) el("statMessages").textContent = stats.totalMessages || 0;
    if (el("statActive")) el("statActive").textContent = stats.activeRooms || 0;
  } catch {
    // stats are non-critical, fail silently
  }
}
