// Byte-level tests for the protocol encoder. Run with: node --test
//
// The expected byte sequences come from docs/PROTOCOL.md, which in turn came
// from the reverse-engineering work credited in the README. Checking against
// them catches the kind of off-by-one that would otherwise only show up as a
// misbehaving mouse.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ACTION, BUTTON_SIZE, CMD, LOD_EXTERNAL, MACRO_EVENT, REPORT_SIZE,
  debounceToRaw, decodeAction, decodeButtons, decodeConfig, decodeMacro,
  dpiToRaw, encodeAction, encodeButtons, encodeConfig, encodeMacro, rawToDpi,
} from '../js/protocol.js';
import { sensorInfo } from '../js/devices.js';

const PMW3360 = sensorInfo(0x06);
const PMW3389 = sensorInfo(0x0f);

// A config report shaped like a Glorious Model O answers: 131 bytes of data
// inside a 520 byte report.
function sampleConfig() {
  const buf = new Uint8Array(REPORT_SIZE);
  buf.set([0x04, 0x11, 0x00, 0x7b, 0, 0, 0, 0, 0x64, 0x06], 0);
  buf[10] = 0x04; // 1000 Hz, axes locked together
  buf[11] = 0x12; // first of two enabled stages active
  buf[12] = 0b11111100; // stages 1 and 2 enabled
  buf[13] = 0x07; // 800 DPI
  buf[14] = 0x0f; // 1600 DPI
  buf.set([0xff, 0x00, 0x00], 29); // stage 1 red
  buf.set([0x00, 0xff, 0x00], 32); // stage 2 green
  buf[53] = 2; // solid
  buf[56] = 0x43; // brightness 4, speed 3
  buf.set([0x11, 0x33, 0x22], 57); // solid colour, stored red/blue/green
  buf[60] = 0x43; // breathing: brightness 4, speed 3
  buf[61] = 7; // all seven breathing colours in use
  buf[129] = 0x02; // 3 mm lift-off
  return buf;
}

test('config offsets stay where the device expects them', () => {
  const cfg = decodeConfig(sampleConfig());
  assert.equal(cfg.sensor.name, 'PMW3360');
  assert.equal(cfg.sensor.maxDpi, 12000);
  assert.equal(cfg.pollingRate, 1000);
  assert.equal(cfg.xyIndependent, false);
  assert.equal(cfg.lod, 2);
  assert.equal(cfg.lodLocked, false);
  assert.equal(cfg.effect, 2);
});

test('DPI stages decode from the enable mask and value bytes', () => {
  const cfg = decodeConfig(sampleConfig());
  assert.deepEqual(cfg.dpi.map((s) => s.enabled), [true, true, false, false, false, false, false, false]);
  assert.equal(cfg.dpi[0].x, 800);
  assert.equal(cfg.dpi[1].x, 1600);
  assert.equal(cfg.dpi[0].color, '#ff0000');
  assert.equal(cfg.dpi[1].color, '#00ff00');
  assert.equal(cfg.activeSlot, 0);
});

test('effect colours use red/blue/green order, DPI colours use red/green/blue', () => {
  const cfg = decodeConfig(sampleConfig());
  // Bytes 11 33 22 read back as #112233 on an RBG device.
  assert.equal(cfg.params[2].colors[0], '#112233');
  assert.equal(cfg.params[2].brightness, 4);
  assert.equal(cfg.params[2].speed, 3);
});

test('a config round trip changes nothing', () => {
  const raw = sampleConfig();
  const out = encodeConfig(decodeConfig(raw));
  assert.deepEqual(Array.from(out), Array.from(raw));
});

test('writing a config sets the command and the write length', () => {
  const cfg = decodeConfig(sampleConfig());
  cfg.configSize = 131;
  const out = encodeConfig(cfg);
  assert.equal(out[1], CMD.GET_CONFIG);
  assert.equal(out[3], 131 - 8, 'write length byte should be 0x7b');
});

