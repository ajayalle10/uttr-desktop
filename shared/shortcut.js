/**
 * Uttr — keyboard shortcut helpers (shared)
 *
 * Electron describes shortcuts as "accelerators": strings like
 * "CommandOrControl+Alt+R". This file converts between:
 *   - a key press in the Settings window (a KeyboardEvent)
 *   - Electron's accelerator string (what we save and register)
 *   - a friendly label for people ("Ctrl + Alt + R")
 *
 * Works in a window (<script> → window.UttrShortcut) and in Node.js
 * (require → used by main.js and the tests).
 */
(function () {
  // KeyboardEvent.code (the PHYSICAL key, the same on every keyboard layout)
  // -> the key name Electron's accelerators expect.
  const NAMED_KEYS = {
    Space: "Space", Enter: "Enter", Tab: "Tab", Backspace: "Backspace",
    Delete: "Delete", Insert: "Insert", Home: "Home", End: "End",
    PageUp: "PageUp", PageDown: "PageDown",
    ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
    Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]",
    Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/",
  };

  // Fallback for key events whose `code` is empty. On-screen keyboards,
  // remote desktop and some keyboard tools send keys without it. Every event
  // still has the older `keyCode` number, which we translate to a code.
  const KEYCODE_TO_CODE = {
    8: "Backspace", 9: "Tab", 13: "Enter", 16: "ShiftLeft", 17: "ControlLeft", 18: "AltLeft",
    27: "Escape", 32: "Space", 33: "PageUp", 34: "PageDown", 35: "End", 36: "Home",
    37: "ArrowLeft", 38: "ArrowUp", 39: "ArrowRight", 40: "ArrowDown", 45: "Insert", 46: "Delete",
    91: "MetaLeft", 92: "MetaRight", 186: "Semicolon", 187: "Equal", 188: "Comma", 189: "Minus",
    190: "Period", 191: "Slash", 192: "Backquote", 219: "BracketLeft", 220: "Backslash",
    221: "BracketRight", 222: "Quote",
  };

  /** The physical key of an event, e.g. "KeyJ", even when event.code is empty. */
  function codeOf(event) {
    if (event.code) return event.code;
    const n = event.keyCode;
    if (n >= 65 && n <= 90) return "Key" + String.fromCharCode(n); // A-Z
    if (n >= 48 && n <= 57) return "Digit" + (n - 48); // 0-9
    if (n >= 96 && n <= 105) return "Numpad" + (n - 96);
    if (n >= 112 && n <= 135) return "F" + (n - 111); // F1-F24
    return KEYCODE_TO_CODE[n] ?? "";
  }

  /** "KeyA" -> "A", "Digit1" -> "1", "F5" -> "F5", "Numpad3" -> "num3" … or null. */
  function codeToKey(code) {
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
    if (/^Numpad[0-9]$/.test(code)) return "num" + code.slice(6);
    return NAMED_KEYS[code] ?? null;
  }

  /** Is this key a modifier on its own (Ctrl, Alt, Shift, Win/Cmd)? */
  function isModifierCode(code) {
    return /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/.test(code);
  }

  /** The modifiers held during a key event, in Electron's names and a fixed order. */
  function modifiersOf(event) {
    const mods = [];
    if (event.ctrlKey) mods.push("CommandOrControl");
    if (event.altKey) mods.push("Alt");
    if (event.shiftKey) mods.push("Shift");
    if (event.metaKey) mods.push("Super"); // Windows key (Cmd on Mac)
    return mods;
  }

  /**
   * Turn a key press into a shortcut, or explain why it can't be one.
   * Returns { accelerator } or { error }.
   */
  function fromKeyEvent(event) {
    const key = codeToKey(codeOf(event));
    if (!key) return { error: "That key can't be used in a shortcut. Try a letter, number or F-key." };

    const mods = modifiersOf(event);
    // Shortcuts need Ctrl, Alt or the Windows key. Shift + a letter alone
    // would fire every time you type a capital letter.
    if (!mods.some((m) => m !== "Shift")) {
      return { error: "Include Ctrl, Alt or the Windows key, so normal typing doesn't trigger Uttr." };
    }
    return { accelerator: [...mods, key].join("+") };
  }

  /** Is this a key name that codeToKey() can produce? */
  function isKnownKey(key) {
    return Object.values(NAMED_KEYS).includes(key) || /^([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|num[0-9])$/.test(key);
  }

  /** Same checks for an accelerator string (main.js re-checks anything it's sent). */
  function isValidAccelerator(accelerator) {
    if (typeof accelerator !== "string") return false;
    const parts = accelerator.split("+");
    const key = parts.pop();
    const allowedMods = ["CommandOrControl", "Alt", "Shift", "Super"];
    return (
      parts.length > 0 &&
      parts.every((m) => allowedMods.includes(m)) &&
      parts.some((m) => m !== "Shift") &&
      isKnownKey(key)
    );
  }

  /** "CommandOrControl+Alt+R" -> ["Ctrl", "Alt", "R"], for showing as keycaps. */
  function toLabels(accelerator, platform) {
    const mac = platform === "darwin";
    const names = { CommandOrControl: mac ? "Cmd" : "Ctrl", Super: mac ? "Cmd" : "Win", Alt: mac ? "Option" : "Alt", Shift: "Shift" };
    return accelerator.split("+").map((part) => names[part] ?? part);
  }

  /** "CommandOrControl+Alt+R" -> "Ctrl + Alt + R". */
  function prettyShortcut(accelerator, platform) {
    return toLabels(accelerator, platform).join(" + ");
  }

  const api = { codeOf, codeToKey, isModifierCode, modifiersOf, fromKeyEvent, isValidAccelerator, toLabels, prettyShortcut };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else window.UttrShortcut = api;
})();
