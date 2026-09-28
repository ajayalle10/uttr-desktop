/**
 * Uttr Desktop — Settings window preload (its own "safe bridge")
 *
 * Each window gets only the functions it needs. The bar can't change
 * settings, and this window can't make the bar speak arbitrary text; it can
 * only do the settings-related things listed here.
 *
 * ipcRenderer.invoke() sends a request to main.js and waits for its answer
 * (a Promise), like calling a function in the other process.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("uttrSettings", {
  // Current settings + extra info (platform, version, start-with-Windows).
  load: () => ipcRenderer.invoke("settings:load"),
  // Save some settings, e.g. save({ rate: 1.5 }). Resolves with all settings.
  save: (changes) => ipcRenderer.invoke("settings:save", changes),

  // Shortcut recording. While recording, the current global shortcut is
  // switched off, so pressing it types into the recorder instead of reading.
  startRecording: () => ipcRenderer.invoke("shortcut:start-recording"),
  stopRecording: () => ipcRenderer.invoke("shortcut:stop-recording"),
  // Try a new shortcut. Resolves with { ok: true, settings } or { ok: false, error }.
  setShortcut: (accelerator) => ipcRenderer.invoke("shortcut:set", accelerator),

  setStartWithWindows: (enabled) => ipcRenderer.invoke("settings:start-with-windows", enabled),
  testVoice: () => ipcRenderer.invoke("settings:test-voice"),

  // Settings changed elsewhere (e.g. the bar's speed button).
  onChanged: (callback) => ipcRenderer.on("settings:changed", (_event, settings) => callback(settings)),
});
