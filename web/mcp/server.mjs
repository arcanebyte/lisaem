#!/usr/bin/env node
// MCP server: lets an AI agent (or any MCP client) run and drive an emulated Apple Lisa.
//
//   node mcp/server.mjs --media <dir> [--media <dir> ...] [--out <dir>] [--ram 1024]
//
// Speaks the Model Context Protocol over stdio (newline-delimited JSON-RPC 2.0); stdout carries only
// protocol messages, logs go to stderr. There is one machine per server process.
//
// Files: disk images and ROMs are only ever read from the --media directories, and exports and saved
// snapshots are only ever written inside --out. Without --out, nothing can be written.
//
// Time is emulated: the Lisa only advances when a tool says so (lisa_run, or any action that waits),
// by an exact amount, so the same sequence of calls always gives the same result.

import { readFileSync, writeFileSync, readdirSync, statSync, realpathSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, sep, basename } from 'node:path';
import { createInterface } from 'node:readline';
import { Lisa, KEY } from '../js/lisa.js';

// stdout carries only protocol messages: anything that tries to print there goes to stderr instead.
console.log = console.error;
const VERSION = '0.1.0';
const argv = process.argv.slice(2);
const multi = (name) => argv.flatMap((a, i) => (a === '--' + name && argv[i + 1] ? [argv[i + 1]] : []));
const mediaDirs = [...multi('media'), ...(process.env.LISA_MEDIA ? process.env.LISA_MEDIA.split(':') : [])]
  .map((d) => { try { return realpathSync(resolve(d)); } catch { return null; } }).filter(Boolean);
const outDirArg = multi('out')[0] ?? process.env.LISA_OUT;
const outDir = outDirArg ? resolve(outDirArg) : null;
const defaultRam = +(multi('ram')[0] ?? 1024);

const log = (...a) => console.error('[lisa-mcp]', ...a);

// ---- state ----------------------------------------------------------------------------------

let lisa = null;                 // the current machine
let info = null;                 // how it was started
const snapshots = new Map();     // named in-memory snapshots
const MAX_SNAPSHOTS = 6;         // each is roughly 50 MB of memory

// ---- files ----------------------------------------------------------------------------------

const KINDS = [[/\.(bin|rom|lo|hi)$/i, 'rom'], [/\.lsnp$/i, 'snapshot'], [/\.(dc42|dc|img|image|dsk|raw|dmg|twiggy)$/i, 'disk']];
const kindOf = (name, size) => {
  const k = KINDS.find(([re]) => re.test(name))?.[1] ?? 'file';
  return k === 'disk' ? (size > 2 * 1024 * 1024 ? 'profile-disk' : 'floppy') : k;
};

function inside(dir, p) { return p === dir || p.startsWith(dir + sep); }

/** Resolve a file name (or absolute path) to a real file inside one of the --media directories. */
function mediaPath(name) {
  if (!mediaDirs.length) throw new Error('no media directory configured: start the server with --media <dir>');
  for (const dir of mediaDirs) {
    const cand = name.startsWith('/') ? name : join(dir, name);
    let real;
    try { real = realpathSync(cand); } catch { continue; }
    if (inside(dir, real) && statSync(real).isFile()) return real;
  }
  throw new Error(`"${name}" is not a file in the media directories (${mediaDirs.join(', ')}); use lisa_list_media`);
}

/** A path inside --out where we may write; creates the directory if needed. */
function outPath(name) {
  if (!outDir) throw new Error('writing is disabled: start the server with --out <dir>');
  const p = resolve(outDir, basename(name));   // basename: no subdirectories, no traversal
  mkdirSync(outDir, { recursive: true });
  return p;
}

// ---- helpers --------------------------------------------------------------------------------

const text = (t) => ({ type: 'text', text: t });
const png = (screen) => ({ type: 'image', data: Buffer.from(screen.toPNG()).toString('base64'), mimeType: 'image/png' });

function need() {
  if (!lisa) throw new Error('no machine is running: call lisa_start first');
  return lisa;
}

