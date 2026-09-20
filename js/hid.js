// WebHID transport.
//
// The mouse exposes its settings on a vendor-defined HID collection (usage page
// 0xff00), which Chromium is willing to hand to a web page. The mouse and
// keyboard collections on the same physical device stay protected by the
// browser, so nothing here can read your input.
//
// A read is two steps: write a short command to feature report 5, then read
// feature report 4 (or 6 on "long" mice) back.

import {
  CMD, CONFIG_SIZE_DEFAULT, CONFIG_SIZE_MAX, CONFIG_SIZE_MIN,
  REPORT_CMD, REPORT_CONFIG, REPORT_CONFIG_LONG, REPORT_SIZE,
  debounceToRaw, decodeButtons, decodeConfig,
  encodeButtons, encodeConfig, encodeMacro,
} from './protocol.js';
import { VENDOR_IDS, VENDOR_USAGE_PAGE, identify } from './devices.js';

// The mouse needs a moment to settle after a write before it answers reads
// again. Ten milliseconds is usually enough; twenty is cheap insurance.
const SETTLE_MS = 20;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// These mice put their settings on the same USB interface as a keyboard
// collection, which is what lets a button send a keyboard shortcut. Anything
// that claims keyboards claims this interface too, and then nothing else can
// open it. Chromium reports that only as "Failed to open the device", so say
// what actually causes it.
const DEVICE_BUSY = [
  'Something else has claimed the mouse, so the browser cannot open it. In order of likelihood:',
  '(1) another MouseFlash tab or window already has it open, so close the others and reload;',
  '(2) on macOS, a key remapper such as Karabiner-Elements, which seizes every device with a keyboard interface,',
  'so open its settings, go to Devices, and untick this mouse;',
  '(3) on Windows, the vendor software such as Glorious CORE, so close it;',
  '(4) on Linux, another process on the hidraw node, or a missing udev rule.',
].join(' ');

export function isSupported() {
  // Check the value, not just the key: a key that exists but holds nothing is
  // no more usable than a missing one.
  return typeof navigator !== 'undefined' && Boolean(navigator.hid);
}

const FILTERS = VENDOR_IDS.map((vendorId) => ({ vendorId, usagePage: VENDOR_USAGE_PAGE }));

/** Show the browser's device picker. Resolves to null if the user cancels. */
export async function requestDevice() {
  const devices = await navigator.hid.requestDevice({ filters: FILTERS });
  return devices[0] || null;
}

/** Devices the user has already granted us, so we can reconnect silently. */
export async function grantedDevices() {
  const devices = await navigator.hid.getDevices();
  return devices.filter((d) => VENDOR_IDS.includes(d.vendorId) && hasVendorCollection(d));
}

function hasVendorCollection(device) {
  return (device.collections || []).some((c) => c.usagePage === VENDOR_USAGE_PAGE);
}

/**
 * Which report ID carries the config. Mice with a 0x06 feature report use that
 * one and are the "long" variants; everything else uses 0x04.
 */
function configReportId(device) {
  for (const collection of device.collections || []) {
    for (const report of collection.featureReports || []) {
      if (report.reportId === REPORT_CONFIG_LONG) return REPORT_CONFIG_LONG;
    }
  }
  return REPORT_CONFIG;
}

export class Mouse {
  constructor(device) {
    this.device = device;
    this.reportId = configReportId(device);
    this.configSize = CONFIG_SIZE_DEFAULT;
    this.firmware = '';
    this.buttonRaw = null;
    this.info = identify({ vendorId: device.vendorId, productId: device.productId });
  }

  get name() {
    return this.info.name;
  }

  get buttonCount() {
    return this.info.buttons;
  }

  async open() {
    if (!this.device.opened) {
      try {
        await this.device.open();
      } catch (cause) {
        throw new Error(DEVICE_BUSY, { cause });
      }
    }
    // The firmware string only refines the name when several mice share a
    // product ID. Chromium on macOS refuses to read feature report 5 even where
    // report 4 works fine, so this must never be allowed to end the session.
    this.firmware = await this.readFirmware().catch(() => '');
    this.info = identify({
      vendorId: this.device.vendorId,
      productId: this.device.productId,
      firmware: this.firmware,
    });
  }

