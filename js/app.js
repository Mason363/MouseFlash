// MouseFlash UI.
//
// State lives in one `state` object. Anything that changes it calls `markDirty`
// and re-renders the affected panel. Nothing reaches the mouse until you press
// APPLY, apart from macro slots, which have their own write button.

import { Mouse, grantedDevices, isSupported, requestDevice } from './hid.js';
import { ART, GENERIC_ART, layoutFor, supportedNames } from './devices.js';
import {
  ACTION, BRIGHTNESS_MAX, DEBOUNCE_TIMES, DPI_MIN, DPI_MODES, DPI_SLOTS, DPI_STEP,
  EFFECTS, MACRO_BANKS, MACRO_EVENT, MACRO_MAX_EVENTS, MACRO_MODES, POLLING_RATES,
  SPEED_MAX, decodeButtons, decodeConfig,
} from './protocol.js';
import {
  CODE_TO_MODIFIER, CODE_TO_USAGE, KEYS, MEDIA, MODIFIERS, MOUSE_BITS,
  keyName, mediaName, modifiersToText, mouseBitName,
} from './keys.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  mouse: null,
  config: null,
  actions: [],
  debounce: 10,
  macros: loadMacros(),
  bank: 1,
  selected: 0,
  dirty: false,
  recording: false,
  lastEventAt: 0,
  dragFrom: -1,
  capturing: false,
};

// `state.selected` is a row in the displayed layout, not a protocol slot. The
// two differ for the side buttons; see layoutFor().
const rows = () => layoutFor(state.mouse ? state.mouse.buttonCount : 6);
const rowSlot = (i) => rows()[i].slot;
const buttonName = (i) => rows()[i].name;
const selectedAction = () => state.actions[rowSlot(state.selected)];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
}

let toastTimer;
function toast(message, kind = 'info') {
  const node = $('#toast');
  node.textContent = message;
  node.dataset.kind = kind;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, kind === 'error' ? 7000 : 3000);
}

function markDirty(dirty = true) {
  state.dirty = dirty;
  $('#dirty-flag').hidden = !dirty;
}

function field(label, control, ...extra) {
  return el('div', { class: 'field' }, [el('label', { text: label }), control, ...extra]);
}

function select(options, value, onChange) {
  const node = el('select', { onchange: (e) => onChange(e.target.value) });
  for (const o of options) {
    node.append(el('option', { value: o.value, selected: String(o.value) === String(value) },
      [document.createTextNode(o.label)]));
  }
  return node;
}

// ---------------------------------------------------------------------------
// connection
// ---------------------------------------------------------------------------

async function connect(device) {
  const mouse = new Mouse(device);
  await mouse.open();

  state.mouse = mouse;
  state.config = await mouse.readConfig();
  state.actions = await mouse.readButtons(state.config.sensor);
  state.debounce = 10;   // not readable from the mouse
  state.selected = 0;
  markDirty(false);

  $('#view-connect').hidden = true;
  $('#view-main').hidden = false;
  $('#device-chip').hidden = false;
  $('#topbar-actions').hidden = false;
  $('#device-name').textContent = mouse.name;
  $('#device-meta').textContent = [
    mouse.firmware || null,
    state.config.sensor.known ? state.config.sensor.name : 'unknown sensor',
  ].filter(Boolean).join(' · ');
  $('#unknown-device').hidden = mouse.info.recognized;

  setArt();
  renderAll();
  toast(`Connected to ${mouse.name}`);
}

function setArt() {
  const art = ART[state.mouse.info.art] || GENERIC_ART;
  const frame = $('#mouse-art');
  const img = $('#mouse-img');

  img.src = art.src;
  img.alt = `${state.mouse.name}, viewed from above`;
  frame.classList.toggle('wide', Boolean(art.wide));
  $('#model-name').textContent = art.caption === 'Generic layout'
    ? state.mouse.name
    : art.caption;

  const host = $('#callouts');
  host.replaceChildren();
  if (!art.points) return;

  for (let i = 0; i < Math.min(art.points.length, rows().length); i++) {
    const p = art.points[i];
    const cal = el('button', {
      class: 'cal',
      style: `left:${p.x}%;top:${p.y}%`,
      title: buttonName(i),
      'data-button': i,
      onclick: () => selectButton(i),
    }, [document.createTextNode(String(i + 1))]);
    acceptDrop(cal, i);
    host.append(cal);
  }
}

async function onConnectClick() {
  try {
    const device = await requestDevice();
    if (!device) {
      toast('No mouse was picked. If the prompt listed nothing, the browser cannot see a supported mouse.', 'error');
      return;
    }
    await connect(device);
  } catch (err) {
    toast(describe(err), 'error');
  }
}

