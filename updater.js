/**
 * Uttr Desktop — automatic updates
 *
 * How it works (electron-updater):
 *  1. Every release on GitHub (github.com/ajayalle10/uttr-desktop/releases)
 *     includes a small file, latest.yml, saying the newest version number.
 *  2. The installed app checks it at start-up and every few hours.
 *  3. If there's a newer version, it downloads the installer quietly in the
 *     background.
 *  4. When the user quits Uttr (or restarts their PC), the update installs
 *     itself. Next launch = new version. No website, no "download again".
 *
 * Only runs in the installed app. While developing (npm start) there's
 * nothing to update.
 */

const { app } = require("electron");
const { autoUpdater } = require("electron-updater");

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000; // every 6 hours

let readyVersion = null; // set once an update has downloaded

/**
 * Start checking for updates.
 * `notify(text)` shows a short message (Uttr's floating bar).
 * `onReady(version)` is called when an update is downloaded and waiting.
 */
function startAutoUpdates({ notify, onReady }) {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true; // download as soon as one is found
  autoUpdater.autoInstallOnAppQuit = true; // install when Uttr quits
  autoUpdater.logger = null; // its own logging dumps whole web responses; we log one line below

  autoUpdater.on("update-downloaded", (info) => {
    readyVersion = info.version;
    notify(`Uttr ${info.version} is ready — it installs when you restart Uttr`);
    onReady(info.version);
  });

  // No internet, GitHub down, etc.: just try again next time.
  autoUpdater.on("error", (error) => console.log("[Uttr] Update check failed:", error.message.split("\n")[0]));

  check();
  setInterval(check, CHECK_EVERY_MS);
}

function check() {
  return autoUpdater.checkForUpdates().catch(() => null);
}

/**
 * The tray menu's "Check for updates" item: same check, but tell the user
 * what happened, since they asked.
 */
async function checkNow(notify) {
  if (!app.isPackaged) return notify("Updates work in the installed app");
  if (readyVersion) return notify(`Uttr ${readyVersion} is ready — restart Uttr to install it`);

  notify("Checking for updates…");
  const result = await check();
  const latest = result?.updateInfo?.version;
  if (!result) notify("Couldn't check for updates — are you online?");
  else if (latest && latest !== app.getVersion()) notify(`Downloading Uttr ${latest}…`);
  else notify(`You have the latest version (${app.getVersion()})`);
}

/** Quit and install the downloaded update right now. */
function installNow() {
  autoUpdater.quitAndInstall();
}

module.exports = { startAutoUpdates, checkNow, installNow };
