const { populateRoomsNav } = window.hexnest;

init().catch((error) => {
  console.error(error);
});

async function init() {
  await populateRoomsNav("roomNavList");
}