const num = (v, d) => (v === undefined ? d : Number(v));
const hex = (n) => '0x' + (n >>> 0).toString(16).padStart(6, '0');
const parseAddr = (v) => (typeof v === 'string' ? parseInt(v, v.startsWith('0x') ? 16 : 10) : Number(v));

function stateLine() {
  const m = lisa;
  const os = ['ROM', 'Lisa Office System', 'Lisa Test', 'MacWorks', 'Monitor', 'Xenix', 'UniPlus', 'UniPlus Sunix'][m._c('running_os', 'number', [], [])] ?? 'unknown OS';
  const flags = m.poweredOff ? ' [POWERED OFF]' : '';
  return `t=${(m.time / 1000).toFixed(2)} s, running: ${os}${flags}`;
}

function drain(extra = []) {
  const out = [...extra];
  for (const msg of lisa?.messages() ?? []) out.push('machine message: ' + msg.replace(/^dialog: /, ''));
  return out;
}

/** Common tail of action tools: advance a little, report, optionally attach a screenshot. */
function report(args, lines) {
  const content = [text([...drain(lines), stateLine()].join('\n'))];
  if (args.screenshot) content.push(png(shot(args)));
  return { content };
}

function shot({ scale = 1, aspect_correct = true, crop } = {}) {
  let s = lisa.screen();
  if (crop) s = s.crop(crop.x, crop.y, crop.w, crop.h);
  const sc = Math.max(1, Math.min(4, Math.round(scale)));
  const ay = aspect_correct && !crop && s.width === 720 ? 500 / 364 : 1; // the Lisa's pixels are taller than wide
  if (sc === 1 && ay === 1) return s;
  return s.resized(s.width * sc, Math.round(s.height * sc * ay));
}

function runChecked(ms) {
  const st = lisa.run(ms);
  const notes = [];
  if (st.fatal) notes.push('The machine hit a fatal error and has stopped.');
  if (st.rebooted) notes.push('The Lisa restarted.');
  if (st.poweredOff) notes.push('The Lisa powered off.');
  return notes;
}

// ---- tools ----------------------------------------------------------------------------------

const SHOT = { screenshot: { type: 'boolean', description: 'also return a screenshot (default false)' } };
const tools = [];
const tool = (name, description, properties, required, run) =>
  tools.push({ name, description, inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) }, run });

tool('lisa_list_media',
  'List the disk images, boot ROMs and saved snapshots available to lisa_start.', {}, [], async () => {
    if (!mediaDirs.length) return { content: [text('No media directories configured (start the server with --media <dir>).')] };
    const rows = [];
    for (const dir of mediaDirs)
      for (const n of readdirSync(dir).sort()) {
        const st = statSync(join(dir, n));
        if (st.isFile() && KINDS.some(([re]) => re.test(n))) rows.push(`${kindOf(n, st.size).padEnd(13)} ${String(st.size).padStart(10)}  ${n}`);
      }
    return { content: [text(rows.length ? `kind          bytes       name\n${rows.join('\n')}` : 'No disk images or ROMs found.')] };
  });

