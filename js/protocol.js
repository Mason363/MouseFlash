// Encoding and decoding of the SinoWealth vendor reports.
//
// Everything here is pure byte shuffling: no WebHID, no DOM. See docs/PROTOCOL.md
// for the layout this implements and for where the layout came from.

import { sensorInfo } from './devices.js';

export const REPORT_CMD = 5;
export const REPORT_CONFIG = 4;
export const REPORT_CONFIG_LONG = 6;

export const CMD = {
  FIRMWARE: 0x01,
  PROFILE: 0x02,
  GET_CONFIG: 0x11,
  GET_BUTTONS: 0x12,
  DEBOUNCE: 0x1a,
  MACRO: 0x30,
};

export const REPORT_SIZE = 520; // including the report ID byte
export const CONFIG_SIZE_DEFAULT = 131;
export const CONFIG_SIZE_MIN = 123;
export const CONFIG_SIZE_MAX = 167;
export const BUTTON_SIZE = 88;
export const MACRO_MAX_EVENTS = 168;
export const MACRO_BANKS = 8;

export const POLLING_RATES = [125, 250, 500, 1000];
export const DEBOUNCE_TIMES = [4, 6, 8, 10, 12, 14, 16];
export const DPI_SLOTS = 8;
export const DPI_STEP = 100;
export const DPI_MIN = 100;

// Lift-off distance. 0xff means the mouse manages it through a separate
// command; overwriting that byte is known to misbehave, so we leave it alone.
export const LOD_EXTERNAL = 0xff;

// Bit in the high nibble of the polling-rate byte that puts the two axes on
// separate DPI values.
const XY_INDEPENDENT = 0x80;

// `params` drives which controls the lighting tab shows; `colors` is how many
// colour slots the effect stores.
export const EFFECTS = [
  { id: 0, name: 'Off', params: [], colors: 0 },
  { id: 1, name: 'Glorious', params: ['speed', 'direction'], colors: 0 },
  { id: 2, name: 'Solid', params: ['brightness', 'colors'], colors: 1 },
  { id: 3, name: 'Breathing', params: ['speed', 'colorCount', 'colors'], colors: 7 },
  { id: 4, name: 'Tail', params: ['speed', 'brightness'], colors: 0 },
  { id: 5, name: 'Seamless Breathing', params: ['speed'], colors: 0 },
  { id: 6, name: 'Constant RGB', params: ['colors'], colors: 6 },
  { id: 7, name: 'Rave', params: ['speed', 'brightness', 'colors'], colors: 2 },
  { id: 8, name: 'Random', params: ['speed'], colors: 0 },
  { id: 9, name: 'Wave', params: ['speed', 'brightness'], colors: 0 },
  { id: 10, name: 'Single Breathing', params: ['speed', 'colors'], colors: 1 },
];

export const SPEED_MAX = 3;
export const BRIGHTNESS_MAX = 4;

// Byte offsets into the config report, report ID included.
const C = {
  command: 1,
  writeLen: 3,
  sensor: 9,
  rate: 10,
  dpiCount: 11,
  dpiDisabled: 12,
  dpiValues: 13,
  dpiColors: 29,
  effect: 53,
  glorious: 54,
  gloriousDir: 55,
  solid: 56,
  solidColor: 57,
  breathing: 60,
  breathingCount: 61,
  breathingColors: 62,
  tail: 83,
  seamless: 84,
  constant: 85,
  constantColors: 86,
  rave: 116,
  raveColors: 117,
  random: 123,
  wave: 124,
  single: 125,
  singleColor: 126,
  lod: 129,
};

// Which effects use which mode byte and colour block.
const EFFECT_BYTES = {
  1: { mode: C.glorious, dir: C.gloriousDir },
  2: { mode: C.solid, colors: C.solidColor, count: 1 },
  3: { mode: C.breathing, colors: C.breathingColors, count: 7, countAt: C.breathingCount },
  4: { mode: C.tail },
  5: { mode: C.seamless },
  6: { mode: C.constant, colors: C.constantColors, count: 6 },
  7: { mode: C.rave, colors: C.raveColors, count: 2 },
  8: { mode: C.random },
  9: { mode: C.wave },
  10: { mode: C.single, colors: C.singleColor, count: 1 },
};

const B = { command: 1, writeLen: 3, buttons: 8, count: 20 };

// ---------------------------------------------------------------------------
// DPI values
// ---------------------------------------------------------------------------