test('the active stage is stored as an ordinal over enabled stages only', () => {
  const cfg = decodeConfig(sampleConfig());
  cfg.dpi[0].enabled = false;
  cfg.dpi[1].enabled = true;
  cfg.dpi[4].enabled = true;
  cfg.activeSlot = 4;
  const out = encodeConfig(cfg);
  // Two stages enabled (2 and 5); stage 5 is the second of them.
  assert.equal(out[11] >> 4, 2, 'active ordinal');
  assert.equal(out[11] & 0xf, 2, 'enabled count');
  assert.equal(out[12], 0b11101101, 'disable mask has a bit set per disabled stage');
});

test('at least one DPI stage always survives', () => {
  const cfg = decodeConfig(sampleConfig());
  cfg.dpi.forEach((s) => { s.enabled = false; });
  const out = encodeConfig(cfg);
  assert.equal(out[11] & 0xf, 1);
  assert.equal(out[12] & 1, 0);
});

test('independent axes move the DPI values to two bytes per stage', () => {
  const cfg = decodeConfig(sampleConfig());
  cfg.xyIndependent = true;
  cfg.dpi[0].x = 800;
  cfg.dpi[0].y = 1600;
  const out = encodeConfig(cfg);
  assert.equal(out[10] & 0x80, 0x80, 'independent flag is bit 0x80');
  assert.equal(out[13], 7);
  assert.equal(out[14], 15);

  const back = decodeConfig(out);
  assert.equal(back.xyIndependent, true);
  assert.equal(back.dpi[0].x, 800);
  assert.equal(back.dpi[0].y, 1600);
});

test('a lift-off distance of 0xff is left alone', () => {
  const raw = sampleConfig();
  raw[129] = LOD_EXTERNAL;
  const cfg = decodeConfig(raw);
  assert.equal(cfg.lodLocked, true);
  cfg.lod = 1;
  assert.equal(encodeConfig(cfg)[129], LOD_EXTERNAL);
});

test('DPI values encode the way each sensor wants them', () => {
  // PMW3360 and PMW3327 store one less than the number of hundreds.
  assert.equal(dpiToRaw(800, PMW3360), 7);
  assert.equal(rawToDpi(7, PMW3360), 800);
  // PMW3389 and PMW3212 store the number of hundreds directly.
  assert.equal(dpiToRaw(800, PMW3389), 8);
  assert.equal(rawToDpi(8, PMW3389), 800);
  // And values are clamped to what the sensor can do.
  assert.equal(rawToDpi(dpiToRaw(99999, PMW3360), PMW3360), 12000);
  assert.equal(rawToDpi(dpiToRaw(0, PMW3360), PMW3360), 100);
});