tool('lisa_start',
  'Power on a new Lisa (replacing any current one). With no ROM it boots a floppy or ProFile directly (ROM-less); ' +
  'with a ROM it boots like the real machine through the ROM\'s self-test and startup menu (about 3 s of Lisa time), ' +
  'pressing the key for the chosen device. Use lisa_list_media for names. Then use lisa_run to let it boot.',
  {
    floppy: { type: 'string', description: 'floppy disk image name (DiskCopy 4.2)' },
    profile: { type: 'string', description: 'ProFile hard disk image name' },
    rom: { type: 'array', items: { type: 'string' }, description: 'boot ROM: one 16 KB file, or [lo, hi] file names (341-0176 then 341-0175)' },
    boot: { type: 'string', enum: ['floppy', 'profile', 'menu'], description: 'device to boot (default: floppy if given, else profile). "menu" stops at the ROM startup menu (ROM only).' },
    ram_kb: { type: 'number', description: '512, 1024 (default) or 2048' },
    real_clock: { type: 'boolean', description: 'start the Lisa clock at the real time instead of a fixed date (default false: fixed, so runs are reproducible)' },
    serial: { type: 'array', items: { type: 'string', enum: ['a', 'b'] }, description: 'serial ports to connect to lisa_serial_write/read' },
    ...SHOT,
  }, [], async (a) => {
    if (!a.floppy && !a.profile && !(a.rom && a.boot === 'menu')) throw new Error('give a floppy and/or profile to boot (or a rom with boot "menu")');
    const m = await Lisa.create({ ramKB: num(a.ram_kb, defaultRam), clock: a.real_clock ? 'now' : undefined });
    const lines = [];
    for (const p of a.serial ?? []) m.serialAttach(p);
    if (a.profile && !m.mountProfile(readFileSync(mediaPath(a.profile)), 'profile.dc42')) throw new Error(`could not mount ProFile ${a.profile}`);
    if (a.floppy && !m.insertFloppy(readFileSync(mediaPath(a.floppy)), 'floppy.dc42')) throw new Error(`${a.floppy} is not a valid floppy image`);
    const dev = a.boot ?? (a.floppy ? 'floppy' : 'profile');
    if (a.rom?.length) {
      const files = a.rom.map((n) => readFileSync(mediaPath(n)));
      const r = m.loadROM(files.length === 2 ? { lo: files[0], hi: files[1] } : files[0]);
      lines.push(`ROM ${r.version} (${r.format})${r.checksumOk ? '' : ' - checksum does not match a stock ROM'}`);
      m.powerOn({ boot: dev === 'menu' ? 'none' : dev });
    } else {
      if (!(dev === 'profile' ? m.bootProfile() : m.bootFloppy())) { lisa = null; throw new Error('ROM-less boot failed: ' + m.messages().join('; ')); }
    }
    lisa = m;
    info = { floppy: a.floppy, profile: a.profile, rom: a.rom, boot: dev };
    return report(a, [`Lisa started (${dev}). Nothing has run yet: use lisa_run to let it boot.`, ...lines]);
  });

tool('lisa_status', 'What the machine is doing: emulated time, running OS, how it was started, snapshots.', {}, [], async () => {
  if (!lisa) return { content: [text('No machine is running.')] };
  const p = lisa.pointer();
  return { content: [text([stateLine(), `started with: ${JSON.stringify(info)}`, `guest mouse pointer: ${p.x},${p.y}`,
    `snapshots: ${[...snapshots.keys()].join(', ') || 'none'}`].join('\n'))] };
});

tool('lisa_run', 'Advance the Lisa by an exact amount of emulated time (it runs much faster than real time). Use it to let things boot or animate.',
  { ms: { type: 'number', minimum: 1, maximum: 600000, description: 'milliseconds of Lisa time, 1 to 600000' }, ...SHOT }, ['ms'], async (a) => {
    need();
    const ms = Math.max(1, Math.min(600000, num(a.ms, 1000)));
    const notes = runChecked(ms);
    return report(a, notes);
  });

tool('lisa_screenshot',
  'See the Lisa\'s screen (720x364, black and white). By default it is shown with corrected proportions; use scale 2 to make small text legible.',
  {
    scale: { type: 'number', minimum: 1, maximum: 4, description: 'integer enlargement 1-4 (default 1)' },
    aspect_correct: { type: 'boolean', description: 'stretch to the Lisa\'s real pixel shape (default true)' },
    crop: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } }, required: ['x', 'y', 'w', 'h'], description: 'only this rectangle, in Lisa screen pixels' },
    ascii: { type: 'boolean', description: 'also return a rough text rendering' },
  }, [], async (a) => {
    need();
    const content = [png(shot(a))];
    if (a.ascii) content.push(text(lisa.screen().toAscii()));
    content.push(text(stateLine() + `; coordinates for clicks are in the 720x364 Lisa pixel grid.`));
    return { content };
  });

