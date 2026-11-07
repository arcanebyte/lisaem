// Programmable Apple Lisa: a JavaScript API over the LisaEm core compiled to WebAssembly.
//
// Works unchanged in Node (headless, for tests and agents) and in the browser.
//
//   const lisa = await Lisa.create();
//   lisa.insertFloppy(await readFile('disk.dc42'));
//   lisa.bootFloppy();
//   lisa.run(5000);                       // 5 s of Lisa time (deterministic, not wall clock)
//   lisa.type('hello\n');
//   lisa.click(360, 182);
//   await lisa.waitForScreen(s => s.inkCount() > 1000, { timeout: 20000 });
//   writeFileSync('shot.png', lisa.screenshotPNG());
//
// All time is *emulated* time: the machine advances only when you call run(), by an exact
// number of 68000 cycles (5,000 per millisecond), so a given script always produces the
// same result.

import createLisaCore from '../dist/lisa-core.mjs';

export const CYCLES_PER_MS = 5000;
export const SCREEN_W = 720;
export const SCREEN_H = 364;

/** Raw COPS key codes for the Lisa keyboard (from src/include/keyscan.h). */
export const KEY = {
  TILDE: 0x68, 1: 0x74, 2: 0x71, 3: 0x72, 4: 0x73, 5: 0x64, 6: 0x61, 7: 0x62, 8: 0x63, 9: 0x50, 0: 0x51,
  MINUS: 0x40, PLUS: 0x41, BACKSPACE: 0x45, TAB: 0x78,
  Q: 0x75, W: 0x77, E: 0x60, R: 0x65, T: 0x66, Y: 0x67, U: 0x52, I: 0x53, O: 0x5f, P: 0x44,
  OBRAK: 0x56, CBRAK: 0x57, BSLASH: 0x42, CAPSLOCK: 0x7d,
  A: 0x70, S: 0x76, D: 0x7b, F: 0x69, G: 0x6a, H: 0x6b, J: 0x54, K: 0x55, L: 0x59,
  COLON: 0x5a, QUOTE: 0x5b, RETURN: 0x48, SHIFT: 0x7e,
  Z: 0x79, X: 0x7a, C: 0x6d, V: 0x6c, B: 0x6e, N: 0x6f, M: 0x58, COMMA: 0x5d, DOT: 0x5e, SLASH: 0x4c,
  OPTION: 0x7c, COMMAND: 0x7f, SPACE: 0x5c, ENTER: 0x46, ROPTION: 0x4e,
  CLEAR: 0x20,
  NUM_MINUS: 0x21, NUM_PLUS: 0x22, NUM_STAR: 0x23, NUM_7: 0x24, NUM_8: 0x25, NUM_9: 0x26, NUM_SLASH: 0x27,
  NUM_4: 0x28, NUM_5: 0x29, NUM_6: 0x2a, NUM_COMMA: 0x2b, NUM_1: 0x4d, NUM_2: 0x2d, NUM_3: 0x2e,
  NUM_ENTER: 0x2f, NUM_0: 0x49, NUM_DOT: 0x2c,
  LEFT: 0x22, RIGHT: 0x23, UP: 0x27, DOWN: 0x2b,
};

