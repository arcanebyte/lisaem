# LisaEm Web

The LisaEm core (a Motorola 68000 CPU plus the Lisa's COPS, VIAs, floppy, ProFile, SCC and video
hardware) compiled to WebAssembly, with:

- a **browser UI** (`site/`) — a WebGL display with aspect correction and optional CRT effects, real keyboard and mouse, drag-and-drop disks, sound;
- a **scriptable JavaScript API** (`js/lisa.js`) that works identically in Node and the browser;
- a **headless CLI** (`node/lisa-run.mjs`) for boot-and-screenshot runs;
- an **MCP server** (`mcp/server.mjs`) so an AI agent can run and drive a Lisa;
- **snapshots** of the whole machine, and disk changes that survive a reload.

It replaces the wxWidgets front end (`src/host/wxui`) rather than patching it: the wx app is left
untouched and still builds. This directory adds a thin host layer, `src/lisa_web.c`, that does what
`initialize_all_subsystems()` and the wx run loop did, with no UI dependency.

## Build and run

Requires Emscripten (`emcc`) and a native C compiler (two small generator tools for the 68000 core
run natively during the build). Node 20+ for the CLI, tests and dev server.

```sh
cd web
make                                   # -> dist/lisa-core.mjs + dist/lisa-core.wasm
node serve.mjs --media "/path/to/disk images"   # http://127.0.0.1:8080/
```

`--media` is optional: it lists the disk images in that folder inside the UI (*Load* inserts one as a floppy,
*As ProFile* mounts it as a hard disk), and a *Use ROM from
folder* button appears if the folder holds boot ROM files (`.bin`/`.rom`/`.lo`/`.hi`; a pair is told
apart by `.lo`/`.hi` or the 341-0175/0176 part numbers). The server only listens on loopback.

Headless:

```sh
node node/lisa-run.mjs --floppy "LOS 3.0 1.image" --seconds 20 --shot screen.png --ascii
```

Tests. The ROM plumbing tests always run (they use a stand-in ROM generated in the test). The rest need
files that are not shipped: a bootable floppy (Lisa Office System 3.0 install disk 1) and, for the
real-ROM tests, your own boot ROM:

```sh
# Lisa Office System 3.0 install disk 1
export LISA_TEST_FLOPPY="/path/LOS 3.0 1.image"
# your boot ROM: lo,hi halves (341-0176 then 341-0175), or a single 16 KB file
export LISA_TEST_ROM="/path/341-0176-H.BIN,/path/341-0175-H.BIN"
# a ProFile image with the Office System on it
export LISA_TEST_PROFILE="/path/office-system.image"
# optional: a ProFile program that waits at a prompt and quits to the ROM on Q
export LISA_TEST_SELECTOR="/path/selector.image"
npm test
```

## Booting

Two ways, chosen by whether you supply a boot ROM:

**ROM-less (default).** The emulator's built-in HLE loader boots a DiskCopy 4.2 floppy or a ProFile
image directly. No ROM is needed or loaded. Software that depends on ROM routines the HLE layer does
not implement stops with an "unhandled ROM code" message (e.g. the `alisando` demo calls the ROM's
PowerOff routine).

**With a real Lisa boot ROM.** Lisa ROMs are Apple's and are not included; supply your own.

```js
const lisa = await Lisa.create();
lisa.insertFloppy(disk);                       // optional
const info = lisa.loadROM(romBytes);           // 16 KB image | { lo, hi } pair | DTC listing
//   -> { format, version: '2.H', checksumOk, xl }
lisa.powerOn({ boot: 'floppy' });              // 'floppy' | 'profile' | 'none' (stop at the ROM menu)
lisa.run(10000);                               // the ROM self-test alone takes several seconds
```

