/**
 * Uttr Desktop — main process (the "brain")
 *
 * An Electron app has two kinds of processes:
 *
 *  - The MAIN process (this file) runs in Node.js. It has no visible page,
 *    but it can do "operating system" things: tray icons, global keyboard
 *    shortcuts, the clipboard, creating windows.
 *
 *  - RENDERER processes are the windows. Each one is basically a Chrome tab
 *    showing an HTML page. Uttr has two: the floating bar (which does the
 *    speaking) and the Settings window.
 *
 * They talk by sending messages (IPC = inter-process communication).
 */

const { app, BrowserWindow, Tray, Menu, globalShortcut, nativeImage, nativeTheme, dialog, ipcMain, screen } = require("electron");
const path = require("path");
const { uIOhook, UiohookKey } = require("uiohook-napi");
const { loadSettings, saveSettings, DEFAULT_SETTINGS } = require("./settings");
const { grabSelectedText } = require("./selection");
const shortcuts = require("./shared/shortcut");
const updater = require("./updater");

// For automated tests: run a separate copy of Uttr with its own settings
// folder (and therefore its own single-instance lock), so it doesn't clash
// with the copy the user has running. Normal users never set this.
if (process.env.UTTR_TEST_PROFILE) app.setPath("userData", process.env.UTTR_TEST_PROFILE);

// On Windows, the taskbar groups an app's windows by this ID.
//
// Only set it in the INSTALLED app. There, the installer's Start-menu
// shortcut links this ID to Uttr's icon. While developing there's no such
// shortcut, and setting the ID would make Windows fall back to electron.exe's
// icon on the taskbar. Without it, Windows uses each window's own icon (our logo).
//
// Don't override the taskbar icon with win.setAppDetails({ appIconPath }).
// v0.1.0 did, pointing into app.asar (which Windows can't read): the taskbar
// showed a blank page, and Windows remembered that blank for this ID. The
// shortcut's icon (Uttr.exe) is already correct on its own.
const APP_ID = "com.ajayalle.uttr";
if (app.isPackaged) app.setAppUserModelId(APP_ID);

// Size of the bar window. The visible pill is 372x56; the extra room is
// for its shadow.
const BAR_WIDTH = 392;
const BAR_HEIGHT = 76;
// Gap between the bar and the bottom of the screen (above the taskbar).
const BAR_BOTTOM_MARGIN = 24;

// Windows uses .ico files: one file holding the logo at several sizes
// (16-256 px), so it's sharp on the taskbar, in Alt+Tab and in the tray at
// any display scaling. Other systems use the PNG.
const ICON_PATH = path.join(__dirname, "assets", process.platform === "win32" ? "icon.ico" : "icon.png");

let settings;
let tray = null; // kept in a variable so it isn't garbage-collected (which would remove the icon)
let barWindow = null;
let settingsWindow = null;

// What the bar is doing: "idle" | "speaking" | "paused" | "message".
// The bar reports every change (see the "state" message below).
let barState = "idle";
// The text currently being read, so pressing the shortcut again on the same
// selection means "stop" rather than "start over".
let currentText = "";

/** "CommandOrControl+Alt+R" -> "Ctrl + Alt + R" (on this computer's OS). */
const prettyShortcut = (accelerator) => shortcuts.prettyShortcut(accelerator, process.platform);

// ---------------------------------------------------------------------------
// Only one copy of Uttr at a time
// ---------------------------------------------------------------------------

// If Uttr is already running, a second copy would fight over the shortcut.
// requestSingleInstanceLock() returns false in the second copy.
const isFirstCopy = app.requestSingleInstanceLock();

if (!isFirstCopy) {
  // app.quit() takes a moment; the startup code at the bottom of this file
  // also checks isFirstCopy, so this copy does nothing else in the meantime.
  app.quit();
}

// In the copy that's already running: someone started Uttr again (e.g. from
// the Start menu). The most useful response is to open Settings.
app.on("second-instance", () => openSettings());

// ---------------------------------------------------------------------------
// The floating bar
// ---------------------------------------------------------------------------

