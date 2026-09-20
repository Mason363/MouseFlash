// Known SinoWealth-based mice.
//
// These mice all speak the same vendor protocol over HID feature reports, so a
// device only needs an entry here to get a friendly name and the right button
// count. Everything that actually affects the bytes we write (sensor type,
// config size) is read back from the mouse at runtime, which is why unlisted
// mice still stand a good chance of working.
//
// Several mice share a USB product ID and are only told apart by the firmware
// version string, so entries may carry an optional `fw` match.

export const VENDOR_IDS = [
  0x258a, // SinoWealth, used by Glorious and many other brands
  0x3794, // Glorious' own vendor ID
];

// The vendor-defined HID collection that carries the config reports.
export const VENDOR_USAGE_PAGE = 0xff00;

const DEVICES = [
  // Glorious
  { vid: 0x258a, pid: 0x0036, fw: 'V103', name: 'Glorious Model O / O-', buttons: 6, art: 'model-o' },
  { vid: 0x258a, pid: 0x0036, name: 'Glorious Model O / O-', buttons: 6, art: 'model-o' },
  { vid: 0x258a, pid: 0x0033, fw: 'V102', name: 'Glorious Model D / D-', buttons: 6, art: 'model-d' },
  { vid: 0x258a, pid: 0x0033, name: 'Glorious Model D / D-', buttons: 6, art: 'model-d' },
  { vid: 0x258a, pid: 0x0027, fw: 'V102', name: 'Glorious Model O / O- (early firmware)', buttons: 6, art: 'model-o' },
  { vid: 0x3794, pid: 0xa000, fw: '1009', name: 'Glorious Model O Eternal', buttons: 6, art: 'model-o-eternal' },
  { vid: 0x3794, pid: 0xa000, name: 'Glorious Model O Eternal', buttons: 6, art: 'model-o-eternal' },

  // Other brands on the same protocol
  { vid: 0x258a, pid: 0x0027, fw: '3106', name: 'Dream Machines DM5 Blink', buttons: 8 },
  { vid: 0x258a, pid: 0x0027, fw: 'V161', name: 'G-Wolves Hati HT-M Wired', buttons: 6 },
  { vid: 0x258a, pid: 0x0027, fw: '3110', name: 'Genesis Xenon 770', buttons: 14 },
  { vid: 0x258a, pid: 0x0027, name: 'SinoWealth mouse (0027)', buttons: 6 },
  { vid: 0x258a, pid: 0x0029, fw: 'V127', name: 'Machenike M620', buttons: 6 },
  { vid: 0x258a, pid: 0x0029, fw: 'V287', name: 'Mad Dog GM905', buttons: 14 },
  { vid: 0x258a, pid: 0x0029, name: 'SinoWealth mouse (0029)', buttons: 6 },
  { vid: 0x258a, pid: 0x0051, fw: '2642', name: 'T-Dagger Imperial T-TGM310', buttons: 8 },
  { vid: 0x258a, pid: 0x0051, name: 'SinoWealth mouse (0051)', buttons: 8 },
  { vid: 0x258a, pid: 0x1007, fw: '9677', name: 'Marvo Scorpion G961', buttons: 6 },
  { vid: 0x258a, pid: 0x1007, name: 'SinoWealth mouse (1007)', buttons: 6 },
];

// Artwork for the mice we have photography for. `points` are percentages of the
// image box, in protocol slot order: left, right, middle, forward, back, DPI.
//
// Photographs are Glorious' own product images, cut out of the button guides on
// their support pages. See the credits in the README.
export const ART = {
  'model-o': {
    src: 'assets/mice/model-o-top.webp',
    caption: 'Model O',
    points: [
      { x: 25, y: 24 }, { x: 74, y: 24 }, { x: 50, y: 19 },
      { x: 4, y: 25 }, { x: 4, y: 32 }, { x: 50, y: 37 },
    ],
  },
  'model-d': {
    src: 'assets/mice/model-d-top.webp',
    caption: 'Model D',
    points: [
      { x: 25, y: 25 }, { x: 74, y: 25 }, { x: 50, y: 20 },
      { x: 4, y: 26 }, { x: 4, y: 33 }, { x: 50, y: 38 },
    ],
  },
  'model-o-eternal': {
    src: 'assets/mice/model-o-eternal-top.webp',
    caption: 'Model O Eternal',
    points: [
      { x: 26, y: 25 }, { x: 73, y: 25 }, { x: 50, y: 17 },
      { x: 3, y: 29 }, { x: 3, y: 36 }, { x: 50, y: 40 },
    ],
  },
};

// Shown for a mouse we have no photograph of. It is a drawing, not a photo, so
// the UI says so rather than implying it is the user's actual model.
export const GENERIC_ART = {
  src: 'assets/mouse-diagram.svg',
  caption: 'Generic layout',
  wide: true,
  points: null,
};

// Sensor IDs as reported in byte 9 of the config report.
const SENSORS = {
  0x06: { name: 'PMW3360', maxDpi: 12000, offsetOne: true },
  0x08: { name: 'PMW3212', maxDpi: 7200, offsetOne: false },
  0x0e: { name: 'PMW3327', maxDpi: 10200, offsetOne: true },
  0x0f: { name: 'PMW3389', maxDpi: 16000, offsetOne: false },
};

// Used when the mouse reports a sensor we have no numbers for. Deliberately
// conservative: every sensor we have seen handles at least this much.
const SENSOR_FALLBACK = { name: 'unknown', maxDpi: 2000, offsetOne: false };

export function sensorInfo(id) {
  const s = SENSORS[id];
  return s ? { id, known: true, ...s } : { id, known: false, ...SENSOR_FALLBACK };
}

/**
 * Look up a mouse by USB IDs and, when known, its firmware version string.
 *
 * Returns a descriptor for every VID/PID pair, falling back to a generic entry
 * so that unlisted mice are still usable. `recognized` says whether the match
 * came from the table above.
 */
export function identify({ vendorId, productId, firmware }) {
  const byIds = DEVICES.filter((d) => d.vid === vendorId && d.pid === productId);
  const exact = firmware ? byIds.find((d) => d.fw === firmware) : undefined;
  const generic = byIds.find((d) => !d.fw);
  const match = exact || generic;

  if (match) return { ...match, recognized: true };

  const ids = `${hex4(vendorId)}:${hex4(productId)}`;
  return { name: `Unrecognized mouse (${ids})`, buttons: 6, recognized: false };
}

function hex4(n) {
  return n.toString(16).padStart(4, '0');
}

/**
 * Names of every listed mouse, for the README and the in-app support list.
 * Variants that share a product ID are collapsed into one line.
 */
export function supportedNames() {
  const seen = new Set();
  const out = [];
  for (const d of DEVICES) {
    if (d.name.startsWith('SinoWealth mouse') || d.name.startsWith('Unrecognized')) continue;
    if (seen.has(d.name)) continue;
    seen.add(d.name);
    out.push(d.name);
  }
  return out;
}