  async close() {
    if (this.device.opened) await this.device.close();
  }

  // -- low level -----------------------------------------------------------

  /** Send a short command on report 5. */
  async command(cmd, arg = 0) {
    const payload = new Uint8Array([cmd, arg, 0, 0, 0]);
    await this.device.sendFeatureReport(REPORT_CMD, payload);
    await sleep(SETTLE_MS);
  }

  /**
   * Ask for a data report and read it back.
   *
   * @returns {Uint8Array} REPORT_SIZE bytes with the report ID at index 0
   */
  async read(cmd) {
    const payload = new Uint8Array([cmd, 0, 0, 0, 0]);
    await this.device.sendFeatureReport(REPORT_CMD, payload);
    const view = await this.device.receiveFeatureReport(this.reportId);
    return this.#normalize(view, cmd);
  }

  /**
   * Chromium hands back the report ID as byte 0, but be forgiving in case a
   * platform strips it. The command echo in byte 1 tells us which we got.
   */
  #normalize(view, cmd) {
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    let body;
    if (bytes[0] === this.reportId && bytes[1] === cmd) {
      body = bytes;
    } else if (bytes[0] === cmd) {
      body = new Uint8Array(bytes.length + 1);
      body[0] = this.reportId;
      body.set(bytes, 1);
    } else {
      throw new Error(
        `The mouse answered command 0x${cmd.toString(16)} with an unexpected report. Unplug it, plug it back in, and try again.`,
      );
    }

    // Mice report a config between 123 and 167 bytes long, and the write needs
    // that length. If the platform padded the report to its declared size we
    // learn nothing here and keep the default.
    if (cmd === CMD.GET_CONFIG && body.length >= CONFIG_SIZE_MIN && body.length <= CONFIG_SIZE_MAX) {
      this.configSize = body.length;
    }

    const full = new Uint8Array(REPORT_SIZE);
    full.set(body.subarray(0, Math.min(body.length, REPORT_SIZE)));
    return full;
  }

  /** Write a full data report. */
  async write(buf) {
    const out = new Uint8Array(buf);
    out[0] = this.reportId;
    await this.device.sendFeatureReport(this.reportId, out.subarray(1));
    await sleep(SETTLE_MS);
  }

  // -- settings ------------------------------------------------------------

  /** Four ASCII characters, or '' where the platform will not read report 5. */
  async readFirmware() {
    const payload = new Uint8Array([CMD.FIRMWARE, 0, 0, 0, 0]);
    await this.device.sendFeatureReport(REPORT_CMD, payload);
    const view = await this.device.receiveFeatureReport(REPORT_CMD);
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    // Either [5, 1, v, v, v, v] or [1, v, v, v, v] depending on the platform.
    const start = bytes[0] === REPORT_CMD ? 2 : 1;
    const chars = Array.from(bytes.subarray(start, start + 4));
    const text = chars.map((c) => (c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '')).join('');
    return text.trim();
  }

  async readConfig() {
    const raw = await this.read(CMD.GET_CONFIG);
    return decodeConfig(raw, { configSize: this.configSize, ledOrder: 'rbg' });
  }

  async writeConfig(cfg) {
    await this.write(encodeConfig({ ...cfg, configSize: this.configSize }));
  }

  async readButtons(sensor) {
    const raw = await this.read(CMD.GET_BUTTONS);
    this.buttonRaw = raw;
    return decodeButtons(raw, this.buttonCount, sensor);
  }

  async writeButtons(actions, sensor) {
    const base = this.buttonRaw || (await this.read(CMD.GET_BUTTONS));
    await this.write(encodeButtons(base, actions, sensor));
  }

  async setDebounce(ms) {
    await this.command(CMD.DEBOUNCE, debounceToRaw(ms));
  }

  // Macros are write-only as far as anyone has worked out: there is no known
  // command that reads a bank back. MouseFlash keeps its own copy in the
  // browser so you can edit a macro after writing it.
  async writeMacro(bank, events) {
    await this.write(encodeMacro(bank, events, this.reportId));
  }
}