function describe(err) {
  const message = err && err.message ? err.message : String(err);
  if (/access denied|not allowed/i.test(message)) {
    return 'The browser refused access to the mouse. On Linux you may need a udev rule; on Windows, close the vendor software first.';
  }
  return message;
}

async function save() {
  const { mouse, config, actions } = state;
  if (!mouse) return;
  const button = $('#btn-save');
  button.disabled = true;
  try {
    await mouse.writeConfig(config);
    await mouse.writeButtons(actions, config.sensor);
    await mouse.setDebounce(state.debounce);

    // A button pointing at a macro slot is useless unless the slot itself is
    // on the mouse. Without this the button fires an empty slot and Apply
    // looks like it did nothing.
    const banks = [...new Set(actions.filter((a) => a.type === ACTION.MACRO).map((a) => a.bank))];
    let written = 0;
    for (const bank of banks) {
      const events = state.macros[bank] || [];
      if (events.length) { await mouse.writeMacro(bank, events); written++; }
    }

    markDirty(false);
    toast(written
      ? `Written to the mouse, including ${written} macro slot${written > 1 ? 's' : ''}`
      : 'Written to the mouse');
  } catch (err) {
    toast(`Apply failed: ${describe(err)}`, 'error');
  } finally {
    button.disabled = false;
  }
}