// Every entry here is a byte sequence documented by the reverse-engineering
// work MouseFlash is built on.
const KNOWN_ACTIONS = [
  ['disabled', { type: ACTION.DISABLED }, [0x50, 0x01, 0x00, 0x00]],
  ['left click', { type: ACTION.MOUSE, bits: 0x01 }, [0x11, 0x01, 0x00, 0x00]],
  ['right click', { type: ACTION.MOUSE, bits: 0x02 }, [0x11, 0x02, 0x00, 0x00]],
  ['middle click', { type: ACTION.MOUSE, bits: 0x04 }, [0x11, 0x04, 0x00, 0x00]],
  ['browser back', { type: ACTION.MOUSE, bits: 0x08 }, [0x11, 0x08, 0x00, 0x00]],
  ['browser forward', { type: ACTION.MOUSE, bits: 0x10 }, [0x11, 0x10, 0x00, 0x00]],
  ['scroll up', { type: ACTION.SCROLL, dir: 1 }, [0x12, 0x01, 0x00, 0x00]],
  ['scroll down', { type: ACTION.SCROLL, dir: -1 }, [0x12, 0xff, 0x00, 0x00]],
  ['cycle DPI', { type: ACTION.DPI, mode: 0 }, [0x41, 0x00, 0x00, 0x00]],
  ['DPI up', { type: ACTION.DPI, mode: 1 }, [0x41, 0x01, 0x00, 0x00]],
  ['DPI down', { type: ACTION.DPI, mode: 2 }, [0x41, 0x02, 0x00, 0x00]],
  ['play/pause', { type: ACTION.MEDIA, mask: 0x080000 }, [0x22, 0x08, 0x00, 0x00]],
  ['next track', { type: ACTION.MEDIA, mask: 0x010000 }, [0x22, 0x01, 0x00, 0x00]],
  ['previous track', { type: ACTION.MEDIA, mask: 0x020000 }, [0x22, 0x02, 0x00, 0x00]],
  ['stop', { type: ACTION.MEDIA, mask: 0x040000 }, [0x22, 0x04, 0x00, 0x00]],
  ['mute', { type: ACTION.MEDIA, mask: 0x100000 }, [0x22, 0x10, 0x00, 0x00]],
  ['volume up', { type: ACTION.MEDIA, mask: 0x400000 }, [0x22, 0x40, 0x00, 0x00]],
  ['volume down', { type: ACTION.MEDIA, mask: 0x800000 }, [0x22, 0x80, 0x00, 0x00]],
  ['media player', { type: ACTION.MEDIA, mask: 0x000100 }, [0x22, 0x00, 0x01, 0x00]],
  ['file explorer', { type: ACTION.MEDIA, mask: 0x000200 }, [0x22, 0x00, 0x02, 0x00]],
  ['email', { type: ACTION.MEDIA, mask: 0x001000 }, [0x22, 0x00, 0x10, 0x00]],
  ['calculator', { type: ACTION.MEDIA, mask: 0x002000 }, [0x22, 0x00, 0x20, 0x00]],
  ['home page', { type: ACTION.MEDIA, mask: 0x000002 }, [0x22, 0x00, 0x00, 0x02]],
];

test('button actions match the documented byte sequences', () => {
  for (const [label, action, expected] of KNOWN_ACTIONS) {
    assert.deepEqual(encodeAction(action, PMW3360), expected, label);
  }
});

test('DPI lock encodes through the sensor', () => {
  // 400 DPI on a PMW3360 is 0x03.
  assert.deepEqual(encodeAction({ type: ACTION.DPI_LOCK, dpi: 400 }, PMW3360), [0x42, 0x03, 0x00, 0x00]);
  assert.deepEqual(encodeAction({ type: ACTION.DPI_LOCK, dpi: 1300 }, PMW3360), [0x42, 0x0c, 0x00, 0x00]);
});

test('keyboard shortcuts put the modifiers before the key', () => {
  // Ctrl + Shift + C
  assert.deepEqual(encodeAction({ type: ACTION.KEY, mods: 0x03, key: 0x06 }, PMW3360), [0x21, 0x03, 0x06, 0x00]);
  const back = decodeAction([0x21, 0x03, 0x06, 0x00], PMW3360);
  assert.equal(back.mods, 0x03);
  assert.equal(back.key, 0x06);
});

test('every action survives a round trip', () => {
  const actions = [
    ...KNOWN_ACTIONS.map(([, a]) => a),
    { type: ACTION.KEY, mods: 0x0c, key: 0x2c },
    { type: ACTION.DPI_LOCK, dpi: 1600 },
    { type: ACTION.REPEAT, bits: 0x01, interval: 50, count: 3 },
    { type: ACTION.MACRO, bank: 2, mode: 4, count: 1 },
  ];
  for (const action of actions) {
    const back = decodeAction(encodeAction(action, PMW3360), PMW3360);
    for (const [key, value] of Object.entries(action)) {
      assert.equal(back[key], value, `${action.type}.${key}`);
    }
  }
});

