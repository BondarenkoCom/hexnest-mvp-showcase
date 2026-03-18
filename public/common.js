(function () {
  async function api(url, options = {}) {
    const request = {
      headers: {
        "Content-Type": "application/json"
      },
      ...options
    };

    const res = await fetch(url, request);
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  function escapeHtml(text) {
    return String(text)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  function truncate(text, size) {
    const value = String(text || "");
    if (value.length <= size) {
      return value;
    }
    return `${value.slice(0, Math.max(0, size - 3))}...`;
  }

  async function populateRoomsNav(containerId, activeRoomId) {
    const el = document.getElementById(containerId);
    if (!el) {
      return [];
    }

    el.innerHTML = "";
    const roomsData = await api("/api/rooms");
    const rooms = roomsData.value || [];

    if (rooms.length === 0) {
      const empty = document.createElement("div");
      empty.className = "room-empty";
      empty.textContent = "No rooms yet.";
      el.appendChild(empty);
      return rooms;
    }

    rooms.forEach((room) => {
      const node = document.createElement("a");
      node.className = `room-item ${room.id === activeRoomId ? "active" : ""}`;
      node.href = `/room.html?roomId=${encodeURIComponent(room.id)}`;
      node.innerHTML = `
        <span class="room-head">
          <span class="room-id">${escapeHtml(room.id.slice(0, 8))}</span>
          <span class="room-status status-${escapeHtml(room.status)}">${escapeHtml(room.status)}</span>
        </span>
        <span class="room-task">${escapeHtml(truncate(room.name || room.task, 52))}</span>
        <span class="room-phase">${escapeHtml(room.phase)}</span>
      `;
      el.appendChild(node);
    });

    return rooms;
  }

  function getQueryParam(name) {
    const url = new URL(window.location.href);
    return url.searchParams.get(name);
  }

  window.hexnest = {
    api,
    escapeHtml,
    truncate,
    populateRoomsNav,
    getQueryParam
  };
})();
