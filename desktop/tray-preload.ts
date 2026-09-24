// This preload has no backend bridge. Only the two fixed buttons can send actions.
import { ipcRenderer } from "electron";

window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("open-main")?.addEventListener("click", () => {
    ipcRenderer.send("pi-desktop:tray-action", "open");
  });
  document.getElementById("quit-app")?.addEventListener("click", () => {
    ipcRenderer.send("pi-desktop:tray-action", "quit");
  });
});