`powerOn()` resets the CPU into the ROM, and, for `floppy`/`profile`, presses Apple-2 / Apple-3 once
the ROM is listening (3 s into the boot, the same window the wx app uses). A `{ lo, hi }` pair means
the two 8 KB EPROM dumps: `lo` holds the odd-addressed bytes, `hi` the even ones, and once stitched
the image must start `00 00 04 80` (otherwise it is rejected rather than run). A 3A ROM switches the
display to the XL screen, 608×431 (MacWorks only). CLI: `--rom file` or `--rom name.lo,name.hi`.

In the browser UI, choose the ROM in the *Boot ROM* card. It is remembered in this browser's local
storage only (never uploaded) and can be forgotten with one click.

**Status of ROM boot: verified with a real 2.H ROM** (341-0175-H / 341-0176-H, checksum valid):

- It passes its self-test in under 3 s and shows the "STARTUP FROM" menu.
- `powerOn({ boot: 'floppy' })` (Apple-2) boots the Office System 3.0 installer through the emulated floppy
  controller to *exactly the same screen* (identical framebuffer hash) as the ROM-less loader.
- `powerOn({ boot: 'profile' })` (Apple-3) boots Office System 3.1 from a ProFile image to its desktop,
  again identical to the ROM-less ProFile boot; clicking through the unclean-shutdown prompt works.
- It runs the `alisando` demos (dot tunnel, titles, speaker music), and a typed `Q` makes a guest program
  quit back to the ROM's "COME BACK SOON" screen: keyboard input is verified end to end, in Node and in the
  browser UI with real key and mouse events.

Not tried: ROM revisions other than 2.H, and the 3A/XL ROM (tested only with a stand-in).

## Snapshots

```js
const snap = lisa.snapshot();                  // whole machine incl. disks: ~50 MB, ~50 ms
lisa.run(5000); lisa.click(600, 216);          // ... try something ...
lisa.restore(snap);                            // ... and rewind, ~10 ms. Bit-identical every time.

const bytes = await lisa.serialize();          // gzip, ~12 MB: put it in a file or IndexedDB
const copy = await Lisa.deserialize(bytes);    // a fresh machine that carries on exactly where it was
```

A snapshot is the WASM heap (CPU, RAM, video, every chip, and the memory-mapped disk images) plus, for
`serialize()`, the media files. `deserialize()` replays the original media and ROM setup first, so the
virtual filesystem's handles and mappings match the pointers in the saved memory, then restores the heap.
Restoring after you have mounted or inserted *different* media than when the snapshot was taken is not
supported. This is the fast way to test: boot once, snapshot at the desktop, restore before each case.

## Disks the guest writes to

The guest writes to its disks (the Office System updates its ProFile as it runs). The emulator works on
**copies** of the bytes you give it, so your originals are never modified; get the result back with:

```js
lisa.exportProfile();     // the ProFile as the guest left it (Uint8Array), or null
lisa.exportFloppy();
lisa.diskHash(0);         // cheap fingerprint of the live ProFile (1 = floppy): did the guest write?
lisa.flushDisks();
```

In the browser UI, changes are saved to IndexedDB (every 15 s, when the tab is hidden, and on close) and
used instead of the original the next time you load the same disk (matched by name and size). The
*Disk changes* card has *Download ProFile/floppy*, a *Keep changes* switch, and *Revert disks* (two clicks).
*Save state* / *Load state* store the whole machine (one slot).

## MCP server (for AI agents)

```sh
claude mcp add lisa -- node /path/to/web/mcp/server.mjs --media ~/lisa-disks --out ~/lisa-out
```

or in any MCP client's config: `{"command": "node", "args": [".../web/mcp/server.mjs", "--media", "<dir>", "--out", "<dir>"]}`.

- `--media <dir>` (repeatable): the only places disk images, ROMs and saved snapshots are read from.
- `--out <dir>`: the only place anything is written (exported disks, saved snapshots); without it nothing can be written.

