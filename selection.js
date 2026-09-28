/**
 * Uttr Desktop — grab the text the user has selected in ANY app
 *
 * Windows doesn't let one app ask another "what text is selected?", so Uttr
 * does what a person would do:
 *
 *   1. Save whatever is on the clipboard right now.
 *   2. Press Ctrl+C for the user, which copies their selection.
 *   3. Read the copied text from the clipboard.
 *   4. Put the user's original clipboard back.
 *
 * The user's copy/paste is left exactly as it was, in every format.
 */

const { clipboard, ClipboardItem } = require("electron");
const { uIOhook, UiohookKey } = require("uiohook-napi");

// Longest we'll wait for the other app to finish copying. Most apps take
// under 50ms; big apps like Word can take a few hundred.
const COPY_TIMEOUT_MS = 800;
const POLL_INTERVAL_MS = 20;

const isMac = process.platform === "darwin";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Clipboard backup and restore
// ---------------------------------------------------------------------------

/**
 * Take a complete copy of the clipboard.
 *
 * The clipboard can hold the same content in several formats at once. For
 * example, text copied from Word is stored as plain text AND formatted text,
 * so it pastes nicely anywhere. clipboard.read() returns every format.
 *
 * (Electron's clipboard API is asynchronous: its functions return Promises,
 * so we use `await`.)
 */
async function backupClipboard() {
  const backup = [];
  for (const item of await clipboard.read()) {
    const formats = {};
    for (const type of item.types) {
      // Copy each format's data now, because we're about to overwrite the
      // clipboard. If one format can't be read, skip it and keep the rest.
      try {
        formats[type] = await item.getType(type);
      } catch {}
    }
    if (Object.keys(formats).length) backup.push(new ClipboardItem(formats));
  }
  return backup;
}

/** Put a backup back on the clipboard: all formats at once, like the original. */
async function restoreClipboard(backup) {
  if (backup.length) await clipboard.write(backup);
  else clipboard.clear(); // it was empty before, so leave it empty
}

// ---------------------------------------------------------------------------
// Pressing Ctrl+C for the user
// ---------------------------------------------------------------------------

/**
 * When the shortcut fires, the user is usually still holding Ctrl+Alt.
 * If we pressed C now, the app would see Ctrl+ALT+C, which isn't "copy".
 * So first we tell the system those modifier keys are released.
 *
 * Gotcha: in Windows, pressing and releasing Alt with no other key in
 * between opens the app's menu bar (try tapping Alt in Notepad). Releasing
 * Alt here would do exactly that, and our Ctrl+C would then go to the menu
 * instead of the text. Tapping a "mask" key first prevents it. F24 is a
 * real key code that keyboards don't have, so no app reacts to it.
 */
function releaseModifierKeys() {
  uIOhook.keyTap(UiohookKey.F24);

  const modifiers = [
    UiohookKey.Alt, UiohookKey.AltRight,
    UiohookKey.Shift, UiohookKey.ShiftRight,
    UiohookKey.Ctrl, UiohookKey.CtrlRight,
    UiohookKey.Meta, UiohookKey.MetaRight, // Windows key / Mac Cmd
  ];
  for (const key of modifiers) uIOhook.keyToggle(key, "up");
}

/** Press the platform's copy shortcut: Ctrl+C (Windows) or Cmd+C (Mac). */
function pressCopy() {
  uIOhook.keyTap(UiohookKey.C, [isMac ? UiohookKey.Meta : UiohookKey.Ctrl]);
}

/** Wait until the clipboard has text in it, or give up after the timeout. */
async function waitForCopiedText() {
  const deadline = Date.now() + COPY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const text = await clipboard.readText();
    if (text) return text;
    await sleep(POLL_INTERVAL_MS);
  }
  return "";
}

// ---------------------------------------------------------------------------
// The whole routine
// ---------------------------------------------------------------------------

/**
 * Returns the text currently selected in the focused app, or "" if nothing
 * is selected (or the app doesn't allow copying, like password fields).
 */
async function grabSelectedText() {
  const backup = await backupClipboard();

  // Empty the clipboard first. Then, if it has text after Ctrl+C, we know
  // that text came from the selection and not from something copied earlier.
  clipboard.clear();

  try {
    releaseModifierKeys();
    await sleep(30); // give the system a moment to register the key-ups
    pressCopy();
    return (await waitForCopiedText()).trim();
  } finally {
    // "finally" runs even if something above fails, so the user's clipboard
    // is always restored.
    await restoreClipboard(backup);
  }
}

module.exports = { grabSelectedText };
