/**
 * Uttr Desktop — floating bar logic
 *
 * Reads text aloud one chunk at a time and drives the bar's controls.
 *
 * Why one chunk at a time (instead of queueing them all like the extension)?
 * It gives us control: we always know which chunk is playing, and (from the
 * voice's word events) which word, so pause/resume and speed changes carry
 * on from that exact word, and the progress line moves word by word.
 *
 * Talks to the main process through window.uttr (see preload.js).
 */

const { splitIntoChunks, maxChunkLength } = window.UttrChunker;

// The speeds the Speed button cycles through.
const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

// How long a message like "Select some text first" stays on screen.
const MESSAGE_MS = 1800;
// Must match the CSS transition, so the window hides after the slide-out.
const HIDE_ANIMATION_MS = 220;

const label = document.getElementById("label");
const progressFill = document.getElementById("progress");
const speedButton = document.getElementById("speed");
const pauseButton = document.getElementById("pause");
const stopButton = document.getElementById("stop");

// ---------------------------------------------------------------------------
// Pronunciation fixes (see Step 1)
// ---------------------------------------------------------------------------

const PRONUNCIATIONS = [
  // "Uttr" alone is misread; "Utter" gives the intended /ˈʌ.t̬ɚ/.
  [/\buttr\b/gi, "Utter"],
];

function applyPronunciations(text) {
  return PRONUNCIATIONS.reduce((result, [pattern, spoken]) => result.replace(pattern, spoken), text);
}

// ---------------------------------------------------------------------------
// Reading state
// ---------------------------------------------------------------------------

let state = "idle"; // "idle" | "speaking" | "paused" | "message"
let chunks = []; // the text, split into chunks
let index = 0; // which chunk is playing
// Where in chunks[index] the voice has got to: the character position of the
// word being spoken. Updated by the speech engine's word ("boundary") events.
// Pause and speed changes pick up again from here, mid-sentence.
let wordOffset = 0;
let totalChars = 0; // for the progress line
let rate = 1;
let voiceURI = "";
let messageTimer = null;

// Every time we start, stop or pause, `generation` goes up by one. Each
// utterance remembers the generation it belongs to. When cancel() stops an
// old utterance, its "end" event still fires, but its generation is out of
// date, so we ignore it instead of accidentally moving to the next chunk.
let generation = 0;

// Chrome can garbage-collect an utterance that nothing refers to, and then
// its "end" event never fires. Keeping a reference prevents that.
let currentUtterance = null;

function setState(newState) {
  state = newState;
  document.body.classList.toggle("paused", state === "paused");
  document.body.classList.toggle("message", state === "message");
  window.uttr.sendState(state); // tell main.js (it uses this for Esc and the shortcut)
}

// ---------------------------------------------------------------------------
// Showing and hiding
// ---------------------------------------------------------------------------

function show() {
  clearTimeout(messageTimer);
  document.body.classList.add("visible");
}

/** Slide out, then tell main.js to hide the window. */
function hide() {
  document.body.classList.remove("visible");
  setTimeout(() => {
    // Only if nothing new started during the slide-out animation.
    if (state === "idle") window.uttr.sendHidden();
  }, HIDE_ANIMATION_MS);
}

// ---------------------------------------------------------------------------
// Updating the display
// ---------------------------------------------------------------------------

function render() {
  // JavaScript prints 1, 1.25, 1.5, 2, 0.75 — exactly the labels we want.
  speedButton.textContent = `${rate}×`;

  const paused = state === "paused";
  label.textContent = paused ? "Paused" : "Reading…";
  // (The pause/play icon swap is done in CSS via body.paused.)
  pauseButton.title = paused ? "Resume" : "Pause";
  pauseButton.setAttribute("aria-label", pauseButton.title);

  renderProgress();
}

/** Progress = share of characters already read, word by word. */
function renderProgress() {
  const remaining = remainingText().length;
  const done = totalChars ? 1 - remaining / totalChars : 0;
  progressFill.style.width = `${Math.round(done * 100)}%`;
}

/** Everything not read yet: the rest of the current chunk + later chunks. */
function remainingText() {
  if (!chunks.length) return "";
  return [chunks[index].slice(wordOffset), ...chunks.slice(index + 1)].join(" ").trim();
}

// ---------------------------------------------------------------------------
// Speaking
// ---------------------------------------------------------------------------

function findVoice() {
  if (!voiceURI) return null;
  return speechSynthesis.getVoices().find((v) => v.voiceURI === voiceURI) ?? null;
}

/** Start reading new text from the beginning. */
function start(text) {
  chunks = splitIntoChunks(applyPronunciations(text), maxChunkLength(rate));
  totalChars = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  index = 0;
  wordOffset = 0;
  show();
  playCurrentChunk({ interrupt: true }); // may be replacing text that's playing
}

// Pause between cancel() and speak() when interrupting. Chrome sometimes
// applies a cancel() slightly late, killing an utterance queued right after
// it; a short gap avoids that.
const CANCEL_SETTLE_MS = 60;
// How many times to retry a chunk that was cut off by that same Chrome race.
const MAX_RETRIES = 2;