tool('lisa_type', 'Type text on the Lisa keyboard. A newline is Return. Time advances while the keys are delivered.',
  { text: { type: 'string' }, ...SHOT }, ['text'], async (a) => {
    need();
    const n = lisa.type(a.text);
    const notes = runChecked(Math.max(300, 40 * a.text.length));
    return report(a, [`typed ${n} of ${a.text.length} characters`, ...notes]);
  });

const KEYNAMES = Object.keys(KEY).filter((k) => !/^\d$/.test(k));
tool('lisa_key',
  'Press keys together, hold them, then release (a chord such as ["COMMAND","S"], or a single key). Names: ' + KEYNAMES.join(', ') + ', and the digits 0-9. COMMAND is the Apple key.',
  { keys: { type: 'array', minItems: 1, items: { type: 'string' } }, hold_ms: { type: 'number', minimum: 0, maximum: 60000, description: 'default 120' }, ...SHOT }, ['keys'], async (a) => {
    need();
    const codes = a.keys.map((k) => { const c = KEY[String(k).toUpperCase()]; if (c === undefined) throw new Error(`unknown key "${k}"`); return c; });
    for (const c of codes) lisa.key(c, true);
    const notes = runChecked(num(a.hold_ms, 120));
    for (const c of [...codes].reverse()) lisa.key(c, false);
    notes.push(...runChecked(200));
    return report(a, notes);
  });

tool('lisa_click', 'Click (or double-click) at a point on the screen, in Lisa pixels (0-719, 0-363). Moves the pointer there first and waits for it to arrive.',
  { x: { type: 'number', minimum: 0, maximum: 719 }, y: { type: 'number', minimum: 0, maximum: 430 }, double: { type: 'boolean' }, ...SHOT }, ['x', 'y'], async (a) => {
    need();
    const arrived = a.double ? lisa.doubleClick(a.x, a.y) : lisa.click(a.x, a.y);
    const notes = runChecked(300);
    return report(a, [arrived ? `clicked at ${a.x},${a.y}` : `clicked at ${a.x},${a.y}, but the pointer never reached it (is the OS reading the mouse yet?)`, ...notes]);
  });

tool('lisa_mouse', 'Move the pointer, or press / release the button at a point (for drags and menus).',
  { x: { type: 'number', minimum: 0, maximum: 719 }, y: { type: 'number', minimum: 0, maximum: 430 }, action: { type: 'string', enum: ['move', 'down', 'up'] }, ...SHOT }, ['x', 'y', 'action'], async (a) => {
    need();
    if (a.action === 'move') lisa.mouseTo(a.x, a.y);
    else if (a.action === 'down') { lisa.mouseTo(a.x, a.y); lisa.mouseDown(a.x, a.y); }
    else lisa.mouseUp(a.x, a.y);
    return report(a, [...runChecked(a.action === 'up' ? 400 : 250), `mouse ${a.action} at ${a.x},${a.y}`]);
  });

tool('lisa_drag', 'Press at one point, drag to another, release.',
  { from: { type: 'object', properties: { x: { type: 'number', minimum: 0, maximum: 719 }, y: { type: 'number', minimum: 0, maximum: 430 } }, required: ['x', 'y'] },
    to: { type: 'object', properties: { x: { type: 'number', minimum: 0, maximum: 719 }, y: { type: 'number', minimum: 0, maximum: 430 } }, required: ['x', 'y'] }, ...SHOT }, ['from', 'to'], async (a) => {
    need();
    lisa.mouseTo(a.from.x, a.from.y); lisa.mouseDown(a.from.x, a.from.y); lisa.run(150);
    const arrived = lisa.mouseTo(a.to.x, a.to.y); lisa.run(150);
    lisa.mouseUp(a.to.x, a.to.y);
    return report(a, [...runChecked(500), arrived ? 'dragged' : 'dragged, but the pointer did not reach the destination']);
  });

