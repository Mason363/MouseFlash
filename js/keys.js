// HID usage tables used by keyboard shortcuts, macros, and media actions.

// Modifier bits, as the mouse stores them. Only the left-hand modifiers exist
// in the protocol.
export const MODIFIERS = [
  { bit: 0x01, name: 'Ctrl' },
  { bit: 0x02, name: 'Shift' },
  { bit: 0x04, name: 'Alt' },
  { bit: 0x08, name: 'Super' },
];

export function modifiersToText(bits) {
  const parts = MODIFIERS.filter((m) => bits & m.bit).map((m) => m.name);
  return parts.join(' + ');
}

// Keyboard usage page (0x07) codes. This is the subset a mouse button or macro
// realistically needs.
export const KEYS = (() => {
  const list = [];
  const add = (usage, name) => list.push({ usage, name });

  for (let i = 0; i < 26; i++) add(0x04 + i, String.fromCharCode(65 + i));
  for (let i = 1; i <= 9; i++) add(0x1d + i, String(i));
  add(0x27, '0');

  add(0x28, 'Enter');
  add(0x29, 'Escape');
  add(0x2a, 'Backspace');
  add(0x2b, 'Tab');
  add(0x2c, 'Space');
  add(0x2d, '- _');
  add(0x2e, '= +');
  add(0x2f, '[ {');
  add(0x30, '] }');
  add(0x31, '\\ |');
  add(0x33, '; :');
  add(0x34, "' \"");
  add(0x35, '` ~');
  add(0x36, ', <');
  add(0x37, '. >');
  add(0x38, '/ ?');
  add(0x39, 'Caps Lock');

  for (let i = 1; i <= 12; i++) add(0x39 + i, `F${i}`);

  add(0x46, 'Print Screen');
  add(0x47, 'Scroll Lock');
  add(0x48, 'Pause');
  add(0x49, 'Insert');
  add(0x4a, 'Home');
  add(0x4b, 'Page Up');
  add(0x4c, 'Delete');
  add(0x4d, 'End');
  add(0x4e, 'Page Down');
  add(0x4f, 'Arrow Right');
  add(0x50, 'Arrow Left');
  add(0x51, 'Arrow Down');
  add(0x52, 'Arrow Up');
  add(0x53, 'Num Lock');
  add(0x54, 'Numpad /');
  add(0x55, 'Numpad *');
  add(0x56, 'Numpad -');
  add(0x57, 'Numpad +');
  add(0x58, 'Numpad Enter');
  for (let i = 1; i <= 9; i++) add(0x58 + i, `Numpad ${i}`);
  add(0x62, 'Numpad 0');
  add(0x63, 'Numpad .');

  return list;
})();

const KEY_NAMES = new Map(KEYS.map((k) => [k.usage, k.name]));

export function keyName(usage) {
  return KEY_NAMES.get(usage) || `Usage 0x${usage.toString(16).padStart(2, '0')}`;
}

// Maps a browser KeyboardEvent.code to a HID keyboard usage, so macros can be
// recorded by typing. Codes not listed here are ignored during recording.
export const CODE_TO_USAGE = (() => {
  const map = new Map();
  for (let i = 0; i < 26; i++) map.set(`Key${String.fromCharCode(65 + i)}`, 0x04 + i);
  for (let i = 1; i <= 9; i++) map.set(`Digit${i}`, 0x1d + i);
  map.set('Digit0', 0x27);

  const simple = {
    Enter: 0x28, Escape: 0x29, Backspace: 0x2a, Tab: 0x2b, Space: 0x2c,
    Minus: 0x2d, Equal: 0x2e, BracketLeft: 0x2f, BracketRight: 0x30,
    Backslash: 0x31, Semicolon: 0x33, Quote: 0x34, Backquote: 0x35,
    Comma: 0x36, Period: 0x37, Slash: 0x38, CapsLock: 0x39,
    PrintScreen: 0x46, ScrollLock: 0x47, Pause: 0x48, Insert: 0x49,
    Home: 0x4a, PageUp: 0x4b, Delete: 0x4c, End: 0x4d, PageDown: 0x4e,
    ArrowRight: 0x4f, ArrowLeft: 0x50, ArrowDown: 0x51, ArrowUp: 0x52,
    NumLock: 0x53, NumpadDivide: 0x54, NumpadMultiply: 0x55,
    NumpadSubtract: 0x56, NumpadAdd: 0x57, NumpadEnter: 0x58,
    Numpad0: 0x62, NumpadDecimal: 0x63,
  };
  for (const [code, usage] of Object.entries(simple)) map.set(code, usage);
  for (let i = 1; i <= 12; i++) map.set(`F${i}`, 0x39 + i);
  for (let i = 1; i <= 9; i++) map.set(`Numpad${i}`, 0x58 + i);

  return map;
})();

// Modifier keys, recorded separately from ordinary keys in macros.
export const CODE_TO_MODIFIER = new Map([
  ['ControlLeft', 0x01], ['ControlRight', 0x01],
  ['ShiftLeft', 0x02], ['ShiftRight', 0x02],
  ['AltLeft', 0x04], ['AltRight', 0x04],
  ['MetaLeft', 0x08], ['MetaRight', 0x08],
]);

// Media and shortcut keys, stored as a 24 bit mask.
export const MEDIA = [
  { mask: 0x080000, name: 'Play / Pause' },
  { mask: 0x010000, name: 'Next Track' },
  { mask: 0x020000, name: 'Previous Track' },
  { mask: 0x040000, name: 'Stop' },
  { mask: 0x100000, name: 'Mute' },
  { mask: 0x400000, name: 'Volume Up' },
  { mask: 0x800000, name: 'Volume Down' },
  { mask: 0x000100, name: 'Media Player' },
  { mask: 0x000200, name: 'File Explorer' },
  { mask: 0x001000, name: 'Email' },
  { mask: 0x002000, name: 'Calculator' },
  { mask: 0x000002, name: 'Home Page' },
];

export function mediaName(mask) {
  const hit = MEDIA.find((m) => m.mask === mask);
  if (hit) return hit.name;
  return `Media 0x${mask.toString(16).padStart(6, '0')}`;
}

// Mouse button bits, shared by click actions and macro mouse events.
export const MOUSE_BITS = [
  { bit: 0x01, name: 'Left Click' },
  { bit: 0x02, name: 'Right Click' },
  { bit: 0x04, name: 'Middle Click' },
  { bit: 0x08, name: 'Browser Back' },
  { bit: 0x10, name: 'Browser Forward' },
];

export function mouseBitName(bits) {
  const hit = MOUSE_BITS.find((m) => m.bit === bits);
  if (hit) return hit.name;
  const parts = MOUSE_BITS.filter((m) => bits & m.bit).map((m) => m.name);
  return parts.length ? parts.join(' + ') : `Buttons 0x${bits.toString(16)}`;
}
