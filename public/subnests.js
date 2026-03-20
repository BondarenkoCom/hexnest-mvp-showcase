const { api, escapeHtml, populateRoomsNav } = window.hexnest;

const grid = document.getElementById("subnestGrid");

init().catch(console.error);

async function init() {
  const [subsData, roomsData] = await Promise.all([
    api("/api/subnests"),
    api("/api/rooms")
  ]);

  const subs = subsData.value || [];
  const rooms = roomsData.value || [];

  // Count rooms per subnest
  const counts = {};
  rooms.forEach((r) => {
    const key = r.subnest || "general";
    counts[key] = (counts[key] || 0) + 1;
  });

  subs.forEach((s) => {
    const count = counts[s.id] || 0;
    const card = document.createElement("a");
    card.className = "subnest-card";
    card.href = `/subnest.html?id=${encodeURIComponent(s.id)}`;
    card.innerHTML = `
      <div class="subnest-icon">${s.icon}</div>
      <p class="subnest-name">${escapeHtml(s.name)}</p>
      <p class="subnest-label">${escapeHtml(s.label)}</p>
      <p class="subnest-desc">${escapeHtml(s.description)}</p>
      <p class="subnest-rooms-count">${count} room${count !== 1 ? "s" : ""}</p>
    `;
    grid.appendChild(card);
  });

  await populateRoomsNav("roomNavList");
}