async function reload() {
  if (!state.mouse) return;
  try {
    state.config = await state.mouse.readConfig();
    state.actions = await state.mouse.readButtons(state.config.sensor);
    markDirty(false);
    renderAll();
    toast('Reloaded from the mouse');
  } catch (err) {
    toast(`Reload failed: ${describe(err)}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// buttons
// ---------------------------------------------------------------------------

function actionSummary(action) {
  switch (action.type) {
    case ACTION.MOUSE: return mouseBitName(action.bits);
    case ACTION.SCROLL: return action.dir < 0 ? 'Scroll down' : 'Scroll up';
    case ACTION.KEY: {
      const mods = modifiersToText(action.mods);
      return mods ? `${mods} + ${keyName(action.key)}` : keyName(action.key);
    }
    case ACTION.MEDIA: return mediaName(action.mask);
    case ACTION.REPEAT: return `${mouseBitName(action.bits)} x${action.count}`;
    case ACTION.DPI: return (DPI_MODES.find((m) => m.value === action.mode) || {}).name || 'DPI';
    case ACTION.DPI_LOCK: return `Hold ${action.dpi} DPI`;
    case ACTION.MACRO: return `Macro slot ${action.bank}`;
    default: return 'Disabled';
  }
}

function renderButtonList() {
  const list = $('#button-list');
  list.replaceChildren();
  rows().forEach((row, i) => {
    const node = el('button', {
      class: 'brow',
      'aria-current': String(i === state.selected),
      onclick: () => selectButton(i),
    }, [
      el('span', { class: 'n', text: String(i + 1) }),
      el('span', { class: 'nm', text: row.name }),
      el('span', { class: 'as', text: actionSummary(state.actions[row.slot]) }),
    ]);
    acceptDrop(node, i);
    list.append(node);
  });
}

function selectButton(i) {
  state.selected = i;
  renderButtonList();
  renderActionEditor();
  syncCallouts();
  const panel = document.querySelector('.acc');
  if (panel && !panel.open) panel.open = true;
}

function syncCallouts() {
  for (const node of document.querySelectorAll('#callouts .cal')) {
    node.dataset.selected = String(Number(node.dataset.button) === state.selected);
  }
}

function setAction(action) {
  state.actions[rowSlot(state.selected)] = action;
  markDirty();
  renderButtonList();
  renderActionEditor();
}

// Actions offered as a flat grid. Picking one assigns it immediately; the few
// that need settings reveal them underneath. This replaces a category dropdown
// feeding a second dropdown, which meant two guesses before seeing anything.
const CHIPS = [
  { g: 'Mouse', label: 'Left click', make: () => ({ type: ACTION.MOUSE, bits: 0x01 }), is: (a) => a.type === ACTION.MOUSE && a.bits === 0x01 },
  { g: 'Mouse', label: 'Right click', make: () => ({ type: ACTION.MOUSE, bits: 0x02 }), is: (a) => a.type === ACTION.MOUSE && a.bits === 0x02 },
  { g: 'Mouse', label: 'Middle click', make: () => ({ type: ACTION.MOUSE, bits: 0x04 }), is: (a) => a.type === ACTION.MOUSE && a.bits === 0x04 },
  { g: 'Mouse', label: 'Back', make: () => ({ type: ACTION.MOUSE, bits: 0x08 }), is: (a) => a.type === ACTION.MOUSE && a.bits === 0x08 },
  { g: 'Mouse', label: 'Forward', make: () => ({ type: ACTION.MOUSE, bits: 0x10 }), is: (a) => a.type === ACTION.MOUSE && a.bits === 0x10 },
  { g: 'Mouse', label: 'Scroll up', make: () => ({ type: ACTION.SCROLL, dir: 1 }), is: (a) => a.type === ACTION.SCROLL && a.dir > 0 },
  { g: 'Mouse', label: 'Scroll down', make: () => ({ type: ACTION.SCROLL, dir: -1 }), is: (a) => a.type === ACTION.SCROLL && a.dir < 0 },

  { g: 'DPI', label: 'Cycle DPI', make: () => ({ type: ACTION.DPI, mode: 0 }), is: (a) => a.type === ACTION.DPI && a.mode === 0 },
  { g: 'DPI', label: 'DPI up', make: () => ({ type: ACTION.DPI, mode: 1 }), is: (a) => a.type === ACTION.DPI && a.mode === 1 },
  { g: 'DPI', label: 'DPI down', make: () => ({ type: ACTION.DPI, mode: 2 }), is: (a) => a.type === ACTION.DPI && a.mode === 2 },
  { g: 'DPI', label: 'Hold a DPI', make: () => ({ type: ACTION.DPI_LOCK, dpi: 800 }), is: (a) => a.type === ACTION.DPI_LOCK, opts: true },

  { g: 'Other', label: 'Keyboard', make: () => ({ type: ACTION.KEY, mods: 0, key: 0x04 }), is: (a) => a.type === ACTION.KEY, opts: true },
  { g: 'Other', label: 'Media', make: () => ({ type: ACTION.MEDIA, mask: MEDIA[0].mask }), is: (a) => a.type === ACTION.MEDIA, opts: true },
  { g: 'Other', label: 'Macro', make: () => ({ type: ACTION.MACRO, bank: state.bank, mode: 1, count: 1 }), is: (a) => a.type === ACTION.MACRO, opts: true },
  { g: 'Other', label: 'Rapid fire', make: () => ({ type: ACTION.REPEAT, bits: 0x01, interval: 50, count: 3 }), is: (a) => a.type === ACTION.REPEAT, opts: true },
  { g: 'Other', label: 'Nothing', make: () => ({ type: ACTION.DISABLED }), is: (a) => a.type === ACTION.DISABLED },
];

/** Let a node accept an action chip dropped onto it. */
function acceptDrop(node, row) {
  const TYPE = 'application/x-mouseflash';
  node.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes(TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    node.classList.add('drop');
  });
  node.addEventListener('dragleave', () => node.classList.remove('drop'));
  node.addEventListener('drop', (e) => {
    const raw = e.dataTransfer.getData(TYPE);
    node.classList.remove('drop');
    if (!raw) return;
    e.preventDefault();
    setActionAt(row, JSON.parse(raw));
    toast(`${buttonName(row)}: ${actionSummary(state.actions[rowSlot(row)])}`);
  });
}

/** Assign to a row other than the selected one, used by drag and drop. */
function setActionAt(row, action) {
  state.actions[rowSlot(row)] = action;
  markDirty();
  renderButtonList();
  renderActionEditor();
}

function comboText(mods, key) {
  const m = modifiersToText(mods);
  return m ? `${m} + ${keyName(key)}` : keyName(key);
}

function renderActionEditor() {
  const host = $('#action-editor');
  const action = selectedAction();
  host.replaceChildren();

  host.append(el('div', { class: 'editor-title' }, [
    document.createTextNode(`${state.selected + 1} · `),
    el('b', { text: buttonName(state.selected) }),
  ]));

  let group = null;
  let grid = null;
  for (const chip of CHIPS) {
    if (chip.g !== group) {
      group = chip.g;
      host.append(el('div', { class: 'grp', text: group }));
      grid = el('div', { class: 'chips' });
      host.append(grid);
    }
    const on = chip.is(action);
    grid.append(el('button', {
      class: 'chip', 'aria-pressed': String(on), draggable: 'true', text: chip.label,
      onclick: () => setAction(on && chip.opts ? action : chip.make()),
      ondragstart: (e) => {
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('application/x-mouseflash', JSON.stringify(chip.make()));
        e.dataTransfer.setData('text/plain', chip.label);
      },
    }));
  }

  const patch = (changes) => setAction({ ...action, ...changes });
  const opts = el('div', { class: 'opts' });

  switch (action.type) {
    case ACTION.KEY: {
      const mods = el('div', { class: 'chips' });
      for (const m of MODIFIERS) {
        mods.append(el('button', {
          class: 'chip', 'aria-pressed': String((action.mods & m.bit) !== 0),
          text: m.glyph ? `${m.glyph}  ${m.name}` : m.name,
          onclick: () => patch({ mods: action.mods ^ m.bit }),
        }));
      }

      // Type to filter rather than scrolling a hundred entries.
      const listId = 'keylist';
      if (!document.getElementById(listId)) {
        const dl = el('datalist', { id: listId });
        for (const k of KEYS) dl.append(el('option', { value: k.name }));
        document.body.append(dl);
      }
      const box = el('input', {
        type: 'text', list: listId, value: keyName(action.key), placeholder: 'Type a key',
        onchange: (e) => {
          const hit = KEYS.find((k) => k.name.toLowerCase() === e.target.value.trim().toLowerCase());
          if (hit) patch({ key: hit.usage }); else renderActionEditor();
        },
      });

      const grab = el('button', {
        class: 'slab', text: 'Press keys',
        onclick: (e) => startCapture(e.currentTarget, (m, k) => setAction({ type: ACTION.KEY, mods: m, key: k })),
      });

      // A browsable list as well; typing only helps once you know the name.
      const all = select(KEYS.map((k) => ({ value: k.usage, label: k.name })), action.key,
        (v) => patch({ key: Number(v) }));

      opts.append(el('div', { class: 'grp', text: 'Modifiers' }));
      opts.append(mods);
      opts.append(el('div', { class: 'grp', text: 'Key' }));
      opts.append(field('Search', box, grab));
      opts.append(field('All keys', all));
      opts.append(el('p', { class: 'note', text: `Sends ${comboText(action.mods, action.key)}. Combinations the system takes first, such as Command and Tab, have to be chosen from the list rather than captured.` }));
      break;
    }

    case ACTION.MEDIA: {
      const grid2 = el('div', { class: 'chips' });
      for (const m of MEDIA) {
        grid2.append(el('button', {
          class: 'chip', 'aria-pressed': String(action.mask === m.mask), text: m.name,
          onclick: () => patch({ mask: m.mask }),
        }));
      }
      opts.append(grid2);
      break;
    }

    case ACTION.DPI_LOCK:
      opts.append(field('DPI while held', el('input', {
        type: 'number', min: DPI_MIN, max: state.config.sensor.maxDpi, step: DPI_STEP,
        value: action.dpi, onchange: (e) => patch({ dpi: Number(e.target.value) }),
      })));
      break;

    case ACTION.REPEAT:
      opts.append(field('Clicks', select(MOUSE_BITS.slice(0, 3).map((m) => ({ value: m.bit, label: m.name })),
        action.bits, (v) => patch({ bits: Number(v) }))));
      opts.append(field('How many', el('input', {
        type: 'number', min: 1, max: 255, value: action.count,
        onchange: (e) => patch({ count: Number(e.target.value) }),
      })));
      opts.append(field('Gap (ms)', el('input', {
        type: 'number', min: 1, max: 255, value: action.interval,
        onchange: (e) => patch({ interval: Number(e.target.value) }),
      })));
      break;

    case ACTION.MACRO: {
      const banks = Array.from({ length: MACRO_BANKS }, (_, i) => ({
        value: i + 1,
        label: `Slot ${i + 1}${(state.macros[i + 1] || []).length ? ` (${state.macros[i + 1].length})` : ' (empty)'}`,
      }));
      opts.append(field('Slot', select(banks, action.bank, (v) => patch({ bank: Number(v) }))));
      opts.append(field('Repeat', select(MACRO_MODES.map((m) => ({ value: m.value, label: m.name })),
        action.mode, (v) => patch({ mode: Number(v) }))));
      if (action.mode === 1) {
        opts.append(field('Times', el('input', {
          type: 'number', min: 1, max: 255, value: action.count,
          onchange: (e) => patch({ count: Number(e.target.value) }),
        })));
      }
      opts.append(el('button', { class: 'slab wide', text: 'Open macro editor', onclick: () => $('#btn-macro-open').click() }));
      break;
    }

    default: break;
  }

  if (opts.childElementCount) host.append(opts);
}

/** Read one key combination straight from the keyboard. */
function startCapture(button, done) {
  if (state.capturing) return;
  state.capturing = true;
  const label = button.textContent;
  button.textContent = 'Press now';
  button.classList.add('on');

  const stop = () => {
    state.capturing = false;
    button.textContent = label;
    button.classList.remove('on');
    window.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') { stop(); return; }
    const usage = CODE_TO_USAGE.get(e.code);
    if (usage === undefined) return;   // a bare modifier, wait for the real key
    let mods = 0;
    if (e.ctrlKey) mods |= 0x01;
    if (e.shiftKey) mods |= 0x02;
    if (e.altKey) mods |= 0x04;
    if (e.metaKey) mods |= 0x08;
    stop();
    done(mods, usage);
  };
  window.addEventListener('keydown', onKey, true);
}


// ---------------------------------------------------------------------------
// DPI
// ---------------------------------------------------------------------------

function renderDpi() {
  const cfg = state.config;

  $('#polling-rate').replaceChildren(...POLLING_RATES.map((r) => el('option', {
    value: r, selected: r === cfg.pollingRate,
  }, [document.createTextNode(`${r} Hz`)])));
  $('#xy-independent').checked = cfg.xyIndependent;

  const list = $('#dpi-list');
  list.replaceChildren();

  for (let i = 0; i < DPI_SLOTS; i++) {
    const stage = cfg.dpi[i];
    const max = cfg.sensor.maxDpi;

    // Slider and number box drive each other directly. Re-rendering on every
    // input event would replace the element under the pointer mid-drag.
    const number = el('input', { type: 'number', min: DPI_MIN, max, step: DPI_STEP, value: stage.x });
    const range = el('input', { type: 'range', min: DPI_MIN, max, step: DPI_STEP, value: stage.x });

    const apply = (value, ...echo) => {
      stage.x = value;
      if (!cfg.xyIndependent) stage.y = value;
      for (const n of echo) n.value = value;
      markDirty();
    };
    range.addEventListener('input', (e) => apply(Number(e.target.value), number));
    number.addEventListener('change', (e) => apply(Number(e.target.value), range));

    const xy = el('div', { class: 'xy' }, [number]);
    if (cfg.xyIndependent) {
      const yBox = el('input', { type: 'number', min: DPI_MIN, max, step: DPI_STEP, value: stage.y });
      yBox.addEventListener('change', (e) => { stage.y = Number(e.target.value); markDirty(); });
      xy.append(el('span', { class: 'u', text: 'X' }), yBox, el('span', { class: 'u', text: 'Y' }));
    }

    list.append(el('div', {
      class: 'stage-row',
      'data-enabled': String(stage.enabled),
      'data-active': String(i === cfg.activeSlot),
    }, [
      el('span', { class: 'sn', text: String(i + 1) }),
      el('input', {
        type: 'checkbox', checked: stage.enabled, title: 'Include in the DPI cycle',
        onchange: (e) => { stage.enabled = e.target.checked; markDirty(); renderDpi(); },
      }),
      range,
      xy,
      el('input', {
        type: 'radio', name: 'active-dpi', checked: i === cfg.activeSlot,
        disabled: !stage.enabled, title: 'Use this stage now',
        onchange: () => { cfg.activeSlot = i; markDirty(); renderDpi(); },
      }),
    ]));
  }
}

// ---------------------------------------------------------------------------
// lighting
// ---------------------------------------------------------------------------

function renderLighting() {
  const cfg = state.config;

  $('#effect').replaceChildren(...EFFECTS.map((e) => el('option', {
    value: e.id, selected: e.id === cfg.effect,
  }, [document.createTextNode(e.name)])));

  const spec = EFFECTS[cfg.effect] || EFFECTS[0];
  const params = cfg.params[cfg.effect] || {};
  const host = $('#effect-params');
  host.replaceChildren();

  // Sliders update their own readout rather than re-rendering, so a drag survives.
  const scale = (label, key, maxValue) => {
    const value = Math.min(Math.max(params[key] || 1, 1), maxValue);
    params[key] = value;
    const out = el('span', { class: 'out', text: `${value}/${maxValue}` });
    const range = el('input', { type: 'range', min: 1, max: maxValue, step: 1, value });
    range.addEventListener('input', (e) => {
      params[key] = Number(e.target.value);
      out.textContent = `${params[key]}/${maxValue}`;
      markDirty();
    });
    host.append(field(label, range, out));
  };

  if (spec.params.includes('speed')) scale('Speed', 'speed', SPEED_MAX);
  if (spec.params.includes('brightness')) scale('Brightness', 'brightness', BRIGHTNESS_MAX);

  if (spec.params.includes('direction')) {
    host.append(field('Direction', select(
      [{ value: 1, label: 'Forward' }, { value: 0, label: 'Backward' }],
      params.direction, (v) => { params.direction = Number(v); markDirty(); })));
  }

  if (spec.params.includes('colorCount')) {
    host.append(field('Colours', el('input', {
      type: 'number', min: 1, max: spec.colors, value: params.colorCount || spec.colors,
      onchange: (e) => { params.colorCount = Number(e.target.value); markDirty(); renderLighting(); },
    })));
  }

  if (spec.colors > 0) {
    const shown = spec.params.includes('colorCount')
      ? Math.min(Math.max(params.colorCount || spec.colors, 1), spec.colors)
      : spec.colors;
    const swatches = el('div', { class: 'swatches' });
    for (let i = 0; i < shown; i++) {
      swatches.append(el('input', {
        type: 'color',
        value: (params.colors && params.colors[i]) || '#ffffff',
        title: `Colour ${i + 1}`,
        oninput: (e) => { params.colors[i] = e.target.value; markDirty(); },
      }));
    }
    host.append(field(shown === 1 ? 'Colour' : 'Palette', swatches));
  }

  $('#lighting-note').hidden = cfg.effect === 0;
}

// ---------------------------------------------------------------------------
// macros
// ---------------------------------------------------------------------------

function loadMacros() {
  try { return JSON.parse(localStorage.getItem('mouseflash.macros') || '{}'); }
  catch { return {}; }
}

function saveMacros() {
  try { localStorage.setItem('mouseflash.macros', JSON.stringify(state.macros)); }
  catch { /* private browsing; the macro still writes to the mouse */ }
}

function currentMacro() {
  if (!state.macros[state.bank]) state.macros[state.bank] = [];
  return state.macros[state.bank];
}

function macroEventName(ev) {
  if (ev.kind === MACRO_EVENT.MOUSE) return mouseBitName(ev.code);
  if (ev.kind === MACRO_EVENT.MODIFIER) return modifiersToText(ev.code) || 'Modifier';
  return keyName(ev.code);
}

function renderMacros() {
  $('#macro-bank').replaceChildren(...Array.from({ length: MACRO_BANKS }, (_, i) => {
    const n = i + 1;
    const count = (state.macros[n] || []).length;
    return el('option', { value: n, selected: n === state.bank },
      [document.createTextNode(`Slot ${n}${count ? ` (${count})` : ' (empty)'}`)]);
  }));

  const mouseRow = $('#macro-mouse-row');
  mouseRow.replaceChildren(el('label', { text: 'Add a click' }));
  for (const m of MOUSE_BITS.slice(0, 3)) {
    mouseRow.append(el('button', {
      class: 'slab',
      text: m.name.replace(' Click', ''),
      onclick: () => {
        const events = currentMacro();
        events.push({ kind: MACRO_EVENT.MOUSE, code: m.bit, down: true, delay: 1 });
        events.push({ kind: MACRO_EVENT.MOUSE, code: m.bit, down: false, delay: 30 });
        saveMacros();
        renderMacros();
      },
    }));
  }

  // Insert a single key without recording.
  const keyRow = $('#macro-key-row');
  const keyPick = select(KEYS.map((k) => ({ value: k.usage, label: k.name })), 0x04, () => {});
  keyRow.replaceChildren(
    el('label', { text: 'Add a key' }),
    keyPick,
    el('button', {
      class: 'slab', text: 'Add',
      onclick: () => {
        const code = Number(keyPick.value);
        const ev = currentMacro();
        ev.push({ kind: MACRO_EVENT.KEY, code, down: true, delay: 1 });
        ev.push({ kind: MACRO_EVENT.KEY, code, down: false, delay: 30 });
        saveMacros();
        renderMacros();
      },
    }),
  );

  const events = currentMacro();
  const host = $('#macro-events');
  host.replaceChildren();

  const move = (from, to) => {
    if (from === to || from < 0 || to < 0 || to > events.length) return;
    events.splice(to, 0, events.splice(from, 1)[0]);
    saveMacros();
    renderMacros();
  };
  const clearMarks = () => {
    for (const n of host.children) n.classList.remove('over-up', 'over-down');
  };

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const row = el('div', { class: 'mev', draggable: 'true' }, [
      el('span', { class: 'grip', title: 'Drag to reorder', text: '≡' }),
      el('span', { class: 'i', text: String(i + 1) }),
      el('span', { text: macroEventName(ev) }),
      el('span', { class: 'st', text: ev.down ? 'press' : 'release' }),
      el('input', {
        type: 'number', min: 1, max: 4095, value: ev.delay, title: 'Delay before this event, in ms',
        onchange: (e) => { ev.delay = Number(e.target.value); saveMacros(); },
      }),
      el('button', {
        class: 'del', title: 'Remove', text: '×',
        onclick: () => { events.splice(i, 1); saveMacros(); renderMacros(); },
      }),
    ]);

    row.addEventListener('dragstart', (e) => {
      state.dragFrom = i;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(i));
    });
    row.addEventListener('dragend', () => { row.classList.remove('dragging'); clearMarks(); });
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const after = e.offsetY > row.offsetHeight / 2;
      row.classList.toggle('over-down', after);
      row.classList.toggle('over-up', !after);
    });
    row.addEventListener('dragleave', () => row.classList.remove('over-up', 'over-down'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      clearMarks();
      const after = e.offsetY > row.offsetHeight / 2;
      let to = i + (after ? 1 : 0);
      const from = state.dragFrom;
      if (from < to) to -= 1;
      move(from, to);
    });

    host.append(row);
  }


  $('#macro-count').textContent = events.length
    ? `${events.length} of ${MACRO_MAX_EVENTS} events. Delays are milliseconds.`
    : 'No events yet. Press Record and type, or add a click or key below.';
  $('#btn-macro-write').disabled = events.length === 0;
}

function toggleRecording(force) {
  state.recording = force === undefined ? !state.recording : force;
  const button = $('#btn-record');
  button.textContent = state.recording ? 'Stop' : 'Record';
  button.classList.toggle('rec', state.recording);
  $('#record-hint').textContent = state.recording
    ? 'Recording. Every key press and release is captured with its timing.'
    : 'Recording captures key presses and releases with their real timing. Clicks are added with the buttons below, since clicking the page would record itself.';
  state.lastEventAt = performance.now();
}

function onRecordKey(e) {
  if (!state.recording || state.capturing) return;
  e.preventDefault();
  if (e.repeat) return;

  const events = currentMacro();
  if (events.length >= MACRO_MAX_EVENTS) {
    toggleRecording(false);
    toast(`A macro holds at most ${MACRO_MAX_EVENTS} events`, 'error');
    return;
  }

  const modifier = CODE_TO_MODIFIER.get(e.code);
  const usage = CODE_TO_USAGE.get(e.code);
  if (modifier === undefined && usage === undefined) return;

  const now = performance.now();
  const delay = Math.min(Math.max(Math.round(now - state.lastEventAt), 1), 4095);
  state.lastEventAt = now;

  events.push({
    kind: modifier !== undefined ? MACRO_EVENT.MODIFIER : MACRO_EVENT.KEY,
    code: modifier !== undefined ? modifier : usage,
    down: e.type === 'keydown',
    delay,
  });
  saveMacros();
  renderMacros();
}

async function writeMacro() {
  const events = currentMacro();
  if (!state.mouse || events.length === 0) return;
  try {
    await state.mouse.writeMacro(state.bank, events);
    toast(`Wrote ${events.length} events to slot ${state.bank}`);
  } catch (err) {
    toast(`Could not write the macro: ${describe(err)}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// device panel and backup
// ---------------------------------------------------------------------------

function renderSettings() {
  const cfg = state.config;

  $('#debounce').replaceChildren(...DEBOUNCE_TIMES.map((ms) => el('option', {
    value: ms, selected: ms === state.debounce,
  }, [document.createTextNode(`${ms} ms`)])));

  const lod = $('#lod');
  lod.value = String(cfg.lod === 1 ? 1 : 2);
  lod.disabled = cfg.lodLocked;
  $('#lod-locked').hidden = !cfg.lodLocked;

  const facts = $('#device-facts');
  facts.replaceChildren();
  const rows = [
    ['Model', state.mouse.name],
    ['USB', `${hex4(state.mouse.device.vendorId)}:${hex4(state.mouse.device.productId)}`],
    ['Firmware', state.mouse.firmware || 'unknown'],
    ['Sensor', cfg.sensor.known ? `${cfg.sensor.name}, max ${cfg.sensor.maxDpi}` : `unknown (0x${cfg.sensor.id.toString(16)})`],
    ['Config', `report ${state.mouse.reportId}, ${state.mouse.configSize} bytes`],
    ['Buttons', String(state.mouse.buttonCount)],
  ];
  for (const [term, value] of rows) facts.append(el('dt', { text: term }), el('dd', { text: value }));
}

const hex4 = (n) => n.toString(16).padStart(4, '0');
const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function fromHex(text) {
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.substr(i * 2, 2), 16);
  return out;
}

function exportBackup() {
  const { mouse, config } = state;
  const payload = {
    app: 'MouseFlash',
    version: 1,
    exportedAt: new Date().toISOString(),
    device: {
      vendorId: mouse.device.vendorId,
      productId: mouse.device.productId,
      name: mouse.name,
      firmware: mouse.firmware,
      configSize: mouse.configSize,
    },
    // The raw reports are the real backup: every byte, known or not.
    configRaw: toHex(config.raw),
    buttonRaw: mouse.buttonRaw ? toHex(mouse.buttonRaw) : null,
    debounce: state.debounce,
    macros: state.macros,
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const name = `mouseflash-${hex4(mouse.device.vendorId)}-${hex4(mouse.device.productId)}.json`;
  const link = el('a', { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  toast(`Saved ${name}`);
}

async function importBackup(file) {
  try {
    const payload = JSON.parse(await file.text());
    if (payload.app !== 'MouseFlash' || !payload.configRaw) {
      throw new Error('That file is not a MouseFlash backup.');
    }
    const sameDevice = payload.device
      && payload.device.vendorId === state.mouse.device.vendorId
      && payload.device.productId === state.mouse.device.productId;
    if (!sameDevice && !confirm('That backup came from a different mouse. Restoring it could set values this mouse does not support. Continue?')) {
      return;
    }

    state.config = decodeConfig(fromHex(payload.configRaw), {
      configSize: state.mouse.configSize,
      ledOrder: 'rbg',
    });
    if (payload.buttonRaw) {
      const raw = fromHex(payload.buttonRaw);
      state.mouse.buttonRaw = raw;
      state.actions = decodeButtons(raw, state.mouse.buttonCount, state.config.sensor);
    }
    if (payload.debounce) state.debounce = payload.debounce;
    if (payload.macros) { state.macros = payload.macros; saveMacros(); }

    markDirty();
    renderAll();
    toast('Backup loaded. Press APPLY to write it to the mouse.');
  } catch (err) {
    toast(`Import failed: ${describe(err)}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

function renderAll() {
  renderButtonList();
  renderActionEditor();
  syncCallouts();
  renderDpi();
  renderLighting();
  renderMacros();
  renderSettings();
}

function init() {
  $('#supported-list').replaceChildren(...supportedNames().map((n) => el('li', { text: n })));

  if (!isSupported()) {
    $('#unsupported').hidden = false;
    $('#btn-connect').disabled = true;
    $('#connect-hint').hidden = true;
    return;
  }

  $('#btn-connect').addEventListener('click', onConnectClick);
  $('#btn-save').addEventListener('click', save);
  $('#btn-reload').addEventListener('click', reload);

  $('#polling-rate').addEventListener('change', (e) => {
    state.config.pollingRate = Number(e.target.value);
    markDirty();
  });
  $('#xy-independent').addEventListener('change', (e) => {
    state.config.xyIndependent = e.target.checked;
    markDirty();
    renderDpi();
  });
  $('#effect').addEventListener('change', (e) => {
    state.config.effect = Number(e.target.value);
    markDirty();
    renderLighting();
  });
  $('#debounce').addEventListener('change', (e) => {
    state.debounce = Number(e.target.value);
    markDirty();
  });
  $('#lod').addEventListener('change', (e) => {
    state.config.lod = Number(e.target.value);
    markDirty();
  });

  const modal = $('#macro-modal');
  $('#btn-macro-open').addEventListener('click', () => { renderMacros(); modal.showModal(); });
  modal.addEventListener('close', () => toggleRecording(false));
  $('#macro-bank').addEventListener('change', (e) => {
    state.bank = Number(e.target.value);
    renderMacros();
  });
  $('#btn-record').addEventListener('click', () => toggleRecording());
  $('#btn-macro-clear').addEventListener('click', () => {
    state.macros[state.bank] = [];
    saveMacros();
    renderMacros();
  });
  $('#btn-macro-write').addEventListener('click', writeMacro);
  window.addEventListener('keydown', onRecordKey);
  window.addEventListener('keyup', onRecordKey);

  $('#btn-export').addEventListener('click', exportBackup);
  $('#btn-import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', (e) => {
    if (e.target.files[0]) importBackup(e.target.files[0]);
    e.target.value = '';
  });

  navigator.hid.addEventListener('disconnect', (e) => {
    if (state.mouse && e.device === state.mouse.device) {
      state.mouse = null;
      $('#view-main').hidden = true;
      $('#view-connect').hidden = false;
      $('#device-chip').hidden = true;
      $('#topbar-actions').hidden = true;
      toast('The mouse was unplugged', 'error');
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.dirty) e.preventDefault();
  });

  // Reconnect without a prompt if permission was granted before. Surface a
  // failure rather than leaving the page looking like nothing happened.
  grantedDevices().then((devices) => {
    if (devices.length === 1) connect(devices[0]).catch((err) => toast(describe(err), 'error'));
  }).catch(() => {});
}

init();