/**
 * Speak chunks[index]; when it ends, move on to the next one.
 *
 * `interrupt: true` means something may be playing that must stop first
 * (new text, a speed change). Moving to the next chunk after one finishes
 * normally doesn't cancel anything; cancelling there is what triggers the
 * Chrome timing bug.
 */
function playCurrentChunk({ interrupt = false } = {}) {
  const myGeneration = ++generation;

  if (interrupt && (speechSynthesis.speaking || speechSynthesis.pending)) {
    speechSynthesis.cancel();
    setTimeout(() => {
      if (myGeneration === generation) speakChunk(myGeneration);
    }, CANCEL_SETTLE_MS);
  } else {
    speakChunk(myGeneration);
  }

  setState("speaking");
  render();
}

/**
 * Speak the current chunk, starting from `wordOffset` (0 = its beginning,
 * or the word we paused on when resuming).
 */
function speakChunk(myGeneration, retries = 0) {
  const startAt = wordOffset;
  const utterance = new SpeechSynthesisUtterance(chunks[index].slice(startAt));
  utterance.rate = rate;
  const voice = findVoice();
  if (voice) utterance.voice = voice;

  // The engine announces each word as it starts saying it. event.charIndex
  // is relative to the text we gave this utterance, so add startAt to get
  // the position in the whole chunk.
  utterance.onboundary = (event) => {
    if (myGeneration !== generation || event.name !== "word") return;
    wordOffset = startAt + event.charIndex;
    renderProgress();
  };

  const next = () => {
    if (myGeneration !== generation) return; // stale: we've moved on
    index++;
    wordOffset = 0;
    if (index < chunks.length) playCurrentChunk();
    else finish();
  };

  utterance.onend = next;
  utterance.onerror = (event) => {
    if (myGeneration !== generation) return; // we stopped it on purpose
    // Cut off by Chrome's cancel/speak race: try the same chunk again.
    if ((event.error === "interrupted" || event.error === "canceled") && retries < MAX_RETRIES) {
      setTimeout(() => {
        if (myGeneration === generation) speakChunk(myGeneration, retries + 1);
      }, CANCEL_SETTLE_MS);
      return;
    }
    // Any other problem with one chunk: skip it rather than getting stuck.
    next();
  };

  currentUtterance = utterance;
  speechSynthesis.speak(utterance);
}

function pause() {
  if (state !== "speaking") return;
  generation++; // the chunk being cut off shouldn't advance the queue
  speechSynthesis.cancel();
  setState("paused");
  render();
}

function resume() {
  if (state !== "paused") return;
  // Carries on from the word we paused on (wordOffset), not the chunk start.
  playCurrentChunk();
}

function stop() {
  generation++;
  speechSynthesis.cancel();
  finish();
}

function finish() {
  currentUtterance = null;
  chunks = [];
  wordOffset = 0;
  setState("idle");
  hide();
}

/** Speed button: move to the next speed, and apply it straight away. */
function cycleSpeed() {
  const nextIndex = (SPEEDS.indexOf(rate) + 1) % SPEEDS.length;
  rate = SPEEDS[nextIndex] ?? 1;
  window.uttr.sendRate(rate); // main.js saves it to settings

  if (state === "speaking" || state === "paused") {
    // Chunk size depends on speed, so re-split the text that's left (from
    // the current word onwards) and carry on from there at the new speed.
    const rest = remainingText();
    const doneChars = totalChars - rest.length;
    chunks = splitIntoChunks(rest, maxChunkLength(rate));
    totalChars = doneChars + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    index = 0;
    wordOffset = 0;
    if (state === "speaking") playCurrentChunk({ interrupt: true });
  }
  render();
}

/** Briefly show a message in the bar, e.g. "Select some text first". */
function showMessage(text) {
  generation++;
  speechSynthesis.cancel();
  label.textContent = text;
  setState("message");
  show();
  messageTimer = setTimeout(() => {
    setState("idle");
    hide();
  }, MESSAGE_MS);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

window.uttr.onSpeak((payload) => {
  rate = payload.rate;
  voiceURI = payload.voiceURI;
  start(payload.text);
});
window.uttr.onStop(stop);
window.uttr.onMessage(showMessage);

/**
 * Run `action` when a button is clicked.
 *
 * Why not the normal "click" event? The bar is a "no-activate" window (it
 * must never steal focus from the user's app). On Windows, clicking such a
 * window can swallow the mouse PRESS and deliver only the RELEASE. A browser
 * "click" needs both, so it never fires. The release (pointerup) always
 * arrives, so we act on that instead: one action per click either way.
 */
function onPress(button, action) {
  button.addEventListener("pointerup", (event) => {
    if (event.button === 0) action(); // left mouse button only
  });
}

onPress(pauseButton, () => (state === "paused" ? resume() : pause()));
onPress(stopButton, stop);
onPress(speedButton, cycleSpeed);

// Start loading the voice list early (Windows voices arrive a moment later).
speechSynthesis.getVoices();
