# The SinoWealth mouse protocol

This is the layout MouseFlash implements. None of it is official. It comes from
the reverse-engineering work credited in the README, cross-checked between three
independent implementations and against the HID report descriptors the mice
publish. Bytes marked unknown have not been identified; MouseFlash writes them
back exactly as the mouse reported them.

Offsets below are into the whole report, with the report ID at index 0.

## Transport

The mouse presents several HID collections. The interesting one uses the
vendor-defined usage page `0xff00`, which is what makes this reachable from a
web page at all: Chromium blocks the mouse and keyboard collections on the same
device, so a page can write settings but cannot read your input.

| Report | Direction | Size (with ID) | Purpose |
| --- | --- | --- | --- |
| `0x04` | feature, both ways | 520 | configuration, buttons, macros |
| `0x05` | feature, both ways | 6 | short commands |
| `0x06` | feature, both ways | 520 | configuration on "long" mice, in place of `0x04` |
| `0x07` | input | 8 | unsolicited notifications, such as a DPI change |

Reading anything is two steps:

1. Send feature report `0x05` with the command in byte 1.
2. Read feature report `0x04` (or `0x06`).

Writing is a single feature report `0x04`, with byte 1 set to the same command
and byte 3 set to the write length (see below).

### Commands on report `0x05`

| Value | Meaning |
| --- | --- |
| `0x01` | firmware version, answered on report `0x05` as four ASCII bytes at index 2 |
| `0x02` | select profile |
| `0x11` | configuration |
| `0x12` | button map |
| `0x1a` | debounce time, with the value in byte 2 |
| `0x30` | macro bank |

`0x21` / `0x22` and `0x31` / `0x32` are the same as `0x11` / `0x12` for the
second and third profiles on mice that have them. MouseFlash only uses the first.

### The write-length byte

Byte 3 is `0` in a read and `size - 8` in a write, where `size` is how many bytes
that structure occupies. Configurations are 123 to 167 bytes depending on the
mouse, so a 131 byte config writes `0x7b`. The button block is always 88 bytes,
so it writes `0x50`. Getting this wrong means the mouse ignores the write.

The size is not announced anywhere. The mouse answers a config read with exactly
that many bytes rather than padding to the full 519, so MouseFlash takes the
length from the read and falls back to 131 if the platform pads it.

## Configuration, command `0x11`

| Offset | Bytes | Meaning |
| --- | --- | --- |
| 0 | 1 | report ID |
| 1 | 1 | command, `0x11` |
| 2 | 1 | unknown |
| 3 | 1 | write length |
| 4 | 5 | unknown |
| 9 | 1 | sensor ID |
| 10 | 1 | high nibble: flags, bit `0x8` is independent X and Y. Low nibble: polling rate |
| 11 | 1 | high nibble: active DPI stage. Low nibble: number of enabled stages |
| 12 | 1 | disabled-stage mask, one bit per stage, **set means disabled** |
| 13 | 16 | DPI values |
| 29 | 24 | one RGB colour per stage, eight stages |
| 53 | 1 | current lighting effect |
| 54 | 2 | Glorious: mode byte, then direction |
| 56 | 4 | Solid: mode byte, then colour |
| 60 | 23 | Breathing: mode byte, colour count, then seven colours |
| 83 | 1 | Tail: mode byte |
| 84 | 1 | Seamless Breathing: mode byte |
| 85 | 19 | Constant RGB: mode byte, then six colours |
| 104 | 12 | unknown |
| 116 | 7 | Rave: mode byte, then two colours |
| 123 | 1 | Random: mode byte |
| 124 | 1 | Wave: mode byte |
| 125 | 4 | Single Breathing: mode byte, then colour |
| 129 | 1 | lift-off distance |
| 130 | 1 | unknown |
| 131 | 36 | only present on "long" mice, contents unknown |

Settings for every effect are stored side by side, so switching effects does not
lose the colours set for the others.

### Polling rate

`1` is 125 Hz, `2` is 250 Hz, `3` is 500 Hz, `4` is 1000 Hz.

### The active stage

The high nibble of byte 11 counts **enabled stages only**, starting at 1. With
stages 2 and 5 enabled and stage 5 in use, the nibble is 2, not 5.

### DPI values

Sixteen bytes, one per stage when the axes are locked together and two per stage
when they are independent. The encoding depends on the sensor:

| Sensor | ID | Maximum | Encoding |
| --- | --- | --- | --- |
| PMW3360 | `0x06` | 12000 | `dpi / 100 - 1` |
| PMW3212 | `0x08` | 7200 | `dpi / 100` |
| PMW3327 | `0x0e` | 10200 | `dpi / 100 - 1` |
| PMW3389 | `0x0f` | 16000 | `dpi / 100` |