/** Browser KeyboardEvent.code -> raw Lisa key code (physical key positions). */
export const KEYMAP = {
  Backquote: KEY.TILDE, Digit1: KEY[1], Digit2: KEY[2], Digit3: KEY[3], Digit4: KEY[4], Digit5: KEY[5],
  Digit6: KEY[6], Digit7: KEY[7], Digit8: KEY[8], Digit9: KEY[9], Digit0: KEY[0],
  Minus: KEY.MINUS, Equal: KEY.PLUS, Backspace: KEY.BACKSPACE, Tab: KEY.TAB,
  KeyQ: KEY.Q, KeyW: KEY.W, KeyE: KEY.E, KeyR: KEY.R, KeyT: KEY.T, KeyY: KEY.Y, KeyU: KEY.U, KeyI: KEY.I,
  KeyO: KEY.O, KeyP: KEY.P, BracketLeft: KEY.OBRAK, BracketRight: KEY.CBRAK, Backslash: KEY.BSLASH,
  CapsLock: KEY.CAPSLOCK, KeyA: KEY.A, KeyS: KEY.S, KeyD: KEY.D, KeyF: KEY.F, KeyG: KEY.G, KeyH: KEY.H,
  KeyJ: KEY.J, KeyK: KEY.K, KeyL: KEY.L, Semicolon: KEY.COLON, Quote: KEY.QUOTE, Enter: KEY.RETURN,
  ShiftLeft: KEY.SHIFT, ShiftRight: KEY.SHIFT,
  KeyZ: KEY.Z, KeyX: KEY.X, KeyC: KEY.C, KeyV: KEY.V, KeyB: KEY.B, KeyN: KEY.N, KeyM: KEY.M,
  Comma: KEY.COMMA, Period: KEY.DOT, Slash: KEY.SLASH,
  AltLeft: KEY.OPTION, AltRight: KEY.ROPTION, MetaLeft: KEY.COMMAND, MetaRight: KEY.COMMAND,
  ControlLeft: KEY.COMMAND, ControlRight: KEY.COMMAND, Space: KEY.SPACE, Escape: KEY.CLEAR,
  NumpadEnter: KEY.NUM_ENTER, Numpad0: KEY.NUM_0, Numpad1: KEY.NUM_1, Numpad2: KEY.NUM_2, Numpad3: KEY.NUM_3,
  Numpad4: KEY.NUM_4, Numpad5: KEY.NUM_5, Numpad6: KEY.NUM_6, Numpad7: KEY.NUM_7, Numpad8: KEY.NUM_8,
  Numpad9: KEY.NUM_9, NumpadDecimal: KEY.NUM_DOT, NumpadAdd: KEY.NUM_PLUS, NumpadSubtract: KEY.NUM_MINUS,
  NumpadMultiply: KEY.NUM_STAR, NumpadDivide: KEY.NUM_SLASH,
  ArrowLeft: KEY.LEFT, ArrowRight: KEY.RIGHT, ArrowUp: KEY.UP, ArrowDown: KEY.DOWN,
};

/** A snapshot of the Lisa's display (1 bit per pixel, 1 = black ink). */
export class Screen {
  constructor(width, height, bits) {
    this.width = width;
    this.height = height;
    this.bits = bits; // Uint8Array, (width/8) bytes per row, MSB = leftmost pixel
  }
  /** 1 if the pixel at (x, y) is black. */
  pixel(x, y) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    return (this.bits[y * (this.width >> 3) + (x >> 3)] >> (7 - (x & 7))) & 1;
  }
  /** Number of black pixels. */
  inkCount() {
    let n = 0;
    for (const b of this.bits) {
      let v = b;
      while (v) { n += v & 1; v >>= 1; }
    }
    return n;
  }
  /** A cheap content hash, for "did the screen change?" checks. */
  hash() {
    let h = 0x811c9dc5;
    for (let i = 0; i < this.bits.length; i++) h = Math.imul(h ^ this.bits[i], 0x01000193) >>> 0;
    return h;
  }
  equals(other) {
    if (this.bits.length !== other.bits.length) return false;
    for (let i = 0; i < this.bits.length; i++) if (this.bits[i] !== other.bits[i]) return false;
    return true;
  }
  /** Fraction (0..1) of pixels that differ from another screen of the same size. */
  diff(other) {
    let n = 0;
    for (let i = 0; i < this.bits.length; i++) {
      let v = this.bits[i] ^ other.bits[i];
      while (v) { n += v & 1; v >>= 1; }
    }
    return n / (this.width * this.height);
  }
  /**
   * Render as text, one character per cell (cellW x cellH pixels), choosing a density
   * glyph by how much ink is in the cell. Handy for reading the screen in a terminal.
   */
  toAscii({ cellW = 8, cellH = 12 } = {}) {
    const ramp = ' .:-=+*#%@';
    const lines = [];
    for (let cy = 0; cy < this.height; cy += cellH) {
      let line = '';
      for (let cx = 0; cx < this.width; cx += cellW) {
        let ink = 0, total = 0;
        for (let y = cy; y < Math.min(cy + cellH, this.height); y++)
          for (let x = cx; x < Math.min(cx + cellW, this.width); x++) { ink += this.pixel(x, y); total++; }
        line += ramp[Math.min(ramp.length - 1, Math.floor((ink / total) * ramp.length))];
      }
      lines.push(line.replace(/\s+$/, ''));
    }
    return lines.join('\n');
  }
  /** RGBA bytes (opaque, black on white), e.g. for a canvas ImageData. */
  toRGBA() {
    const out = new Uint8ClampedArray(this.width * this.height * 4);
    for (let y = 0; y < this.height; y++)
      for (let x = 0; x < this.width; x++) {
        const v = this.pixel(x, y) ? 0 : 255, o = (y * this.width + x) * 4;
        out[o] = out[o + 1] = out[o + 2] = v;
        out[o + 3] = 255;
      }
    return out;
  }
  /** Encode as a 1-bit grayscale PNG (no dependencies). */
  toPNG() { return encodePNG1bit(this.width, this.height, this.bits); }
}

