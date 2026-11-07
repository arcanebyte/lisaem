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
