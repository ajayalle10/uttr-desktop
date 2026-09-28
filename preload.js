/**
 * Uttr Desktop — preload script (the "safe bridge")
 *
 * Runs inside a window just before its page loads. Because of
 * contextIsolation, the page itself can't touch Node.js or Electron — which
 * keeps it safe even though it handles text copied from other apps.
 *
 * contextBridge exposes a tiny, explicit API on `window.uttr`. The page can
 * use only these functions, nothing else.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("uttr", {
  // ---- Main process -> bar ----
  // "Read this": callback receives { text, rate, voiceURI }.
  onSpeak: (callback) => ipcRenderer.on("speak", (_event, payload) => callback(payload)),
  // "Stop reading" (Esc, the shortcut pressed again, or the tray menu).
  onStop: (callback) => ipcRenderer.on("stop", () => callback()),
  // "Show this short message", e.g. "Select some text first".
  onMessage: (callback) => ipcRenderer.on("message", (_event, text) => callback(text)),

  // ---- Bar -> main process ----
  // The bar's state changed: "idle" | "speaking" | "paused" | "message".
  sendState: (state) => ipcRenderer.send("state", state),
  // The user changed speed with the Speed button (main saves it).
  sendRate: (rate) => ipcRenderer.send("rate", rate),
  // The slide-out animation finished; the window can be hidden.
  sendHidden: () => ipcRenderer.send("hidden"),
});
