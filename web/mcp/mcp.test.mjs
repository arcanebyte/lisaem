// Tests for the MCP server, run over real JSON-RPC against a real server process. The protocol and
// file-safety tests need nothing; the session tests need LISA_TEST_FLOPPY (Office System 3.0 install disk 1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, copyFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { startServer, textOf } from './client.mjs';

const floppy = process.env.LISA_TEST_FLOPPY;
const skipDisk = floppy ? false : 'set LISA_TEST_FLOPPY to run';

test('protocol: initialize, tools/list, ping, unknown method, bad JSON', async () => {
  const s = startServer();
  try {
    const init = await s.init();
    assert.equal(init.serverInfo.name, 'lisaem-web');
    assert.ok(init.capabilities.tools);
    const { result } = await s.rpc('tools/list');
    const names = result.tools.map((t) => t.name);
    for (const n of ['lisa_start', 'lisa_run', 'lisa_screenshot', 'lisa_click', 'lisa_type', 'lisa_snapshot', 'lisa_restore'])
      assert.ok(names.includes(n), n);
    for (const t of result.tools) assert.equal(t.inputSchema.type, 'object', t.name);
    assert.deepEqual((await s.rpc('ping')).result, {});
    assert.equal((await s.rpc('no/such')).error.code, -32601);
    s.raw('{ not json');
    await s.rpc('ping'); // the server is still alive and answering
  } finally { s.close(); }
});

test('tools report failures as results, not protocol errors', async () => {
  const s = startServer();
  try {
    await s.init();
    const r = await s.call('lisa_click', { x: 1, y: 1 });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /lisa_start/);
    assert.equal((await s.call('lisa_start', {})).isError, true);
  } finally { s.close(); }
});

test('files: only --media is readable and only --out is writable', async () => {
  const media = mkdtempSync(join(tmpdir(), 'lisa-media-')), out = mkdtempSync(join(tmpdir(), 'lisa-out-'));
  mkdirSync(join(media, 'sub'));
  writeFileSync(join(media, 'x.dc42'), new Uint8Array(1000));
  const s = startServer(['--media', media, '--out', out]);
  try {
    await s.init();
    assert.match(textOf(await s.call('lisa_list_media')), /x\.dc42/);
    for (const bad of ['../../../../etc/passwd', '/etc/passwd', 'sub/../../outside'])
      assert.equal((await s.call('lisa_start', { floppy: bad })).isError, true, bad);
  } finally { s.close(); }
  const noOut = startServer(['--media', media]);
  try {
    await noOut.init();
    const r = await noOut.call('lisa_snapshot_save_file', { file: 'a' });
    assert.equal(r.isError, true); // no machine either, but the point is it cannot write
  } finally { noOut.close(); }
});

test('session: boot, look, click, snapshot/restore, save and resume', { skip: skipDisk }, async () => {
  const media = dirname(floppy), name = basename(floppy);
  const out = mkdtempSync(join(tmpdir(), 'lisa-out-'));
  const s = startServer(['--media', media, '--out', out]);
  try {
    await s.init();
    assert.equal((await s.call('lisa_start', { floppy: name })).isError, undefined);
    await s.call('lisa_run', { ms: 15000 });

    const shot = await s.call('lisa_screenshot', {});
    const img = shot.content.find((c) => c.type === 'image');
    assert.equal(img.mimeType, 'image/png');
    assert.deepEqual([...Buffer.from(img.data, 'base64').subarray(1, 4)], [0x50, 0x4e, 0x47]);
    const before = Buffer.from(img.data, 'base64').toString('base64');

    await s.call('lisa_snapshot', { name: 'installer' });
    await s.call('lisa_click', { x: 600, y: 216 });
    await s.call('lisa_run', { ms: 3000 });
    const after = (await s.call('lisa_screenshot', {})).content.find((c) => c.type === 'image').data;
    assert.notEqual(after, before, 'clicking Install changed the screen');

    await s.call('lisa_restore', { name: 'installer' });
    const restored = (await s.call('lisa_screenshot', {})).content.find((c) => c.type === 'image').data;
    assert.equal(restored, before, 'restore brought the screen back exactly');

    // save to a file, replace the machine, resume from the file
    const saved = textOf(await s.call('lisa_snapshot_save_file', { file: 'installer' }));
    assert.match(saved, /installer\.lsnp/);
    assert.ok(existsSync(join(out, 'installer.lsnp')));
    await s.call('lisa_start', { floppy: name });                       // a different (fresh, un-run) machine
    await s.call('lisa_snapshot_load_file', { file: 'installer.lsnp' });
    const resumed = (await s.call('lisa_screenshot', {})).content.find((c) => c.type === 'image').data;
    assert.equal(resumed, before, 'a machine resumed from a file looks exactly like the one saved');

    // output names cannot escape --out
    const traversal = await s.call('lisa_snapshot_save_file', { file: '../../escape' });
    assert.ok(existsSync(join(out, 'escape.lsnp')) || traversal.isError);
    assert.ok(!existsSync(join(out, '..', '..', 'escape.lsnp')));
  } finally { s.close(); }
});

