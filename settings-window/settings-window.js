/**
 * Uttr Desktop — Settings window logic
 *
 * Every change is sent to main.js straight away, which saves it and applies
 * it (e.g. re-registers the shortcut). main.js is the single source of truth:
 * it always replies with the full, updated settings, and we display those.
 *
 * window.uttrSettings comes from settings-window/preload.js.
 * window.UttrShortcut comes from ../shared/shortcut.js.
 */

const api = window.uttrSettings;
const { codeOf, fromKeyEvent, isModifierCode, modifiersOf, toLabels } = window.UttrShortcut;

const DEFAULT_SHORTCUT = "CommandOrControl+Alt+R";

const shortcutBox = document.getElementById("shortcut");
const changeButton = document.getElementById("change");
const resetButton = document.getElementById("reset-shortcut");
const shortcutMessage = document.getElementById("shortcut-message");
const voiceSelect = document.getElementById("voice");
const testVoiceButton = document.getElementById("test-voice");
const rateInput = document.getElementById("rate");
const rateValue = document.getElementById("rate-value");
const startWithWindows = document.getElementById("start-with-windows");

let settings = null;
let platform = "win32";
let recording = false;

// ---------------------------------------------------------------------------
// Showing values
// ---------------------------------------------------------------------------

/** Draw a list of key names as keycaps: [Ctrl] + [Alt] + [R]. */
function drawKeys(labels) {
  shortcutBox.replaceChildren();
  labels.forEach((label, i) => {
    if (i > 0) {
      const plus = document.createElement("span");
      plus.className = "plus";
      plus.textContent = "+";
      shortcutBox.append(plus);
    }
    const key = document.createElement("kbd");
    key.className = "key";
    key.textContent = label;
    shortcutBox.append(key);
  });
}

function showMessage(text, kind = "") {
  shortcutMessage.textContent = text;
  shortcutMessage.className = `message ${kind}`;
}

function formatRate(rate) {
  // 1 -> "1×", 1.25 -> "1.25×", 1.1 -> "1.1×"
  return `${Math.round(rate * 100) / 100}×`;
}

/** Update every control from a settings object. */
function render(newSettings) {
  settings = newSettings;
  if (!recording) drawKeys(toLabels(settings.shortcut, platform));
  resetButton.hidden = settings.shortcut === DEFAULT_SHORTCUT;
  rateInput.value = settings.rate;
  rateValue.textContent = formatRate(settings.rate);
  selectSavedVoice();
}

// ---------------------------------------------------------------------------
// Recording a new shortcut
// ---------------------------------------------------------------------------

async function startRecording() {
  if (recording) return;
  recording = true;
  // Switch the current global shortcut off, so pressing it types into the
  // recorder instead of making Uttr read.
  await api.startRecording();
  shortcutBox.classList.add("recording");
  shortcutBox.innerHTML = '<span class="waiting">Press your new shortcut…</span>';
  changeButton.textContent = "Cancel";
  showMessage("Hold Ctrl, Alt or Win, then press a key. Press Esc to cancel.");
}

async function stopRecording(message = "", kind = "") {
  if (!recording) return;
  recording = false;
  shortcutBox.classList.remove("recording");
  changeButton.textContent = "Change";
  drawKeys(toLabels(settings.shortcut, platform));
  showMessage(message, kind);
  await api.stopRecording(); // switch the (possibly new) shortcut back on
}

window.addEventListener("keydown", async (event) => {
  if (!recording) return;
  // Don't let the key do its normal job (e.g. Tab moving focus, Space
  // clicking the button) while we're recording.
  event.preventDefault();

  // Esc on its own cancels.
  if (codeOf(event) === "Escape" && !modifiersOf(event).length) {
    stopRecording("Cancelled — your shortcut hasn't changed.");
    return;
  }

  // Only modifiers held so far: show them live, e.g. "Ctrl + Alt + …".
  if (isModifierCode(codeOf(event))) {
    const held = toLabels(modifiersOf(event).join("+"), platform);
    drawKeys([...held, "…"]);
    return;
  }

  const result = fromKeyEvent(event);
  if (result.error) {
    showMessage(result.error, "error");
    return; // keep recording so they can try again
  }

  // Ask main.js to switch to it. It may fail if another app owns it.
  const reply = await api.setShortcut(result.accelerator);
  if (reply.ok) {
    render(reply.settings);
    stopRecording(`Saved. Press ${toLabels(reply.settings.shortcut, platform).join(" + ")} to read.`, "ok");
  } else {
    showMessage(reply.error, "error"); // keep recording
    drawKeys(toLabels(result.accelerator, platform));
  }
});

// Letting go of all keys without choosing one: back to "Press your new shortcut…".
window.addEventListener("keyup", (event) => {
  if (recording && !modifiersOf(event).length) {
    shortcutBox.innerHTML = '<span class="waiting">Press your new shortcut…</span>';
  }
});

// Clicking away from the window while recording cancels it (so the global
// shortcut never stays switched off).
window.addEventListener("blur", () => stopRecording());

changeButton.addEventListener("click", () => (recording ? stopRecording("Cancelled — your shortcut hasn't changed.") : startRecording()));

resetButton.addEventListener("click", async () => {
  const reply = await api.setShortcut(DEFAULT_SHORTCUT);
  if (reply.ok) {
    render(reply.settings);
    showMessage("Shortcut reset.", "ok");
  } else {
    showMessage(reply.error, "error");
  }
});

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------

/**
 * Fill the voice list. Voices load a moment after the window opens, so this
 * runs at start-up and again when the "voiceschanged" event fires.
 */
function populateVoices() {
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return;
  voices.sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
  voiceSelect.length = 1; // keep "System default"
  for (const voice of voices) {
    voiceSelect.add(new Option(`${voice.name.replace(/^Microsoft /, "")} (${voice.lang})`, voice.voiceURI));
  }
  selectSavedVoice();
}

function selectSavedVoice() {
  if (!settings) return;
  const exists = [...voiceSelect.options].some((o) => o.value === settings.voiceURI);
  voiceSelect.value = exists ? settings.voiceURI : "";
}

voiceSelect.addEventListener("change", async () => {
  render(await api.save({ voiceURI: voiceSelect.value }));
});

testVoiceButton.addEventListener("click", () => api.testVoice());

// ---------------------------------------------------------------------------
// Speed
// ---------------------------------------------------------------------------

// "input" fires while dragging (update the label); "change" when let go (save).
rateInput.addEventListener("input", () => {
  rateValue.textContent = formatRate(Number(rateInput.value));
});
rateInput.addEventListener("change", async () => {
  render(await api.save({ rate: Number(rateInput.value) }));
});

// ---------------------------------------------------------------------------
// Start with Windows
// ---------------------------------------------------------------------------

startWithWindows.addEventListener("change", async () => {
  startWithWindows.checked = await api.setStartWithWindows(startWithWindows.checked);
});

// ---------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------

async function init() {
  const info = await api.load();
  platform = info.platform;
  document.getElementById("version").textContent = `v${info.version}`;
  startWithWindows.checked = info.startWithWindows;
  if (platform === "darwin") document.getElementById("start-label").textContent = "Start Uttr when you log in";
  render(info.settings);

  populateVoices();
  speechSynthesis.addEventListener("voiceschanged", populateVoices);
}

// Changes made elsewhere (e.g. the bar's speed button) show up here too.
api.onChanged(render);

init();