export class Lisa {
  /**
   * @param {object} opts
   * @param {number} [opts.ramKB=1024]  512, 1024 or 2048
   * @param {boolean} [opts.log=false]  send the core's debug log to stderr
   * @param {Date|number|'now'} [opts.clock]  the Lisa's clock at power-on: a Date, UTC epoch seconds,
   *   or 'now'. Defaults to a fixed date so that runs are exactly reproducible.
   */
  static async create({ ramKB = 1024, log = false, clock } = {}) {
    const epoch = clock === 'now' ? Date.now() / 1000 : clock instanceof Date ? clock.getTime() / 1000 : clock || 0;
    const core = await createLisaCore({
      print: (t) => log && console.log(t),
      printErr: (t) => log && console.error(t),
    });
    const lisa = new Lisa(core);
    const rc = core.ccall('lisa_init', 'number', ['number', 'number', 'number'], [ramKB, log ? 1 : 0, epoch]);
    if (rc) throw new Error(`lisa_init failed: ${rc}`);
    return lisa;
  }

  constructor(core) {
    this.core = core;
    this._c = (name, ret, types, args) => core.ccall('lisa_' + name, ret, types, args);
    this._n = 0;
  }

  // ---- media -------------------------------------------------------------------------

  /** Insert a DiskCopy 4.2 (or raw) floppy image. Returns true on success. */
  insertFloppy(bytes, name = 'floppy.dc42') {
    const path = '/' + name;
    this.core.FS.writeFile(path, bytes);
    return this._c('insert_floppy', 'number', ['string'], [path]) === 0;
  }

  /** Attach a ProFile hard disk image to the built-in parallel port. */
  mountProfile(bytes, name = 'profile.dc42') {
    const path = '/' + name;
    this.core.FS.writeFile(path, bytes);
    return this._c('mount_profile', 'number', ['string'], [path]) === 0;
  }

  /** Boot from the inserted floppy using the built-in ROM-less (HLE) loader. */
  bootFloppy() { return this._c('boot_romless', 'number', ['number'], [0]) === 0; }
  /** Boot from the mounted ProFile using the built-in ROM-less (HLE) loader. */
  bootProfile() { return this._c('boot_romless', 'number', ['number'], [1]) === 0; }

  // ---- real Boot ROM -------------------------------------------------------------------

