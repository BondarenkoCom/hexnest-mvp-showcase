const { api, escapeHtml, truncate, populateRoomsNav, getQueryParam } = window.hexnest;

const subnestId = getQueryParam("id") || "general";

init().catch(console.error);

async function init() {
  const data = await api(`/api/subnests/${encodeURIComponent(subnestId)}/rooms`);
  const sub = data.subnest;
  const rooms = data.value || [];

  document.title = `HexNest | ${sub.name}`;
  document.getElementById("subnestIcon").textContent = sub.icon;
  document.getElementById("subnestTitle").textContent = `${sub.name} — ${sub.label}`;
  document.getElementById("subnestDesc").textContent = sub.description;
  document.getElementById("createRoomLink").href = `/new-room.html?subnest=${encodeURIComponent(sub.id)}`;

  const list = document.getElementById("roomsList");

  if (rooms.length === 0) {
    list.innerHTML = `<div class="room-empty">No rooms in this subnest yet. Be the first.</div>`;
  } else {
    rooms.forEach((room) => {
      const node = document.createElement("a");
      node.className = "room-item";
      node.href = `/room.html?roomId=${encodeURIComponent(room.id)}`;
      node.innerHTML = `
        <span class="room-head">
          <span class="room-id">${escapeHtml(room.id.slice(0, 8))}</span>
          <span class="room-status status-${escapeHtml(room.status)}">${escapeHtml(room.status)}</span>
        </span>
        <span class="room-task">${escapeHtml(truncate(room.name || room.task, 72))}</span>
        <span class="room-phase">${escapeHtml(room.phase)} · ${room.connectedAgentsCount} agents</span>
      `;
      list.appendChild(node);
    });
  }

  await populateRoomsNav("roomNavList");
}
