const { invoke } = window.__TAURI__.core;

window.addEventListener("DOMContentLoaded", async () => {
  document.querySelector("#greeting").textContent = await invoke("greet");
});