  /**
   * Load a Lisa boot ROM. `rom` may be a 16 KB image (Uint8Array), a {lo, hi} pair of 8 KB EPROM
   * dumps (lo = the odd-addressed bytes, hi = the even ones; a real ROM starts 00 00 04 80 once stitched), or the assembled DTC source listing as text (Uint8Array). Returns
   * { format, version, checksumOk, xl }. ROMs are not included with LisaEm; you must supply your own.
   * Load before powerOn(); a machine with a ROM is *not* booted with bootFloppy()/bootProfile().
   */
  loadROM(rom) {
    let path = '/lisa.rom';
    if (rom && rom.lo && rom.hi) {
      this.core.FS.writeFile('/lisa.rom.lo', rom.lo);
      this.core.FS.writeFile('/lisa.rom.hi', rom.hi);
      path = '/lisa.rom.lo';
    } else {
      this.core.FS.writeFile(path, rom);
    }
    const fmt = this._c('load_rom', 'number', ['string'], [path]);
    if (fmt < 0) throw new Error('not a recognised Lisa boot ROM (expected 16 KB image, lo/hi pair, or DTC listing)');
    const v = this._c('rom_version', 'number', [], []);
    return {
      format: ['', 'dtc-listing', 'split', 'binary'][fmt],
      version: `${v >> 8}.${String.fromCharCode(v & 255)}`,
      checksumOk: !this._c('rom_checksum_bad', 'number', [], []),
      xl: (v >> 8) === 3, // 3A ROM: 608x431 XL screen, MacWorks only
    };
  }

  /**
   * Power on through the ROM. boot: 'none' stops at the ROM's own menu; 'floppy' / 'profile' press
   * Apple-2 / Apple-3 for you once the ROM is listening (about 3 s of Lisa time in); 1/2/3 press
   * Apple-1/2/3. Run time afterwards with run(): the self-test alone takes several seconds.
   */
  powerOn({ boot = 'none' } = {}) {
    const code = { none: 0, 1: 1, floppy: 2, 2: 2, profile: 3, harddisk: 3, 3: 3 }[boot];
    if (code === undefined) throw new Error(`unknown boot device ${boot}`);
    const rc = this._c('power_on', 'number', ['number'], [code]);
    if (rc) throw new Error('no ROM loaded: call loadROM() first');
    return true;
  }

  // ---- time --------------------------------------------------------------------------

  /** Run the machine for `ms` milliseconds of emulated Lisa time. Returns status flags. */
  run(ms) {
    const st = this._c('run', 'number', ['number'], [Math.round(ms * CYCLES_PER_MS)]);
    return { poweredOff: !!(st & 1), rebooted: !!(st & 2), fatal: !!(st & 4) };
  }

  /** Total emulated time elapsed, in milliseconds. */
  get time() { return this._c('cycles', 'number', [], []) / CYCLES_PER_MS; }

  get poweredOff() { return !!this._c('is_powered_off', 'number', [], []); }

  // ---- input peripherals -------------------------------------------------------------

  /** Type ASCII text on the keyboard. '\n' is Return. Queued; keys flow as the Lisa reads them. */
  type(text) { return this._c('type', 'number', ['string'], [text]); }

  /** Send a raw COPS key code up or down (see KEY). */
  key(code, down) { return this._c('key_raw', 'number', ['number', 'number'], [code, down ? 1 : 0]); }

  /** Press and release a raw key. */
  tap(code) { this.key(code, true); this.key(code, false); }

  /** Hold a modifier while typing, e.g. withKey(KEY.COMMAND, () => this.type('s')). */
  withKey(code, fn) { this.key(code, true); fn(); this.key(code, false); }

  /** Move the mouse to an absolute Lisa screen pixel (0..719, 0..363). */
  mouseMove(x, y) { this._c('mouse', null, ['number', 'number', 'number'], [x, y, 0]); }
  mouseDown(x, y) { this._c('mouse', null, ['number', 'number', 'number'], [x, y, 1]); }
  mouseUp(x, y) { this._c('mouse', null, ['number', 'number', 'number'], [x, y, -1]); }

  /** Where the guest OS currently has its mouse pointer, in Lisa screen pixels. */
  pointer() {
    const v = this._c('pointer', 'number', [], []) >>> 0;
    return { x: v & 0xffff, y: v >>> 16 };
  }

  /**
   * Move the pointer to (x, y) and run emulated time until the guest's own pointer is within
   * `tolerance` pixels, or `timeout` ms of Lisa time pass. Returns true if it arrived.
   * The mouse works like the real hardware: the COPS feeds the guest relative motion, so the OS
   * must be running and reading the mouse. This waits for that rather than guessing a delay.
   */
  mouseTo(x, y, { tolerance = 3, timeout = 6000, stepMs = 50 } = {}) {
    this.mouseMove(x, y);
    for (let t = 0; t <= timeout; t += stepMs) {
      const p = this.pointer();
      if (Math.abs(p.x - x) <= tolerance && Math.abs(p.y - y) <= tolerance) return true;
      this.run(stepMs);
    }
    return false;
  }