Only steps of 100 are representable.

### Colours

Per-stage DPI colours at offset 29 are stored red, green, blue.

Effect colours are stored red, **blue**, green on the Glorious mice and others
whose LEDs are wired that way, and red, green, blue on the rest. libratbag
tracks this per device as `LedType`; MouseFlash assumes the red/blue/green order,
which is what the mice it knows about use.

### Mode bytes

Every effect has a mode byte holding speed in the low nibble and brightness in
the high nibble. Speed runs 1 to 3 and brightness 1 to 4. Effects with no
brightness control still have the nibble, and it is ignored.

### Lift-off distance

`0x01` is 2 mm and `0x02` is 3 mm. A value of `0xff` means the mouse handles
lift-off through a separate command (`0x1b`), and the byte must be left alone.
MouseFlash disables the control in that case rather than writing to it.

## Button map, command `0x12`

Eight header bytes, then twenty four-byte slots, for 88 bytes total. Slots past
the buttons the mouse actually has are set to the disabled action.

The slot order is left click, right click, middle click, **back**, **forward**, DPI.

Be careful with the two side buttons. Glorious' own product guide numbers them
the other way round, listing button 4 as Forward and button 5 as Back, and their
configurator lists them in that order too. That numbering is not the protocol's
slot order. Confirmed on a Model O by binding slot 4 to a DPI cycle and pressing
each side button: the rear one answered. Anything that trusts the vendor's
numbering will silently remap the wrong side button.

| First byte | Action | Remaining three bytes |
| --- | --- | --- |
| `0x11` | mouse button | bitmask, then two zero bytes |
| `0x12` | scroll | `0x01` up or `0xff` down |
| `0x21` | keyboard shortcut | modifier mask, HID key usage, zero |
| `0x22` | media key | 24 bit mask, big endian |
| `0x31` | rapid fire | button bitmask, interval in ms, click count |
| `0x41` | DPI switch | `0x00` cycle, `0x01` up, `0x02` down |
| `0x42` | hold a DPI | the DPI, encoded as above |
| `0x50` | disabled | `0x01`, then two zero bytes |
| `0x70` | macro | bank, mode, repeat count |

Mouse button bits: `0x01` left, `0x02` right, `0x04` middle, `0x08` back,
`0x10` forward. Setting several bits presses several buttons at once.

Modifier bits: `0x01` Ctrl, `0x02` Shift, `0x04` Alt, `0x08` Super. Only the
left-hand modifiers exist.

Media masks: `0x000002` home page, `0x000100` media player, `0x000200` explorer,
`0x001000` email, `0x002000` calculator, `0x010000` next, `0x020000` previous,
`0x040000` stop, `0x080000` play/pause, `0x100000` mute, `0x400000` volume up,
`0x800000` volume down.

Macro modes: `0x01` repeat a set number of times, `0x02` repeat until any button
is pressed, `0x04` repeat while held. Anything else is reported to lock the mouse
up.

## Macros, command `0x30`

| Offset | Bytes | Meaning |
| --- | --- | --- |
| 0 | 1 | report ID |
| 1 | 1 | command, `0x30` |
| 2 | 1 | `0x02` when writing |
| 3 | 5 | zero |
| 8 | 1 | bank number |
| 9 | 1 | zero |
| 10 | 1 | event count |
| 11 | 3 each | events, up to 168 |

Byte 3 is not a write length here.

Each event is three bytes:

```
byte 0:  s t t t d d d d
byte 1:  d d d d d d d d
byte 2:  HID usage or button bitmask
```

`s` is 1 for a release and 0 for a press. `ttt` is the event kind: `1` mouse,
`5` keyboard, `6` modifier. The twelve `d` bits are the delay before the event in
milliseconds, so the maximum is 4095. A delay of 0 makes the mouse skip the
event, so 1 is the practical floor.

This gives the familiar command bytes: `0x10` and `0x90` for a mouse press and
release, `0x50` and `0xd0` for a key, `0x60` and `0xe0` for a modifier.

No command is known that reads a macro bank back off the mouse. MouseFlash keeps
its own copy in browser storage so macros stay editable.

## Debounce, command `0x1a`

Sent on report `0x05` as `05 1a <value> 00 00 00`, where the value is half the
time in milliseconds. Supported times are 4 to 16 ms in even steps, so the value
runs 2 to 8. This setting cannot be read back.