// ---- argument validation, protocol corners --------------------------------------------------------

test('arguments are validated with clear messages (no silent defaults, no stack traces)', async () => {
  const s = startServer();
  try {
    await s.init();
    const bad = async (name, args, re) => {
      const r = await s.call(name, args);
      assert.equal(r.isError, true, `${name} ${JSON.stringify(args)}`);
      assert.match(textOf(r), re, `${name} ${JSON.stringify(args)} -> ${textOf(r)}`);
    };
    await bad('lisa_run', {}, /missing required argument ms/);
    await bad('lisa_run', { ms: 'soon' }, /ms must be number, got string/);
    await bad('lisa_run', { ms: 0 }, /ms must be at least 1/);
    await bad('lisa_run', { ms: 1e9 }, /ms must be at most 600000/);
    await bad('lisa_run', { ms: 1000, speed: 2 }, /unknown argument speed \(valid: ms, screenshot\)/);
    await bad('lisa_key', { keys: 'RETURN' }, /keys must be array/);
    await bad('lisa_key', { keys: [] }, /at least 1 item/);
    await bad('lisa_key', { keys: [7] }, /keys\[0\] must be string/);
    await bad('lisa_click', { x: 10 }, /missing required argument y/);
    await bad('lisa_click', { x: -5, y: 10 }, /x must be at least 0/);
    await bad('lisa_mouse', { x: 1, y: 1, action: 'wiggle' }, /action must be one of "move", "down", "up"/);
    await bad('lisa_drag', { from: { x: 1 }, to: { x: 2, y: 2 } }, /missing required argument from\.y/);
    await bad('lisa_read_memory', { address: 0, length: 5000 }, /length must be at most 4096/);
    await bad('lisa_screenshot', { crop: { x: 0, y: 0, w: 10 } }, /missing required argument crop\.h/);
    // a well-formed call still reaches the handler (and fails there only because no machine is running)
    await bad('lisa_run', { ms: 100 }, /lisa_start/);
  } finally { s.close(); }
});

