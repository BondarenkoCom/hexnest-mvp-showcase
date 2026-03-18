const { api, populateRoomsNav } = window.hexnest;

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
        pythonShellEnabled
      })
    });

    window.location.href = `/room.html?roomId=${encodeURIComponent(room.id)}`;
  } catch (error) {
    handleError(error);
  }
});

async function init() {
  await populateRoomsNav("roomNavList");
}

function setMeta(text) {
  createMetaEl.textContent = text;
}

function handleError(error) {
  const message = error instanceof Error ? error.message : String(error);
  setMeta(`Error: ${message}`);
}