  /**
   * Click at a pixel: move there (waiting for the pointer to arrive), press, hold, release.
   * Returns false if the pointer never reached the target (the click is still sent).
   */
  click(x, y, { holdMs = 200, settleMs = 300, ...moveOpts } = {}) {
    const arrived = this.mouseTo(x, y, moveOpts);
    this.mouseDown(x, y); this.run(holdMs);
    this.mouseUp(x, y); this.run(settleMs);
    return arrived;
  }

  /** Double-click at a pixel. */
  doubleClick(x, y, opts = {}) {
    const arrived = this.click(x, y, { ...opts, settleMs: 80 });
    this.mouseDown(x, y); this.run(opts.holdMs ?? 200);
    this.mouseUp(x, y); this.run(opts.settleMs ?? 300);
    return arrived;
  }

  // ---- serial ports ------------------------------------------------------------------

  /** Connect a serial port ('a' or 'b') to the host. Call before booting. */
  serialAttach(port) { this._c('serial_attach', null, ['number', 'number'], [this._port(port), 1]); }

  /** Send bytes (string or Uint8Array) to the Lisa on a serial port. Returns bytes accepted. */
  serialWrite(port, data) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const ptr = this.core._malloc(bytes.length || 1);
    this.core.HEAPU8.set(bytes, ptr);
    const n = this._c('serial_write', 'number', ['number', 'number', 'number'], [this._port(port), ptr, bytes.length]);
    this.core._free(ptr);
    return n;
  }

  /** Read whatever the Lisa has transmitted on a serial port. Returns a Uint8Array. */
  serialRead(port) { return this._drain('serial_read', this._port(port)); }

  /** Text the HLE layer / LPW printed to the console. */
  consoleRead() { return new TextDecoder().decode(this._drain('console_read')); }

  _port(p) { return p === 'a' || p === 'A' || p === 0 ? 0 : 1; }

  _drain(fn, port) {
    const max = 65536, ptr = this.core._malloc(max);
    const args = port === undefined ? [ptr, max] : [port, ptr, max];
    const types = port === undefined ? ['number', 'number'] : ['number', 'number', 'number'];
    const n = this._c(fn, 'number', types, args);
    const out = this.core.HEAPU8.slice(ptr, ptr + n);
    this.core._free(ptr);
    return out;
  }

  // ---- output peripherals / observation ----------------------------------------------

  /** Capture the display. */
  screen() {
    const w = this._c('screen_width', 'number', [], []);
    const h = this._c('screen_height', 'number', [], []);
    const ptr = this._c('screen_raw', 'number', [], []);
    const bits = this.core.HEAPU8.slice(ptr, ptr + (w >> 3) * h);
    return new Screen(w, h, bits);
  }

  screenshotPNG() { return this.screen().toPNG(); }

  /** The display as an RGBA ImageData-compatible array (a fresh copy, safe to keep). */
  screenRGBA() {
    const w = this._c('screen_width', 'number', [], []);
    const h = this._c('screen_height', 'number', [], []);
    const ptr = this._c('screen_rgba', 'number', [], []);
    return { width: w, height: h, data: new Uint8ClampedArray(this.core.HEAPU8.buffer.slice(ptr, ptr + w * h * 4)) };
  }

  /** What the speaker is doing: raw VIA timer value written by the guest, 0 = silent. */
  get sound() { return this._c('sound', 'number', [], []); }

  /** Screen contrast latch (0 = brightest). */
  get contrast() { return this._c('contrast', 'number', [], []); }

  /** CPU registers: { d: [8], a: [8], pc, sr, context }. */
  registers() {
    const ptr = this.core._malloc(19 * 4);
    this._c('registers', null, ['number'], [ptr]);
    const r = Array.from(this.core.HEAPU32.subarray(ptr >> 2, (ptr >> 2) + 19));
    this.core._free(ptr);
    return { d: r.slice(0, 8), a: r.slice(8, 16), pc: r[16], sr: r[17], context: r[18] };
  }

  /** Read guest memory as the CPU sees it in an MMU context (1 = normal OS context). */
  readMemory(addr, length, context = 1) {
    const ptr = this.core._malloc(length || 1);
    this._c('read_memory', 'number', ['number', 'number', 'number', 'number'], [context, addr, ptr, length]);
    const out = this.core.HEAPU8.slice(ptr, ptr + length);
    this.core._free(ptr);
    return out;
  }

  /** Messages/dialogs the emulated machine raised (e.g. "No bootable OS found"). */
  messages() {
    const out = [];
    for (let m; (m = this._c('next_message', 'string', [], [])) !== null && m !== '';) out.push(m);
    return out;
  }

  // ---- waiting -----------------------------------------------------------------------

  /**
   * Run emulated time in `stepMs` increments until predicate(screen) is true.
   * Resolves to the matching Screen; rejects after `timeout` ms of emulated time.
   */
  async waitForScreen(predicate, { timeout = 30000, stepMs = 100 } = {}) {
    for (let t = 0; t <= timeout; t += stepMs) {
      const s = this.screen();
      if (predicate(s)) return s;
      this.run(stepMs);
    }
    throw new Error(`waitForScreen: timed out after ${timeout} ms of Lisa time`);
  }

  /** Run until the screen has not changed for `quietMs` of emulated time. */
  async waitForStable({ quietMs = 1000, timeout = 60000, stepMs = 100 } = {}) {
    let last = this.screen(), still = 0;
    for (let t = 0; t <= timeout; t += stepMs) {
      this.run(stepMs);
      const s = this.screen();
      if (s.equals(last)) { still += stepMs; if (still >= quietMs) return s; }
      else { still = 0; last = s; }
    }
    throw new Error(`waitForStable: still changing after ${timeout} ms of Lisa time`);
  }
}