test('protocol: JSON-RPC batches, notifications, invalid requests, tool-name errors', async () => {
  const s = startServer();
  try {
    await s.init();
    const out = await s.batch([
      { id: 101, method: 'ping' },
      { method: 'notifications/cancelled', params: { requestId: 1 } },   // a notification: no reply
      { id: 102, method: 'tools/list' },
      { id: 103, method: 'nope' },
    ]);
    assert.equal(out.length, 3);
    assert.deepEqual(out.find((m) => m.id === 101).result, {});
    assert.ok(out.find((m) => m.id === 102).result.tools.length >= 20);
    assert.equal(out.find((m) => m.id === 103).error.code, -32601);
    const unknown = await s.rpc('tools/call', { name: 'lisa_nope', arguments: {} });
    assert.equal(unknown.error.code, -32602);                           // protocol error for an unknown tool
    assert.equal((await s.rpc('initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion, '2025-06-18'); // falls back to one we speak
    const invalid = await s.batch([{ id: 5 }]);                         // no method
    assert.equal(invalid[0].error.code, -32600);
  } finally { s.close(); }
});

test('the server never prints anything but protocol messages on stdout', async () => {
  // startServer's reader JSON.parses every stdout line and would throw on stray output.
  const s = startServer();
  try { await s.init(); await s.call('lisa_list_media'); await s.call('lisa_status'); await s.rpc('tools/list'); }
  finally { s.close(); }
});

test('bad media does not take the server down', async () => {
  const media = mkdtempSync(join(tmpdir(), 'lisa-media-'));
  writeFileSync(join(media, 'junk.dc42'), new Uint8Array(500));             // not a disk image
  writeFileSync(join(media, 'junk.bin'), new Uint8Array(20000));            // not a ROM
  const s = startServer(['--media', media]);
  try {
    await s.init();
    const r1 = await s.call('lisa_start', { floppy: 'junk.dc42' });
    assert.equal(r1.isError, true);
    const r2 = await s.call('lisa_start', { floppy: 'junk.dc42', rom: ['junk.bin'] });
    assert.equal(r2.isError, true);
    assert.match(textOf(await s.call('lisa_status')), /No machine/);        // and it is still alive and consistent
  } finally { s.close(); }
});

// ---- every tool, against a real machine -----------------------------------------------------------

const pngSize = (b64) => { const b = Buffer.from(b64, 'base64'); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
const imageOf = (r) => r.content.find((c) => c.type === 'image')?.data;

test('tools: screenshots (size, scale, crop, ascii), registers, memory, status', { skip: skipDisk }, async () => {
  const s = startServer(['--media', dirname(floppy)]);
  try {
    await s.init();
    await s.call('lisa_start', { floppy: basename(floppy) });
    await s.call('lisa_run', { ms: 15000 });
    assert.deepEqual(pngSize(imageOf(await s.call('lisa_screenshot', {}))), [720, 500], 'default: aspect corrected');
    assert.deepEqual(pngSize(imageOf(await s.call('lisa_screenshot', { aspect_correct: false }))), [720, 364]);
    assert.deepEqual(pngSize(imageOf(await s.call('lisa_screenshot', { scale: 2, aspect_correct: false }))), [1440, 728]);
    assert.deepEqual(pngSize(imageOf(await s.call('lisa_screenshot', { crop: { x: 540, y: 50, w: 120, h: 50 } }))), [120, 50]);
    const ascii = await s.call('lisa_screenshot', { ascii: true });
    assert.ok(textOf(ascii).split('\n').length > 20, 'ascii rendering present');

    const regs = textOf(await s.call('lisa_registers'));
    assert.match(regs, /D0=[0-9a-f]{8}.*\nA0=[0-9a-f]{8}.*\nPC=0x[0-9a-f]+ SR=[0-9a-f]{4} context=1/);
    const mem = textOf(await s.call('lisa_read_memory', { address: 0x486, length: 32 }));
    assert.equal(mem.split('\n').length, 2, '32 bytes = two lines of 16');
    assert.match(mem, /^0x000486  ([0-9a-f]{2} ){15}[0-9a-f]{2}/);
    assert.match(textOf(await s.call('lisa_status')), /Office System.*\n.*started with.*\n.*pointer.*\n.*snapshots: none/);
  } finally { s.close(); }
});

test('tools: keyboard, mouse, drag, waits, snapshot bookkeeping', { skip: skipDisk }, async () => {
  const s = startServer(['--media', dirname(floppy)]);
  try {
    await s.init();
    await s.call('lisa_start', { floppy: basename(floppy), serial: ['a', 'b'] });
    await s.call('lisa_run', { ms: 15000 });

    assert.match(textOf(await s.call('lisa_type', { text: 'hello\n' })), /typed 6 of 6 characters/);
    assert.equal((await s.call('lisa_key', { keys: ['SHIFT', 'A'] })).isError, undefined, 'a chord');
    assert.equal((await s.call('lisa_key', { keys: ['command', 'S'] })).isError, undefined, 'names are case-insensitive');
    assert.match(textOf(await s.call('lisa_key', { keys: ['NOPE'] })), /unknown key/);

    const mv = await s.call('lisa_mouse', { x: 300, y: 200, action: 'move' });
    assert.match(textOf(mv), /mouse move at 300,200/);
    const [, px, py] = textOf(await s.call('lisa_status')).match(/pointer: (\d+),(\d+)/).map(Number);
    assert.ok(Math.abs(px - 300) <= 3 && Math.abs(py - 200) <= 3, `the guest pointer followed (${px},${py})`);

    const none = textOf(await s.call('lisa_wait_for_change', { timeout_ms: 500 }));
    assert.match(none, /no change within 500 ms/);
    await s.call('lisa_click', { x: 600, y: 216 });                         // Install
    const stable = textOf(await s.call('lisa_wait_for_stable', { quiet_ms: 1000, timeout_ms: 30000 }));
    assert.match(stable, /stable after/);

    // serial: the ports were connected; the guest has said nothing
    assert.match(textOf(await s.call('lisa_serial_write', { port: 'a', text: 'hi' })), /2 of 2 bytes/);
    assert.match(textOf(await s.call('lisa_serial_write', { port: 'b', hex: '1b5b41' })), /3 of 3 bytes/);
    assert.match(textOf(await s.call('lisa_serial_write', { port: 'a', text: 'x'.repeat(1000) })), /1000 of 1000 bytes/, 'long writes are queued whole');
    assert.match(textOf(await s.call('lisa_serial_read', { port: 'a' })), /nothing received/);

    // snapshot bookkeeping
    await s.call('lisa_snapshot', { name: 'one' });
    assert.match(textOf(await s.call('lisa_status')), /snapshots: one/);
    assert.match(textOf(await s.call('lisa_restore', { name: 'two' })), /no snapshot "two"; have: one/);
    assert.match(textOf(await s.call('lisa_snapshot_delete', { name: 'one' })), /deleted "one"/);
    assert.match(textOf(await s.call('lisa_status')), /snapshots: none/);
    assert.equal((await s.call('lisa_export_disk', { kind: 'profile', file: 'x' })).isError, true, 'no profile, and no --out');

    // starting again replaces the machine
    await s.call('lisa_start', { floppy: basename(floppy) });
    assert.match(textOf(await s.call('lisa_status')), /t=0\.00 s/);
  } finally { s.close(); }
});

test('tools: drag works and the result is deterministic across separate server processes', { skip: skipDisk }, async () => {
  const run = async () => {
    const s = startServer(['--media', dirname(floppy)]);
    try {
      await s.init();
      await s.call('lisa_start', { floppy: basename(floppy) });
      await s.call('lisa_run', { ms: 15000 });
      assert.match(textOf(await s.call('lisa_drag', { from: { x: 300, y: 100 }, to: { x: 340, y: 140 } })), /dragged/);
      await s.call('lisa_click', { x: 600, y: 216 });
      await s.call('lisa_run', { ms: 3000 });
      return imageOf(await s.call('lisa_screenshot', {}));
    } finally { s.close(); }
  };
  assert.equal(await run(), await run());
});

const profilePath = process.env.LISA_TEST_PROFILE, romEnv = process.env.LISA_TEST_ROM;
test('tools: ROM + ProFile session, and exporting the disk the guest wrote to', { skip: profilePath && romEnv ? false : 'set LISA_TEST_ROM and LISA_TEST_PROFILE' }, async () => {
  const rom = romEnv.split(',');
  const media = mkdtempSync(join(tmpdir(), 'lisa-media-')), out = mkdtempSync(join(tmpdir(), 'lisa-out-'));
  for (const f of [...rom, profilePath]) copyFileSync(f, join(media, basename(f)));
  const s = startServer(['--media', media, '--out', out]);
  try {
    await s.init();
    const start = await s.call('lisa_start', { rom: rom.map((f) => basename(f)), profile: basename(profilePath), boot: 'profile' });
    assert.match(textOf(start), /ROM 2\.H/);
    await s.call('lisa_run', { ms: 60000 });
    await s.call('lisa_click', { x: 590, y: 70 });                          // "Don't Check", if the image shows that prompt
    await s.call('lisa_run', { ms: 25000 });
    const exp = textOf(await s.call('lisa_export_disk', { kind: 'profile', file: '../../escape.img' }));
    const written = join(out, 'escape.img');                                // the name is confined to --out
    assert.ok(existsSync(written), exp);
    assert.ok(!existsSync(join(out, '..', '..', 'escape.img')));
    const orig = readFileSync(profilePath), got = readFileSync(written);
    assert.equal(got.length, orig.length);
    let diff = 0; for (let i = 0; i < orig.length; i++) if (orig[i] !== got[i]) diff++;
    assert.ok(diff > 0, 'the export contains what the guest wrote');
    assert.deepEqual(readFileSync(join(media, basename(profilePath))), orig, 'the media file itself is untouched');
  } finally { s.close(); }
});
