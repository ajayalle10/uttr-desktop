/**
 * Uttr Desktop — settings
 *
 * Settings are saved as a small JSON file in the app's own data folder:
 *   Windows: C:\Users\<you>\AppData\Roaming\Uttr\settings.json
 *
 * Every feature reads its value from here instead of hard-coding it, so the
 * Settings window only has to change a value and save. For example,
 * the activation shortcut is `settings.shortcut`, not a fixed Ctrl+Alt+R.
 */

const { app } = require("electron");
const fs = require("fs");
const path = require("path");

const DEFAULT_SETTINGS = Object.freeze({
  // The activation shortcut, in Electron's "accelerator" format.
  // "CommandOrControl" means Ctrl on Windows and Cmd on Mac.
  shortcut: "CommandOrControl+Alt+R",
  rate: 1.0, // speech speed: 0.5 (slow) to 2 (fast)
  voiceURI: "", // "" means "use the system default voice"
});

// app.getPath("userData") is the per-user folder Electron gives each app.
const settingsFile = () => path.join(app.getPath("userData"), "settings.json");

/**
 * Read saved settings. Anything missing (e.g. on first launch, or a setting
 * added in a newer version) falls back to its default.
 */
function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    return { ...DEFAULT_SETTINGS, ...saved };
  } catch {
    // No file yet (first run) or it's unreadable: start from defaults.
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Merge `changes` into the saved settings and write them to disk.
 * Returns the full, updated settings.
 */
function saveSettings(changes) {
  const updated = { ...loadSettings(), ...changes };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(updated, null, 2));
  return updated;
}

module.exports = { DEFAULT_SETTINGS, loadSettings, saveSettings };