tool('lisa_wait_for_change', 'Run until the screen changes by at least a given fraction, or time runs out. Good for "wait until it reacts".',
  { timeout_ms: { type: 'number', description: 'default 30000' }, min_change: { type: 'number', description: 'fraction of pixels, default 0.002' }, ...SHOT }, [], async (a) => {
    need();
    const base = lisa.screen(), timeout = num(a.timeout_ms, 30000), min = num(a.min_change, 0.002);
    let t = 0, d = 0;
    for (; t < timeout; t += 100) { lisa.run(100); d = lisa.screen().diff(base); if (d >= min) break; }
    return report(a, [d >= min ? `screen changed (${(d * 100).toFixed(2)}% of pixels) after ${t} ms` : `no change within ${timeout} ms`]);
  });

tool('lisa_wait_for_stable', 'Run until the screen has stopped changing for a while (an animation finished, a load completed).',
  { quiet_ms: { type: 'number', description: 'how long it must stay unchanged, default 1500' }, timeout_ms: { type: 'number', description: 'default 60000' }, ...SHOT }, [], async (a) => {
    need();
    const quiet = num(a.quiet_ms, 1500), timeout = num(a.timeout_ms, 60000);
    let last = lisa.screen(), still = 0, t = 0;
    for (; t < timeout && still < quiet; t += 100) {
      lisa.run(100);
      const s = lisa.screen();
      if (s.equals(last)) still += 100; else { still = 0; last = s; }
    }
    return report(a, [still >= quiet ? `stable after ${t} ms` : `still changing after ${timeout} ms`]);
  });

tool('lisa_registers', 'Read the 68000 registers (D0-D7, A0-A7, PC, SR) and the current MMU context.', {}, [], async () => {
  need();
  const r = lisa.registers();
  const row = (p, arr) => arr.map((v, i) => `${p}${i}=${(v >>> 0).toString(16).padStart(8, '0')}`).join(' ');
  return { content: [text(`${row('D', r.d)}\n${row('A', r.a)}\nPC=${hex(r.pc)} SR=${r.sr.toString(16).padStart(4, '0')} context=${r.context}`)] };
});

tool('lisa_read_memory', 'Read guest memory as the CPU sees it (hex dump). Context 1 is the normal OS address space.',
  { address: { type: ['number', 'string'], description: 'number, or hex string like "0x2000"' }, length: { type: 'number', minimum: 1, maximum: 4096, description: '1-4096, default 64' }, context: { type: 'number', description: 'MMU context, default 1' } }, ['address'], async (a) => {
    need();
    const addr = parseAddr(a.address), len = Math.max(1, Math.min(4096, num(a.length, 64)));
    const bytes = lisa.readMemory(addr, len, num(a.context, 1));
    const lines = [];
    for (let i = 0; i < len; i += 16) {
      const row = bytes.subarray(i, i + 16);
      lines.push(`${hex(addr + i)}  ${[...row].map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(47)}  ${[...row].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('')}`);
    }
    return { content: [text(lines.join('\n'))] };
  });

tool('lisa_serial_write', 'Send text (or hex bytes) to a Lisa serial port that was connected with lisa_start serial: [...].',
  { port: { type: 'string', enum: ['a', 'b'] }, text: { type: 'string' }, hex: { type: 'string', description: 'bytes as hex, e.g. "1b5b41"' } }, ['port'], async (a) => {
    need();
    const data = a.hex ? Uint8Array.from(a.hex.match(/../g).map((h) => parseInt(h, 16))) : new TextEncoder().encode(a.text ?? '');
    const n = lisa.serialWrite(a.port, data);
    return { content: [text(`${n} of ${data.length} bytes accepted by serial ${a.port}`)] };
  });

tool('lisa_serial_read', 'Read what the Lisa has transmitted on a serial port since the last read.',
  { port: { type: 'string', enum: ['a', 'b'] } }, ['port'], async (a) => {
    need();
    const b = lisa.serialRead(a.port);
    return { content: [text(b.length ? `${b.length} bytes:\ntext: ${JSON.stringify(new TextDecoder().decode(b))}\nhex: ${Buffer.from(b).toString('hex')}` : 'nothing received')] };
  });