test('the button report keeps its header and pads unused slots', () => {
  const base = new Uint8Array(REPORT_SIZE);
  base.set([0x04, 0x12, 0x00, 0x00, 0, 0, 0, 0], 0);
  for (let i = 0; i < 20; i++) base.set([0x50, 0x01, 0, 0], 8 + i * 4);

  const actions = [
    { type: ACTION.MOUSE, bits: 0x01 },
    { type: ACTION.MOUSE, bits: 0x02 },
    { type: ACTION.MOUSE, bits: 0x04 },
    { type: ACTION.MOUSE, bits: 0x08 },
    { type: ACTION.MOUSE, bits: 0x10 },
    { type: ACTION.DPI, mode: 0 },
  ];
  const out = encodeButtons(base, actions, PMW3360);

  assert.equal(out[1], CMD.GET_BUTTONS);
  assert.equal(out[3], BUTTON_SIZE - 8, 'write length byte should be 0x50');
  assert.deepEqual(Array.from(out.subarray(8, 12)), [0x11, 0x01, 0x00, 0x00]);
  assert.deepEqual(Array.from(out.subarray(28, 32)), [0x41, 0x00, 0x00, 0x00]);
  // Slots past the mouse's real buttons stay disabled.
  assert.deepEqual(Array.from(out.subarray(32, 36)), [0x50, 0x01, 0x00, 0x00]);
  // And nothing is written past the button block.
  assert.equal(out.subarray(BUTTON_SIZE).every((b) => b === 0), true);

  const back = decodeButtons(out, 6, PMW3360);
  assert.equal(back.length, 6);
  assert.equal(back[5].type, ACTION.DPI);
});

test('macro events pack state, kind, and a 12 bit delay', () => {
  const events = [
    { kind: MACRO_EVENT.KEY, code: 0x04, down: true, delay: 50 },
    { kind: MACRO_EVENT.KEY, code: 0x04, down: false, delay: 50 },
    { kind: MACRO_EVENT.MOUSE, code: 0x01, down: true, delay: 1 },
    { kind: MACRO_EVENT.MOUSE, code: 0x01, down: false, delay: 1 },
    { kind: MACRO_EVENT.MODIFIER, code: 0x02, down: true, delay: 300 },
  ];
  const buf = encodeMacro(3, events);

  assert.equal(buf[0], 0x04);
  assert.equal(buf[1], CMD.MACRO);
  assert.equal(buf[2], 0x02);
  assert.equal(buf[8], 3, 'bank number');
  assert.equal(buf[10], 5, 'event count');

  assert.deepEqual(Array.from(buf.subarray(11, 14)), [0x50, 50, 0x04], 'key press');
  assert.deepEqual(Array.from(buf.subarray(14, 17)), [0xd0, 50, 0x04], 'key release');
  assert.deepEqual(Array.from(buf.subarray(17, 20)), [0x10, 1, 0x01], 'mouse press');
  assert.deepEqual(Array.from(buf.subarray(20, 23)), [0x90, 1, 0x01], 'mouse release');
  // 300 ms is 0x12c: the high nibble rides in the first byte.
  assert.deepEqual(Array.from(buf.subarray(23, 26)), [0x61, 0x2c, 0x02], 'modifier press');

  assert.deepEqual(decodeMacro(buf).events, events);
  assert.equal(decodeMacro(buf).bank, 3);
});

test('a zero delay becomes 1ms, because the mouse skips zero-delay events', () => {
  const buf = encodeMacro(1, [{ kind: MACRO_EVENT.KEY, code: 0x04, down: true, delay: 0 }]);
  assert.equal(buf[12], 1);
});

test('macros are capped at what the mouse can store', () => {
  const many = Array.from({ length: 200 }, () => ({ kind: MACRO_EVENT.KEY, code: 4, down: true, delay: 1 }));
  const buf = encodeMacro(1, many);
  assert.equal(buf[10], 168);
  assert.equal(buf.length, REPORT_SIZE);
});

test('debounce is stored as half the millisecond value', () => {
  assert.equal(debounceToRaw(4), 2);
  assert.equal(debounceToRaw(10), 5);
  assert.equal(debounceToRaw(16), 8);
  // Odd or out-of-range values snap to the nearest supported step.
  assert.equal(debounceToRaw(7), 3);
  assert.equal(debounceToRaw(100), 8);
});