Tools: `lisa_list_media`, `lisa_start` (floppy / profile / rom / boot device / serial ports), `lisa_status`,
`lisa_run`, `lisa_screenshot` (aspect-corrected, scalable, croppable, optional ASCII), `lisa_type`, `lisa_key`
(chords such as `["COMMAND","S"]`), `lisa_click`, `lisa_mouse`, `lisa_drag`, `lisa_wait_for_change`,
`lisa_wait_for_stable`, `lisa_registers`, `lisa_read_memory`, `lisa_serial_write/read`, `lisa_snapshot`,
`lisa_restore`, `lisa_snapshot_delete`, `lisa_snapshot_save_file`, `lisa_snapshot_load_file`,
`lisa_export_disk`. Action tools can attach a screenshot (`screenshot: true`). Time only advances when a
tool asks, by an exact amount, so a sequence of calls always gives the same result.

The protocol layer is hand-written (no dependencies) and is tested with the client in `mcp/client.mjs`
over real JSON-RPC. It has not yet been tried with a third-party MCP client such as Claude Code or the MCP
Inspector.

## The display

`site/display.js` draws the 1-bit framebuffer with WebGL2 (a plain 2D canvas if WebGL2 is missing):

- **Aspect ratio.** Lisa pixels are not square. The default *Lisa (720×500)* matches the original
  LisaEm's aspect-corrected size; *Square pixels* and *4:3* are the alternatives, and XL ROMs use their
  own 608:431.
- **Scaling.** Sharp-bilinear: edges stay crisp at any size, with no shimmer at fractional scales.
- **Effects** (presets *Clean*, *Soft CRT*, *Strong CRT*, and sliders): barrel curvature, scanlines
  that widen on bright lines, bloom, an aperture-grille mask, vignette. The mouse is mapped through
  the same curvature, so clicks land on the pixel you see.

## The scripting API

```js
import { Lisa, KEY } from './js/lisa.js';

const lisa = await Lisa.create();                  // { ramKB, clock, log }
lisa.insertFloppy(bytes);                          // DiskCopy 4.2 / raw
lisa.mountProfile(bytes);                          // optional hard disk
lisa.bootFloppy();                                 // or lisa.bootProfile()

lisa.run(15000);                                   // advance 15 s of *Lisa* time
lisa.type('hello\n');                              // keyboard, ASCII
lisa.key(KEY.COMMAND, true); lisa.tap(KEY.S); lisa.key(KEY.COMMAND, false);
lisa.click(600, 216);                              // moves, waits for the pointer, clicks
await lisa.waitForScreen(s => s.inkCount() > 1000);
await lisa.waitForStable();                        // until the screen stops changing

const s = lisa.screen();                           // a Screen: 720x364, 1 bit/pixel
s.pixel(x, y); s.inkCount(); s.hash(); s.diff(other);
s.toAscii(); s.toPNG(); s.toRGBA();

lisa.serialAttach('a');                            // before boot
lisa.serialWrite('a', 'text'); lisa.serialRead('a');   // queued behind the chip's 2-byte FIFO (64 KB each way)
lisa.serialBacklog('a');                           // bytes sent but not yet received by the guest
lisa.registers(); lisa.readMemory(addr, len, ctx); lisa.pointer();
lisa.sound; lisa.contrast; lisa.messages(); lisa.consoleRead();
```

In the browser, `window.lisaAuto` wraps the live machine (`pause()`, `run(ms)`, `type`, `click`,
`screenshot()`, `ascii()`, …) so it can be driven from the console or a browser-automation tool.

### Time is emulated, and exact

The machine only advances inside `run(ms)`, by exactly `ms × 5000` 68000 cycles. It runs far faster
than real time (about 20× in Node), and **a given script always produces the same result**. The
one thing that would break that is the Lisa's real-time clock, which the core seeds from the host's
time of day; so `Lisa.create()` fixes it to 1984-01-19 12:00 UTC unless you pass `clock: 'now'`,
a `Date`, or epoch seconds. (The browser UI uses `'now'`.)

### Mouse