// ---- minimal PNG encoder (1-bit grayscale, stored deflate blocks) -----------------------

function crc32(buf, crc = 0xffffffff) {
  if (!crc32.table) {
    crc32.table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc32.table[n] = c >>> 0;
    }
  }
  for (let i = 0; i < buf.length; i++) crc = crc32.table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return crc;
}

function adler32(buf) {
  let a = 1, b = 0;
  for (let i = 0; i < buf.length; i++) { a = (a + buf[i]) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}

function encodePNG1bit(width, height, bits) {
  const stride = width >> 3;
  // PNG grayscale 1-bit: 0 = black, 1 = white. Lisa bits are 1 = ink, so invert.
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    for (let x = 0; x < stride; x++) raw[y * (stride + 1) + 1 + x] = ~bits[y * stride + x] & 0xff;
  }
  // zlib stream with stored blocks
  const blocks = [];
  for (let i = 0; i < raw.length; i += 65535) {
    const chunk = raw.subarray(i, Math.min(i + 65535, raw.length));
    const last = i + 65535 >= raw.length ? 1 : 0;
    blocks.push(Uint8Array.of(last, chunk.length & 255, chunk.length >> 8, ~chunk.length & 255, (~chunk.length >> 8) & 255), chunk);
  }
  const ad = adler32(raw);
  const z = concat([Uint8Array.of(0x78, 0x01), ...blocks, Uint8Array.of(ad >>> 24, (ad >> 16) & 255, (ad >> 8) & 255, ad & 255)]);

  const be32 = (n) => Uint8Array.of(n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255);
  const chunk = (type, data) => {
    const t = new TextEncoder().encode(type);
    const td = concat([t, data]);
    return concat([be32(data.length), td, be32((crc32(td) ^ 0xffffffff) >>> 0)]);
  };
  const ihdr = concat([be32(width), be32(height), Uint8Array.of(1, 0, 0, 0, 0)]); // 1-bit gray
  return concat([
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    chunk('IHDR', ihdr), chunk('IDAT', z), chunk('IEND', new Uint8Array(0)),
  ]);
}

function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