function createBarWindow() {
  barWindow = new BrowserWindow({
    width: BAR_WIDTH,
    height: BAR_HEIGHT,
    show: false,
    frame: false, // no title bar or borders
    transparent: true, // see-through background, so only the pill shows
    resizable: false,
    movable: false,
    skipTaskbar: true, // no taskbar button
    alwaysOnTop: true,
    hasShadow: false, // the pill draws its own shadow in CSS
    // IMPORTANT: the bar must never take keyboard focus away from the app
    // the user is working in. Otherwise the next Ctrl+Alt+R would try to
    // copy from the bar instead of from their document.
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      // Security best practice: the page can't use Node.js directly; it can
      // only use the small set of functions preload.js exposes.
      contextIsolation: true,
      nodeIntegration: false,
      // Browsers only allow audio after the user clicks on the page. The bar
      // starts speaking without a click, so allow it.
      autoplayPolicy: "no-user-gesture-required",
      // Keep full speed even while the window is hidden.
      backgroundThrottling: false,
    },
  });
  // "screen-saver" is the highest level, so the bar floats above everything,
  // including full-screen apps.
  barWindow.setAlwaysOnTop(true, "screen-saver");
  barWindow.loadFile(path.join(__dirname, "bar", "bar.html"));
}

/**
 * Put the bar at the bottom-centre of the screen the mouse is on (so it
 * appears where the user is looking on multi-monitor setups), then show it
 * WITHOUT focusing it.
 */
function showBar() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const area = display.workArea; // the screen minus the taskbar
  barWindow.setBounds({
    x: Math.round(area.x + (area.width - BAR_WIDTH) / 2),
    y: Math.round(area.y + area.height - BAR_HEIGHT - BAR_BOTTOM_MARGIN),
    width: BAR_WIDTH,
    height: BAR_HEIGHT,
  });
  barWindow.showInactive(); // "Inactive" = show, but don't steal focus
}

/** Read `text` aloud in the bar. */
function speak(text) {
  currentText = text;
  showBar();
  barWindow.webContents.send("speak", { text, rate: settings.rate, voiceURI: settings.voiceURI });
}

function stopReading() {
  barWindow.webContents.send("stop");
}

/** Show a short message in the bar, e.g. "Select some text first". */
function showMessage(text) {
  showBar();
  barWindow.webContents.send("message", text);
}

// ---- Messages from the bar ----

ipcMain.on("state", (_event, state) => {
  barState = state;
  if (state === "idle") currentText = "";
  // Listen for Esc only while something is on screen (see below).
  if (state === "idle") stopEscListener();
  else startEscListener();
});

// The user changed speed in the bar: remember it, and update Settings if open.
ipcMain.on("rate", (_event, rate) => {
  updateSettings({ rate });
});

// The bar finished sliding out: hide the window.
ipcMain.on("hidden", () => {
  if (barState === "idle") barWindow.hide();
});

// ---------------------------------------------------------------------------
// Esc to stop
// ---------------------------------------------------------------------------

/**
 * Esc should stop Uttr from ANY app. We can't register Esc as a global
 * shortcut: that would take Esc away from every other app (e.g. closing
 * dialogs) while Uttr runs. Instead we briefly LISTEN to the keyboard with
 * uiohook, which lets the key through to the app as normal, and only while
 * the bar is showing. We only ever look for Esc; other keys are ignored.
 */
let escListening = false;

function onGlobalKeydown(event) {
  if (event.keycode === UiohookKey.Escape) stopReading();
}

function startEscListener() {
  if (escListening) return;
  uIOhook.on("keydown", onGlobalKeydown);
  uIOhook.start();
  escListening = true;
}

function stopEscListener() {
  if (!escListening) return;
  uIOhook.off("keydown", onGlobalKeydown);
  uIOhook.stop();
  escListening = false;
}

// ---------------------------------------------------------------------------
// The activation shortcut
// ---------------------------------------------------------------------------

// True while we're in the middle of grabbing text. Holding the shortcut down
// makes Windows repeat it; this stops those repeats from starting extra grabs.
let grabbing = false;

/**
 * What happens when the user presses the shortcut:
 *  - new text selected          -> read it (interrupting anything playing)
 *  - reading, and no new text   -> stop (the shortcut works as a toggle)
 *  - nothing selected           -> a short hint in the bar
 */