tool('lisa_snapshot', 'Save the entire machine state under a name (takes ~50 ms). Restore it later with lisa_restore to rewind instantly, e.g. to try several things from one booted desktop.',
  { name: { type: 'string' } }, ['name'], async (a) => {
    need();
    if (!snapshots.has(a.name) && snapshots.size >= MAX_SNAPSHOTS) throw new Error(`at most ${MAX_SNAPSHOTS} snapshots are kept in memory; delete one with lisa_snapshot_delete`);
    snapshots.set(a.name, { snap: lisa.snapshot(), at: lisa.time });
    return { content: [text(`snapshot "${a.name}" saved at t=${(lisa.time / 1000).toFixed(2)} s`)] };
  });

tool('lisa_restore', 'Rewind the machine to a named snapshot. Everything, including the disks, goes back.',
  { name: { type: 'string' }, ...SHOT }, ['name'], async (a) => {
    need();
    const s = snapshots.get(a.name);
    if (!s) throw new Error(`no snapshot "${a.name}"; have: ${[...snapshots.keys()].join(', ') || 'none'}`);
    lisa.restore(s.snap);
    return report(a, [`restored "${a.name}"`]);
  });

tool('lisa_snapshot_delete', 'Forget a named snapshot to free memory.', { name: { type: 'string' } }, ['name'], async (a) => {
  return { content: [text(snapshots.delete(a.name) ? `deleted "${a.name}"` : `no snapshot "${a.name}"`)] };
});

tool('lisa_snapshot_save_file', 'Write the current machine to a file in the --out directory, to resume in a later session with lisa_snapshot_load_file.',
  { file: { type: 'string', description: 'file name, e.g. desktop.lsnp' } }, ['file'], async (a) => {
    need();
    const path = outPath(a.file.endsWith('.lsnp') ? a.file : a.file + '.lsnp');
    const bytes = await lisa.serialize();
    writeFileSync(path, bytes);
    return { content: [text(`wrote ${path} (${(bytes.length / 1048576).toFixed(1)} MB) at t=${(lisa.time / 1000).toFixed(2)} s`)] };
  });

tool('lisa_snapshot_load_file', 'Replace the current machine with one saved by lisa_snapshot_save_file (looked up in the media directories, then --out).',
  { file: { type: 'string' }, ...SHOT }, ['file'], async (a) => {
    let path;
    try { path = mediaPath(a.file); } catch (e) {
      if (!outDir) throw e;
      const p = resolve(outDir, basename(a.file));
      if (!existsSync(p)) throw e;
      path = p;
    }
    lisa = await Lisa.deserialize(new Uint8Array(readFileSync(path)));
    info = { resumedFrom: basename(path) };
    return report(a, [`resumed ${basename(path)}`]);
  });

tool('lisa_export_disk', 'Save a disk exactly as the guest has left it (including everything it wrote) to a file in the --out directory.',
  { kind: { type: 'string', enum: ['profile', 'floppy'] }, file: { type: 'string' } }, ['kind', 'file'], async (a) => {
    need();
    const bytes = a.kind === 'profile' ? lisa.exportProfile() : lisa.exportFloppy();
    if (!bytes) throw new Error(`no ${a.kind} is mounted`);
    const path = outPath(a.file);
    writeFileSync(path, bytes);
    return { content: [text(`wrote ${path} (${bytes.length} bytes)`)] };
  });


// ---- argument validation ----------------------------------------------------------------------
// Checks tool arguments against the tool's own inputSchema (the subset of JSON Schema used here) so
// that a wrong or misspelled argument produces a clear message instead of a silent default or a stack
// trace. Returns an error string, or null when the value is acceptable.

function typeOf(v) { return v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v; }

