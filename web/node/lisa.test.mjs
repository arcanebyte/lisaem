// Regression tests for the web/headless Lisa.  They need a bootable floppy image, which is not
// shipped with the source. Point LISA_TEST_FLOPPY at a Lisa Office System 3.0 install disk 1
// (DiskCopy 4.2) to run them; without it they are skipped.
//
//   LISA_TEST_FLOPPY="/path/LOS 3.0 1.image" node --test node/lisa.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Lisa, KEY } from '../js/lisa.js';

const path = process.env.LISA_TEST_FLOPPY;
const skip = path ? false : 'set LISA_TEST_FLOPPY to run';

async function boot(seconds = 15) {
  const lisa = await Lisa.create({ ramKB: 1024 });
  assert.ok(lisa.insertFloppy(readFileSync(path)), 'floppy image accepted');
  assert.ok(lisa.bootFloppy(), 'romless boot started');
  lisa.run(seconds * 1000);
  return lisa;
}

test('boots to the installer and draws to the screen', { skip }, async () => {
  const lisa = await boot();
  const s = lisa.screen();
  assert.equal(s.width, 720);
  assert.equal(s.height, 364);
  assert.ok(s.inkCount() > 20000, 'screen has content');
  assert.deepEqual(lisa.messages(), []);
  assert.ok(lisa._c('running_os', 'number', [], []) === 1, 'Office System detected');
});

test('the same script always produces the same screen (deterministic)', { skip }, async () => {
  const run = async () => {
    const lisa = await boot();
    lisa.click(600, 216);
    lisa.run(3000);
    return lisa.screen().hash();
  };
  assert.equal(await run(), await run());
});

test('mouse: pointer arrives and clicking Install changes the screen', { skip }, async () => {
  const lisa = await boot();
  const before = lisa.screen();
  assert.ok(lisa.click(600, 216), 'pointer reached the target');
  const p = lisa.pointer();
  assert.ok(Math.abs(p.x - 600) <= 3 && Math.abs(p.y - 216) <= 3, `pointer at ${p.x},${p.y}`);
  lisa.run(3000);
  const d = lisa.screen().diff(before);
  assert.ok(d > 0.05, `screen changed substantially (changed ${d.toFixed(4)})`);
});

test('keyboard: typed keys are consumed by the guest', { skip }, async () => {
  const lisa = await boot();
  lisa.type('hello\n');
  lisa.tap(KEY.SPACE);
  lisa.run(500);
  assert.equal(lisa._c('typing_pending', 'number', [], []), 0, 'host queue drained');
  assert.equal(lisa._c('cops_pending', 'number', [], []), 0, 'COPS queue drained by the guest');
});

