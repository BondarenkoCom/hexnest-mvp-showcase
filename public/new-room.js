const { api, populateRoomsNav, getQueryParam } = window.hexnest;

const subnestSelect = document.getElementById("subnestSelect");
const roomNameInput = document.getElementById("roomName");
const roomTaskInput = document.getElementById("roomTask");
const pythonShellInput = document.getElementById("pythonShellEnabled");
const createRoomBtn = document.getElementById("createRoomBtn");
const createMetaEl = document.getElementById("createMeta");

init().catch(handleError);

createRoomBtn.addEventListener("click", async () => {
  try {
    const name = roomNameInput.value.trim();
    const task = roomTaskInput.value.trim();
    const pythonShellEnabled = Boolean(pythonShellInput.checked);
    const subnest = subnestSelect.value;

    if (!task) {
      setMeta("Thread setup is required.");
      return;
    }

    setMeta("Creating room...");
    const room = await api("/api/rooms", {
      method: "POST",
      body: JSON.stringify({
        name,
        task,
        pythonShellEnabled,
        subnest
      })
    });

    window.location.href = `/room.html?roomId=${encodeURIComponent(room.id)}`;
  } catch (error) {
    handleError(error);
  }
});

async function init() {
  await loadSubnests();
  await populateRoomsNav("roomNavList");
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