The Lisa mouse is relative; the emulated COPS feeds the guest motion until *the guest's own pointer*
reaches your target, so `click()` needs the guest OS to be running and reading the mouse.
`click()` reads the guest's pointer position and waits for it to arrive instead of using a fixed
delay. A press is only sent to the guest once its pointer has arrived, and is held for at least
100 ms of Lisa time, so even a press-and-release delivered in the same millisecond (a synthetic
browser click) works. Without that the core fires the press mid-path, or the OS misses a zero-length one. The guest OS is detected automatically to find where it keeps the pointer (Office System,
Monitor, MacWorks, Xenix, UniPlus, Lisa Test).

### Peripherals

| Peripheral | Direction | API |
|---|---|---|
| Keyboard (COPS) | in | `type`, `key`, `tap` |
| Mouse (COPS) | in | `mouseMove/Down/Up`, `mouseTo`, `click`, `doubleClick` |
| Floppy, ProFile | in | `insertFloppy`, `mountProfile` |
| Boot ROM | in | `loadROM`, `powerOn` |
| Serial A/B (Z8530) | in & out | `serialAttach`, `serialWrite`, `serialRead` |
| Display | out | `screen()`, `screenshotPNG()` |
| Speaker | out | `sound` (raw VIA timer value; the UI turns it into a tone) |
| Console text (HLE/LPW) | out | `consoleRead()` |

## Status — what is verified and what is not

Verified here, with Lisa Office System 3.0 install disk 1:

- boots in Node and in the browser, correct display, OS detected;
- mouse: pointer reaches the target and clicking *Install* drives the guest to its next screen;
- keyboard: typed keys enter the COPS queue and are consumed by the guest, and a typed Q makes a guest program quit to the ROM;
- PNG/ASCII capture; bit-identical results across runs with the fixed clock;
- snapshots: restore rewinds exactly (3 of 3 identical), and a machine serialized mid-run (ROM + ProFile, with the
  guest writing to its disk) and deserialized into a fresh instance matches the original on screen, disk fingerprint,
  PC and clock, before and after continuing;
- disks: the guest's writes land in the disk image, export returns them, and the caller's bytes are never modified;
  in the browser they survive a page reload and *Revert* discards them;
- MCP: a full session over JSON-RPC (boot, screenshot, click, snapshot, restore, save to file and resume) and the
  path jail (no reading outside `--media`, no writing outside `--out`).

Not yet verified or not done:

- typed text echoing in a text field, and held-key behaviour in a game;
- serial I/O end to end (the plumbing builds and links; no guest has exercised it);
- the MCP server with a third-party client; snapshots restored after changing media; floppy-write persistence (only the ProFile path was exercised in the browser);
- operating systems other than the Office System (Monitor, Xenix, UniPlus, MacWorks);
- other ROM revisions, sound output accuracy, ImageWriter capture, EtherBox networking (stubbed), and the
  XL screen mode (608×431) with a real 3A ROM;
- mobile/touch input and an in-page serial terminal.

## Changes to the original sources

Two small fixes were needed in the core, both safe for the wx build:

- `src/lib/libGenerator/generator/cpu68k.c` — `cpu68k_makeipclist` read an uninitialized
  variable (`table`) on its first-use path. Undefined behaviour that clang `-O1`/`-O2` exploits,
  which made ROM-less boot abort with "Couldn't get IPC Table". It now uses `mmu_trn->table`.
- `src/lisa/io_board/cops.c` — `init_clock()` takes its time from `lisa_host_time()` (UTC) when
  compiled with `-DLISA_HOST_CLOCK`; the wx build is unchanged.

Everything else lives in `web/`.

## Layout

```
web/
  Makefile            native generator step + emcc build
  src/lisa_web.c      host layer: init, run loop, input, screen, serial, stubs, C API
  exports.json        functions exported from the WASM module
  js/lisa.js          Lisa class, Screen, key tables, PNG encoder
  node/               lisa-run.mjs CLI, lisa.test.mjs
  mcp/                server.mjs (MCP server), client.mjs (test client), mcp.test.mjs
  site/               browser UI (index.html, app.js, display.js WebGL renderer, store.js IndexedDB, style.css)
  serve.mjs           loopback dev server
```