async function onShortcut() {
  if (grabbing) return;
  grabbing = true;

  try {
    const text = await grabSelectedText();
    const isReading = barState === "speaking" || barState === "paused";

    if (isReading && (!text || text === currentText)) {
      stopReading();
    } else if (text) {
      speak(text);
    } else {
      showMessage("Select some text first");
    }
  } finally {
    grabbing = false;
  }
}

/**
 * Make `accelerator` the one global shortcut. "Global" means it works even
 * when Uttr isn't the focused app — that's what lets it work anywhere.
 * Returns false if it couldn't be registered (usually because another app
 * or Windows already owns that key combination).
 */
function registerShortcut(accelerator) {
  globalShortcut.unregisterAll();
  let ok = false;
  try {
    ok = globalShortcut.register(accelerator, onShortcut);
  } catch {
    ok = false; // an accelerator Electron doesn't understand
  }
  console.log(`[Uttr] Shortcut ${accelerator}: ${ok ? "registered" : "FAILED"}`);
  return ok;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Save changes, and let the Settings window (if open) show them. */
function updateSettings(changes) {
  settings = saveSettings(changes);
  if (settingsWindow) settingsWindow.webContents.send("settings:changed", settings);
  return settings;
}

/**
 * "Start with Windows" is stored by Windows itself (a login item), not in
 * our settings file. Installed, it's an entry named "Uttr" pointing at
 * Uttr.exe (the uninstaller removes it; see build/installer.nsh). While
 * developing, Uttr runs as "electron.exe <folder>", so we pass that along.
 */
function loginItemOptions() {
  return app.isPackaged ? { name: "Uttr" } : { path: process.execPath, args: [app.getAppPath()] };
}

function getStartWithWindows() {
  return app.getLoginItemSettings(loginItemOptions()).openAtLogin;
}

function openSettings() {
  // Only ever one Settings window: if it's open, bring it to the front.
  if (settingsWindow) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 440,
    height: 610,
    useContentSize: true, // width/height are for the page, not including the title bar
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "Uttr Settings",
    icon: ICON_PATH,
    show: false, // shown once the page is ready, so it doesn't flash white
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1b1a17" : "#f4f1ea",
    webPreferences: {
      preload: path.join(__dirname, "settings-window", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWindow.removeMenu(); // no File/Edit/View menu bar

  settingsWindow.loadFile(path.join(__dirname, "settings-window", "settings-window.html"));
  settingsWindow.once("ready-to-show", () => settingsWindow.show());

  settingsWindow.on("closed", () => {
    settingsWindow = null;
    // If the window closed mid-recording, switch the shortcut back on.
    if (recordingShortcut) {
      recordingShortcut = false;
      registerShortcut(settings.shortcut);
    }
  });
}

// True while the Settings window is recording a new shortcut.
let recordingShortcut = false;

// ---- Requests from the Settings window (see settings-window/preload.js) ----
// ipcMain.handle() answers ipcRenderer.invoke(): whatever we return is sent
// back to the window as the result of its Promise.

ipcMain.handle("settings:load", () => ({
  settings,
  platform: process.platform,
  version: app.getVersion(),
  startWithWindows: getStartWithWindows(),
}));

ipcMain.handle("settings:save", (_event, changes) => {
  // Never trust input blindly, even from our own window: only accept the
  // settings we expect, with sensible values.
  const clean = {};
  if (Number.isFinite(changes.rate)) clean.rate = Math.min(2, Math.max(0.5, Math.round(changes.rate * 100) / 100));
  if (typeof changes.voiceURI === "string") clean.voiceURI = changes.voiceURI;
  return updateSettings(clean);
});

ipcMain.handle("shortcut:start-recording", () => {
  // Switch the shortcut off, so pressing it types into the recorder instead.
  recordingShortcut = true;
  globalShortcut.unregisterAll();
});

ipcMain.handle("shortcut:stop-recording", () => {
  recordingShortcut = false;
  registerShortcut(settings.shortcut);
});

ipcMain.handle("shortcut:set", (_event, accelerator) => {
  if (!shortcuts.isValidAccelerator(accelerator)) {
    return { ok: false, error: "That isn't a valid shortcut." };
  }

  // Try the new one. If Windows or another app already owns it, the
  // registration fails and we put the old shortcut back.
  if (!registerShortcut(accelerator)) {
    if (!recordingShortcut) registerShortcut(settings.shortcut);
    else globalShortcut.unregisterAll();
    return {
      ok: false,
      error: `${prettyShortcut(accelerator)} is already used by another app or by Windows. Try a different one.`,
    };
  }

  updateSettings({ shortcut: accelerator });
  updateTray(); // the menu and tooltip show the shortcut
  // While still recording, keep it switched off until recording stops.
  if (recordingShortcut) globalShortcut.unregisterAll();
  return { ok: true, settings };
});

ipcMain.handle("settings:start-with-windows", (_event, enabled) => {
  app.setLoginItemSettings({ openAtLogin: Boolean(enabled), ...loginItemOptions() });
  return getStartWithWindows(); // report what Windows actually has now
});

ipcMain.handle("settings:test-voice", () => {
  speak("Hello from Uttr. This is how I sound.");
});

// ---------------------------------------------------------------------------
// Tray icon (the icon near the clock)
// ---------------------------------------------------------------------------

function createTray() {
  // With the .ico, Windows picks the right size itself (e.g. 24px at 150% scaling).
  let icon = nativeImage.createFromPath(ICON_PATH);
  if (process.platform !== "win32") icon = icon.resize({ width: 16, height: 16, quality: "best" });
  tray = new Tray(icon);
  tray.on("click", openSettings); // left-click opens Settings (right-click shows the menu)
  updateTray();
}

// Set when an update has downloaded, to offer "Restart to update" in the menu.
let updateReadyVersion = null;

/** (Re)build the tray menu and tooltip, e.g. after the shortcut changes. */
function updateTray() {
  const shortcut = prettyShortcut(settings.shortcut);
  tray.setToolTip(`Uttr — select text, press ${shortcut}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Uttr — press ${shortcut} to read`, enabled: false },
      { type: "separator" },
      { label: "Settings…", click: openSettings },
      { label: "Test voice", click: () => speak("Hello from Uttr. I got activated.") },
      { label: "Stop reading", click: stopReading },
      { type: "separator" },
      updateReadyVersion
        ? { label: `Restart to update to ${updateReadyVersion}`, click: updater.installNow }
        : { label: "Check for updates", click: () => updater.checkNow(showMessage) },
      { label: "Quit Uttr", click: () => app.quit() },
    ])
  );
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  if (!isFirstCopy) return; // this copy is quitting (see the top of the file)

  settings = loadSettings();
  // A saved shortcut that's somehow invalid falls back to the default.
  if (!shortcuts.isValidAccelerator(settings.shortcut)) settings = saveSettings({ shortcut: DEFAULT_SETTINGS.shortcut });

  createBarWindow();
  createTray();

  if (registerShortcut(settings.shortcut)) {
    // A friendly "I'm running" hello in the bar, since a tray app has no
    // main window. Wait until the bar's page has loaded.
    barWindow.webContents.once("did-finish-load", () => {
      showMessage(`Uttr is ready — press ${prettyShortcut(settings.shortcut)}`);
    });
  } else {
    // Another app owns the shortcut: offer to pick a different one.
    const { response } = await dialog.showMessageBox({
      type: "warning",
      title: "Uttr",
      icon: nativeImage.createFromPath(ICON_PATH),
      message: `${prettyShortcut(settings.shortcut)} is already used by another app.`,
      detail: "Choose a different activation shortcut in Uttr's Settings.",
      buttons: ["Open Settings", "Later"],
      defaultId: 0,
    });
    if (response === 0) openSettings();
  }

  // Look for new versions on GitHub (installed app only; see updater.js).
  updater.startAutoUpdates({
    notify: showMessage,
    onReady: (version) => {
      updateReadyVersion = version;
      updateTray();
    },
  });
});

// Normally an app quits when its last window closes. Uttr lives in the tray,
// so keep running.
app.on("window-all-closed", (event) => event.preventDefault());

app.on("will-quit", () => {
  if (!isFirstCopy) return;
  // Release the shortcut so other apps can use it after Uttr quits.
  globalShortcut.unregisterAll();
  stopEscListener();
});