test('screen capture encodes a valid PNG', { skip }, async () => {
  const lisa = await boot(5);
  const png = lisa.screenshotPNG();
  assert.deepEqual(Array.from(png.slice(0, 8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(png.length > 1000);
});

// ---- Boot ROM plumbing -------------------------------------------------------------------
// These use a tiny ROM generated here (initial SSP 0x480, reset PC 0xFE0008, then BRA.S *). It is
// not Apple's ROM; it only proves that loading, reset and execution from the ROM region work. They
// need no disk image and always run.

function syntheticROM(version = [0x02, 0x58]) {
  const rom = new Uint8Array(16384);
  rom.set([0, 0, 0x04, 0x80, 0, 0xfe, 0, 0x08, 0x60, 0xfe], 0);
  rom[0x3ffc] = version[0]; rom[0x3ffd] = version[1];
  return rom;
}
const halves = (rom) => {
  const odd = new Uint8Array(8192), even = new Uint8Array(8192);
  for (let i = 0; i < 8192; i++) { even[i] = rom[2 * i]; odd[i] = rom[2 * i + 1]; }
  return { lo: odd, hi: even }; // .lo = odd-addressed bytes, .hi = even-addressed bytes
};

test('ROM: a 16 KB image loads, powers on and runs from the ROM', async () => {
  const lisa = await Lisa.create();
  const info = lisa.loadROM(syntheticROM());
  assert.equal(info.format, 'binary');
  assert.equal(info.version, '2.X');
  assert.equal(info.checksumOk, false, 'a made-up ROM does not have a valid checksum');
  lisa.powerOn();
  const st = lisa.run(100);
  assert.equal(st.fatal, false);
  assert.equal(lisa.registers().pc & 0xfffffe, 0xfe0008, 'executing the ROM loop');
});

test('ROM: lo/hi split pairs load, and swapped halves are rejected', async () => {
  const { lo, hi } = halves(syntheticROM());
  const ok = await Lisa.create();
  assert.equal(ok.loadROM({ lo, hi }).format, 'split');
  const bad = await Lisa.create();
  assert.throws(() => bad.loadROM({ lo: hi, hi: lo }), /not a recognised/);
});

test('ROM: powerOn without a ROM is an error; garbage is not accepted as a ROM', async () => {
  const lisa = await Lisa.create();
  assert.throws(() => lisa.powerOn(), /no ROM/);
  assert.throws(() => lisa.loadROM(new Uint8Array(100)), /not a recognised/);
});

test('ROM: a 3A (XL) ROM switches the display to 608x431', async () => {
  const lisa = await Lisa.create();
  const info = lisa.loadROM(syntheticROM([0x03, 0x41]));
  assert.equal(info.xl, true);
  lisa.powerOn();
  const s = lisa.screen();
  assert.deepEqual([s.width, s.height], [608, 431]);
});

// ---- Real Boot ROM ------------------------------------------------------------------------
// Needs your own ROM and a bootable floppy; none are shipped.
//   LISA_TEST_ROM="341-0176-H.BIN,341-0175-H.BIN" (lo,hi)  or a single 16 KB file
//   LISA_TEST_FLOPPY="LOS 3.0 1.image"
const romEnv = process.env.LISA_TEST_ROM;
const skipRom = romEnv && path ? false : 'set LISA_TEST_ROM and LISA_TEST_FLOPPY to run';
const loadRomEnv = () => {
  const p = romEnv.split(',');
  return p.length === 2 ? { lo: readFileSync(p[0]), hi: readFileSync(p[1]) } : readFileSync(p[0]);
};

test('real ROM: self-test passes and the startup menu appears', { skip: skipRom }, async () => {
  const lisa = await Lisa.create();
  const info = lisa.loadROM(loadRomEnv());
  assert.equal(info.checksumOk, true, 'ROM checksum');
  lisa.powerOn();
  const st = lisa.run(6000);
  assert.equal(st.fatal, false);
  assert.ok(lisa._c('running_os', 'number', [], []) === 0, 'still in the ROM');
  const s = lisa.screen();
  assert.ok(s.inkCount() > 100000, 'a patterned background is drawn');
  assert.deepEqual(lisa.messages(), []);
});

test('real ROM: boots the floppy, to the same screen as the ROM-less loader', { skip: skipRom }, async () => {
  const viaRom = await Lisa.create();
  viaRom.insertFloppy(readFileSync(path));
  viaRom.loadROM(loadRomEnv());
  viaRom.powerOn({ boot: 'floppy' });
  viaRom.run(60000);
  const hle = await boot(15);
  assert.equal(viaRom.screen().hash(), hle.screen().hash());
  assert.equal(viaRom._c('running_os', 'number', [], []), 1, 'Office System detected');
});

// ---- ProFile (hard disk) boot ---------------------------------------------------------------
// LISA_TEST_PROFILE = a ProFile image with Lisa Office System on it; needs LISA_TEST_ROM for the ROM path.
const profilePath = process.env.LISA_TEST_PROFILE;
const skipProfile = profilePath ? false : 'set LISA_TEST_PROFILE to run';

test('ProFile: boots the Office System by ROM-less loader and through the ROM, to the same screen', { skip: skipProfile || (romEnv ? false : 'needs LISA_TEST_ROM too') }, async () => {
  const hle = await Lisa.create();
  assert.ok(hle.mountProfile(readFileSync(profilePath)));
  assert.ok(hle.bootProfile());
  hle.run(60000);
  const viaRom = await Lisa.create();
  viaRom.mountProfile(readFileSync(profilePath));
  viaRom.loadROM(loadRomEnv());
  viaRom.powerOn({ boot: 'profile' }); // presses Apple-3
  viaRom.run(60000);
  assert.equal(hle._c('running_os', 'number', [], []), 1, 'Office System (ROM-less)');
  assert.equal(viaRom._c('running_os', 'number', [], []), 1, 'Office System (ROM)');
  assert.equal(viaRom.screen().hash(), hle.screen().hash());
});

// LISA_TEST_SELECTOR = a ProFile image of a program that waits for a key at a prompt and quits to the ROM on
// Q (the ESProFile "selector" tool does this).
const selectorPath = process.env.LISA_TEST_SELECTOR;
test('keyboard: a typed Q reaches a guest program, which quits to the ROM', { skip: selectorPath && romEnv ? false : 'set LISA_TEST_SELECTOR and LISA_TEST_ROM' }, async () => {
  const lisa = await Lisa.create();
  lisa.mountProfile(readFileSync(selectorPath));
  lisa.loadROM(loadRomEnv());
  lisa.powerOn({ boot: 'profile' });
  lisa.run(20000);
  const before = lisa.screen();
  assert.ok(before.inkCount() < 10000, 'the tool is showing its text prompt');
  lisa.type('q');
  lisa.run(6000);
  const after = lisa.screen();
  assert.ok(after.inkCount() > 50000, 'back at the ROM screen');
  assert.ok((lisa.registers().pc & 0xff0000) === 0xfe0000, 'executing in the ROM');
});

test('ProFile: clicking through the Office System prompt reaches the desktop', { skip: skipProfile || (romEnv ? false : 'needs LISA_TEST_ROM too') }, async () => {
  const lisa = await Lisa.create();
  lisa.mountProfile(readFileSync(profilePath));
  lisa.loadROM(loadRomEnv());
  lisa.powerOn({ boot: 'profile' });
  lisa.run(60000);
  const prompt = lisa.screen();
  lisa.click(590, 70); // "Don't Check" on the unclean-shutdown prompt, if this image has one
  lisa.run(30000);
  assert.ok(lisa.screen().diff(prompt) > 0.1, 'screen changed to the desktop');
});

// ---- Snapshots and disk export ---------------------------------------------------------------

test('snapshot: restore rewinds the machine exactly, repeatably', { skip }, async () => {
  const lisa = await boot(15);
  const snap = lisa.snapshot();
  const scenario = () => { lisa.click(600, 216); lisa.run(3000); return [lisa.screen().hash(), lisa.time]; };
  const first = scenario();
  lisa.restore(snap);
  const second = scenario();
  lisa.restore(snap);
  const third = scenario();
  assert.deepEqual(second, first);
  assert.deepEqual(third, first);
});

test('snapshot: serialize/deserialize into a fresh machine continues identically', { skip }, async () => {
  const a = await boot(15);
  const bytes = await a.serialize();
  const b = await Lisa.deserialize(bytes);
  assert.equal(b.screen().hash(), a.screen().hash(), 'same screen at the snapshot');
  assert.equal(b.time, a.time, 'same clock');
  for (const l of [a, b]) { l.click(600, 216); l.run(3000); }
  assert.equal(b.screen().hash(), a.screen().hash(), 'same screen after continuing');
  assert.equal(b.registers().pc, a.registers().pc);
});

test('snapshot: garbage is rejected', async () => {
  await assert.rejects(Lisa.deserialize(new Uint8Array(100)));
});

test('disks: the emulator works on copies and export returns what the guest wrote', { skip: skipProfile || (romEnv ? false : 'needs LISA_TEST_ROM too') }, async () => {
  const original = readFileSync(profilePath);
  const before = new Uint8Array(original); // our own copy, to prove `original` is never touched
  const lisa = await Lisa.create();
  lisa.mountProfile(original);
  const h0 = lisa.diskHash(0);
  lisa.loadROM(loadRomEnv());
  lisa.powerOn({ boot: 'profile' });
  lisa.run(60000); lisa.click(590, 70); lisa.run(25000);
  assert.notEqual(lisa.diskHash(0), h0, 'the guest has written to its disk');
  const out = lisa.exportProfile();
  assert.equal(out.length, original.length);
  let changed = 0;
  for (let i = 0; i < out.length; i++) if (out[i] !== before[i]) changed++;
  assert.ok(changed > 0, 'exported image contains the guest writes');
  assert.deepEqual(new Uint8Array(original), before, 'the caller\'s bytes were not modified');
});

// ---- Serial buffering (no disk needed) -------------------------------------------------------------
// The SCC's own FIFOs hold 2 bytes, as on the real chip. The host API queues behind them so a long write
// is accepted whole and delivered as the guest consumes it. (No guest here reads the port, so the FIFO
// fills and the rest waits; an end-to-end serial exchange with a real guest program is still untested.)

test('serial: long writes are queued, not truncated to the 2-byte chip FIFO', async () => {
  const lisa = await Lisa.create();
  lisa.loadROM(syntheticROM());
  lisa.powerOn();
  lisa.serialAttach('a');
  assert.equal(lisa.serialWrite('a', new Uint8Array(1000)), 1000);
  assert.equal(lisa.serialBacklog('a'), 998, 'two bytes are in the chip, the rest wait');
  lisa.run(50);
  assert.equal(lisa.serialBacklog('a'), 998, 'nothing more moves until the guest reads');
  assert.equal(lisa.serialBacklog('b'), 0, 'ports are independent');
  assert.equal(lisa.serialRead('a').length, 0);
  assert.equal(lisa.serialWrite('b', new Uint8Array(70000)), 65536, 'a full queue reports how much it took');
});