function validate(schema, v, path) {
  const types = [].concat(schema.type ?? []);
  if (types.length) {
    const t = typeOf(v);
    const ok = types.some((want) => want === t || (want === 'number' && t === 'integer'));
    if (!ok) return `${path} must be ${types.join(' or ')}, got ${t}${typeof v === 'string' ? ` ("${v.slice(0, 30)}")` : ''}`;
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return `${path} must be a finite number`;
    if (schema.minimum !== undefined && v < schema.minimum) return `${path} must be at least ${schema.minimum}, got ${v}`;
    if (schema.maximum !== undefined && v > schema.maximum) return `${path} must be at most ${schema.maximum}, got ${v}`;
  }
  if (schema.enum && !schema.enum.includes(v)) return `${path} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}, got ${JSON.stringify(v)}`;
  if (Array.isArray(v)) {
    if (schema.minItems !== undefined && v.length < schema.minItems) return `${path} needs at least ${schema.minItems} item(s)`;
    for (let i = 0; i < v.length && schema.items; i++) { const e = validate(schema.items, v[i], `${path}[${i}]`); if (e) return e; }
  }
  if (v && typeof v === 'object' && !Array.isArray(v) && schema.properties) {
    for (const k of schema.required ?? []) if (v[k] === undefined) return `missing required argument ${path ? path + '.' : ''}${k}`;
    for (const k of Object.keys(v)) {
      if (!(k in schema.properties)) return `unknown argument ${path ? path + '.' : ''}${k} (valid: ${Object.keys(schema.properties).join(', ') || 'none'})`;
      const e = validate(schema.properties[k], v[k], `${path ? path + '.' : ''}${k}`);
      if (e) return e;
    }
  }
  return null;
}

// ---- MCP protocol ---------------------------------------------------------------------------

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS =
  'This server runs an emulated Apple Lisa (1983 computer, 720x364 monochrome display, mouse, keyboard). ' +
  'Typical use: lisa_list_media, lisa_start (with a floppy/profile and optionally a boot ROM), lisa_run to let it boot, ' +
  'lisa_screenshot to look, then lisa_click / lisa_type / lisa_key to interact. Time only advances when you ask. ' +
  'Take a lisa_snapshot at a good state so you can lisa_restore to it after experiments.';

async function handle(req) {
  const { method, params = {} } = req;
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: SUPPORTED.includes(params.protocolVersion) ? params.protocolVersion : SUPPORTED[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'lisaem-web', version: VERSION },
        instructions: INSTRUCTIONS,
      };
    case 'ping': return {};
    case 'tools/list':
      return { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
    case 'tools/call': {
      const t = tools.find((x) => x.name === params.name);
      if (!t) throw Object.assign(new Error(`unknown tool ${params.name}`), { code: -32602 });
      const bad = validate(t.inputSchema, params.arguments ?? {}, '');
      if (bad) return { isError: true, content: [text(`invalid arguments for ${t.name}: ${bad}`)] };
      try {
        return await t.run(params.arguments ?? {});
      } catch (e) {
        return { isError: true, content: [text(String(e.message || e))] }; // tool failures are results, not protocol errors
      }
    }
    default:
      throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
  }
}

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

// Answer one JSON-RPC message; returns the response object, or null for a notification.
async function respond(req) {
  if (!req || typeof req !== 'object' || typeof req.method !== 'string')
    return { jsonrpc: '2.0', id: req?.id ?? null, error: { code: -32600, message: 'invalid request' } };
  if (req.id === undefined) { try { await handle(req); } catch { /* notifications get no reply */ } return null; }
  try { return { jsonrpc: '2.0', id: req.id, result: await handle(req) }; }
  catch (e) { return { jsonrpc: '2.0', id: req.id, error: { code: e.code ?? -32603, message: String(e.message || e) } }; }
}

let chain = Promise.resolve();   // one request at a time: they all share the one machine
createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
  chain = chain.then(async () => {
    if (Array.isArray(msg)) { // a batch: answer with an array, in order
      if (!msg.length) return send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'empty batch' } });
      const out = [];
      for (const m of msg) { const r = await respond(m); if (r) out.push(r); }
      if (out.length) send(out);
    } else {
      const r = await respond(msg);
      if (r) send(r);
    }
  });
});

log(`ready; media: ${mediaDirs.join(', ') || '(none)'}; out: ${outDir ?? '(writing disabled)'}`);