// PMW3360 and PMW3327 store one less than the number of hundreds; the others
// store the number of hundreds directly.
export function rawToDpi(raw, sensor) {
  return (raw + (sensor.offsetOne ? 1 : 0)) * DPI_STEP;
}

export function dpiToRaw(dpi, sensor) {
  const clamped = Math.min(Math.max(dpi, DPI_MIN), sensor.maxDpi);
  const steps = Math.round(clamped / DPI_STEP);
  return (steps - (sensor.offsetOne ? 1 : 0)) & 0xff;
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

function hex(n) {
  return n.toString(16).padStart(2, '0');
}

function readColor(buf, at, order) {
  const a = buf[at], b = buf[at + 1], c = buf[at + 2];
  // 'rbg' devices wire green and blue the other way round.
  return order === 'rbg' ? `#${hex(a)}${hex(c)}${hex(b)}` : `#${hex(a)}${hex(b)}${hex(c)}`;
}

function writeColor(buf, at, css, order) {
  const m = /^#?([0-9a-f]{6})$/i.exec(css.trim());
  const v = m ? parseInt(m[1], 16) : 0;
  const r = (v >> 16) & 0xff, g = (v >> 8) & 0xff, b = v & 0xff;
  if (order === 'rbg') {
    buf[at] = r; buf[at + 1] = b; buf[at + 2] = g;
  } else {
    buf[at] = r; buf[at + 1] = g; buf[at + 2] = b;
  }
}

// ---------------------------------------------------------------------------
// Config report
// ---------------------------------------------------------------------------

/**
 * Decode a config report into a plain object.
 *
 * @param {Uint8Array} buf 520 byte report, report ID at index 0
 * @param {object} opts `{ configSize, ledOrder }`
 */
export function decodeConfig(buf, { configSize = CONFIG_SIZE_DEFAULT, ledOrder = 'rbg' } = {}) {
  const sensor = sensorInfo(buf[C.sensor]);
  const rateByte = buf[C.rate];
  const xyIndependent = (rateByte & XY_INDEPENDENT) !== 0;
  const disabled = buf[C.dpiDisabled];

  const slots = [];
  for (let i = 0; i < DPI_SLOTS; i++) {
    const x = xyIndependent ? buf[C.dpiValues + i * 2] : buf[C.dpiValues + i];
    const y = xyIndependent ? buf[C.dpiValues + i * 2 + 1] : x;
    slots.push({
      enabled: (disabled & (1 << i)) === 0,
      x: rawToDpi(x, sensor),
      y: rawToDpi(y, sensor),
      color: readColor(buf, C.dpiColors + i * 3, 'rgb'),
    });
  }

  // The active-DPI nibble counts enabled slots only, starting at 1.
  const activeOrdinal = (buf[C.dpiCount] >> 4) & 0xf;
  let activeSlot = slots.findIndex((s) => s.enabled);
  let seen = 0;
  for (let i = 0; i < DPI_SLOTS; i++) {
    if (!slots[i].enabled) continue;
    seen++;
    if (seen === activeOrdinal) { activeSlot = i; break; }
  }

  const effect = buf[C.effect];
  const lod = buf[C.lod];

  return {
    raw: buf,
    configSize,
    ledOrder,
    sensor,
    pollingRate: POLLING_RATES[(rateByte & 0xf) - 1] || 1000,
    xyIndependent,
    dpi: slots,
    activeSlot: activeSlot < 0 ? 0 : activeSlot,
    effect: effect <= 10 ? effect : 0,
    params: readEffectParams(buf, ledOrder),
    lod,
    lodLocked: lod === LOD_EXTERNAL,
  };
}

function readEffectParams(buf, ledOrder) {
  const params = {};
  for (const [id, spec] of Object.entries(EFFECT_BYTES)) {
    const mode = buf[spec.mode];
    const p = { speed: mode & 0xf, brightness: (mode >> 4) & 0xf };
    if (spec.dir !== undefined) p.direction = buf[spec.dir];
    if (spec.colors !== undefined) {
      p.colors = [];
      for (let i = 0; i < spec.count; i++) {
        p.colors.push(readColor(buf, spec.colors + i * 3, ledOrder));
      }
      if (spec.countAt !== undefined) p.colorCount = buf[spec.countAt];
    }
    params[id] = p;
  }
  return params;
}

/**
 * Write a decoded config back into its raw report.
 *
 * Unknown bytes are preserved: we start from the buffer the mouse gave us and
 * only touch fields we understand.
 *
 * @returns {Uint8Array} a new 520 byte buffer ready to send
 */
export function encodeConfig(cfg) {
  const buf = new Uint8Array(cfg.raw);
  const { sensor, ledOrder } = cfg;

  buf[C.command] = CMD.GET_CONFIG;
  buf[C.writeLen] = (cfg.configSize - 8) & 0xff;

  const rateIndex = POLLING_RATES.indexOf(cfg.pollingRate);
  buf[C.rate] = (cfg.xyIndependent ? XY_INDEPENDENT : 0) | ((rateIndex < 0 ? 3 : rateIndex) + 1);

  let disabled = 0;
  let enabledCount = 0;
  let activeOrdinal = 1;
  for (let i = 0; i < DPI_SLOTS; i++) {
    const slot = cfg.dpi[i];
    if (slot.enabled) {
      enabledCount++;
      if (i === cfg.activeSlot) activeOrdinal = enabledCount;
    } else {
      disabled |= 1 << i;
    }
  }
  if (enabledCount === 0) {
    // The mouse needs at least one active stage, otherwise it has no DPI to use.
    cfg.dpi[0].enabled = true;
    disabled &= ~1;
    enabledCount = 1;
    activeOrdinal = 1;
  }
  buf[C.dpiCount] = ((activeOrdinal & 0xf) << 4) | (enabledCount & 0xf);
  buf[C.dpiDisabled] = disabled;

  buf.fill(0, C.dpiValues, C.dpiValues + 16);
  for (let i = 0; i < DPI_SLOTS; i++) {
    const slot = cfg.dpi[i];
    if (cfg.xyIndependent) {
      buf[C.dpiValues + i * 2] = dpiToRaw(slot.x, sensor);
      buf[C.dpiValues + i * 2 + 1] = dpiToRaw(slot.y, sensor);
    } else {
      buf[C.dpiValues + i] = dpiToRaw(slot.x, sensor);
    }
    writeColor(buf, C.dpiColors + i * 3, slot.color, 'rgb');
  }

  buf[C.effect] = cfg.effect;
  for (const [id, spec] of Object.entries(EFFECT_BYTES)) {
    const p = cfg.params[id];
    if (!p) continue;
    buf[spec.mode] = ((p.brightness & 0xf) << 4) | (p.speed & 0xf);
    if (spec.dir !== undefined) buf[spec.dir] = p.direction & 0xff;
    if (spec.colors !== undefined && p.colors) {
      for (let i = 0; i < spec.count; i++) {
        writeColor(buf, spec.colors + i * 3, p.colors[i] || '#000000', ledOrder);
      }
      if (spec.countAt !== undefined) {
        buf[spec.countAt] = Math.min(Math.max(p.colorCount || spec.count, 1), spec.count);
      }
    }
  }

  if (!cfg.lodLocked) buf[C.lod] = cfg.lod;

  return buf;
}

// ---------------------------------------------------------------------------
// Button actions
// ---------------------------------------------------------------------------

export const ACTION = {
  DISABLED: 'disabled',
  MOUSE: 'mouse',
  SCROLL: 'scroll',
  REPEAT: 'repeat',
  DPI: 'dpi',
  DPI_LOCK: 'dpiLock',
  MEDIA: 'media',
  KEY: 'key',
  MACRO: 'macro',
};

export const DPI_MODES = [
  { value: 0, name: 'Cycle DPI' },
  { value: 1, name: 'DPI Up' },
  { value: 2, name: 'DPI Down' },
];

export const MACRO_MODES = [
  { value: 1, name: 'Repeat a set number of times' },
  { value: 4, name: 'Repeat while held' },
  { value: 2, name: 'Repeat until any button is pressed' },
];

/** Decode one 4 byte button slot. */
export function decodeAction(bytes, sensor) {
  const [type, a, b, c] = bytes;
  switch (type) {
    case 0x11: return { type: ACTION.MOUSE, bits: a };
    case 0x12: return { type: ACTION.SCROLL, dir: a === 0xff ? -1 : 1 };
    case 0x21: return { type: ACTION.KEY, mods: a, key: b };
    case 0x22: return { type: ACTION.MEDIA, mask: (a << 16) | (b << 8) | c };
    case 0x31: return { type: ACTION.REPEAT, bits: a, interval: b, count: c };
    case 0x41: return { type: ACTION.DPI, mode: a <= 2 ? a : 0 };
    case 0x42: return { type: ACTION.DPI_LOCK, dpi: rawToDpi(a, sensor) };
    case 0x70: return { type: ACTION.MACRO, bank: a, mode: b, count: c };
    case 0x50:
    default: return { type: ACTION.DISABLED };
  }
}

/** Encode one action into 4 bytes. */
export function encodeAction(action, sensor) {
  switch (action.type) {
    case ACTION.MOUSE: return [0x11, action.bits & 0xff, 0, 0];
    case ACTION.SCROLL: return [0x12, action.dir < 0 ? 0xff : 0x01, 0, 0];
    case ACTION.KEY: return [0x21, action.mods & 0x0f, action.key & 0xff, 0];
    case ACTION.MEDIA: return [0x22, (action.mask >> 16) & 0xff, (action.mask >> 8) & 0xff, action.mask & 0xff];
    case ACTION.REPEAT: return [0x31, action.bits & 0xff, action.interval & 0xff, action.count & 0xff];
    case ACTION.DPI: return [0x41, action.mode & 0xff, 0, 0];
    case ACTION.DPI_LOCK: return [0x42, dpiToRaw(action.dpi, sensor), 0, 0];
    case ACTION.MACRO: return [0x70, action.bank & 0xff, action.mode & 0xff, Math.max(1, action.count & 0xff)];
    default: return [0x50, 0x01, 0, 0];
  }
}

export function decodeButtons(buf, buttonCount, sensor) {
  const out = [];
  for (let i = 0; i < buttonCount; i++) {
    const at = B.buttons + i * 4;
    out.push(decodeAction(buf.subarray(at, at + 4), sensor));
  }
  return out;
}

export function encodeButtons(buf, actions, sensor) {
  const out = new Uint8Array(buf);
  out[B.command] = CMD.GET_BUTTONS;
  out[B.writeLen] = (BUTTON_SIZE - 8) & 0xff;
  for (let i = 0; i < B.count; i++) {
    const at = B.buttons + i * 4;
    const bytes = i < actions.length
      ? encodeAction(actions[i], sensor)
      : Array.from(out.subarray(at, at + 4));
    out.set(bytes, at);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Macros
// ---------------------------------------------------------------------------

export const MACRO_EVENT = { MOUSE: 1, KEY: 5, MODIFIER: 6 };

/**
 * Encode a macro bank.
 *
 * Each event is `{ kind, code, down, delay }`, where `kind` is one of
 * MACRO_EVENT, `code` is a HID usage or button bitmask, `down` is true for a
 * press, and `delay` is how long to wait before the event in milliseconds.
 */
export function encodeMacro(bank, events, reportId = REPORT_CONFIG) {
  const buf = new Uint8Array(REPORT_SIZE);
  buf[0] = reportId;
  buf[1] = CMD.MACRO;
  buf[2] = 0x02;
  buf[8] = bank & 0xff;
  buf[10] = Math.min(events.length, MACRO_MAX_EVENTS);

  const n = Math.min(events.length, MACRO_MAX_EVENTS);
  for (let i = 0; i < n; i++) {
    const ev = events[i];
    // A delay of 0 makes the mouse skip the event, so 1ms is the floor.
    const delay = Math.min(Math.max(ev.delay | 0, 1), 0xfff);
    const head = (ev.down ? 0 : 0x80) | ((ev.kind & 0x7) << 4) | ((delay >> 8) & 0xf);
    buf.set([head, delay & 0xff, ev.code & 0xff], 11 + i * 3);
  }
  return buf;
}

/** Decode a macro bank read back from the mouse. */
export function decodeMacro(buf) {
  const count = Math.min(buf[10], MACRO_MAX_EVENTS);
  const events = [];
  for (let i = 0; i < count; i++) {
    const at = 11 + i * 3;
    const head = buf[at];
    events.push({
      down: (head & 0x80) === 0,
      kind: (head >> 4) & 0x7,
      delay: ((head & 0xf) << 8) | buf[at + 1],
      code: buf[at + 2],
    });
  }
  return { bank: buf[8], events };
}

export function debounceToRaw(ms) {
  const nearest = DEBOUNCE_TIMES.reduce((a, b) => (Math.abs(b - ms) < Math.abs(a - ms) ? b : a));
  return nearest / 2;
}

export function rawToDebounce(raw) {
  return raw * 2;
}
