// Tests for the ROM download endpoint of serve.mjs. A mock "bitsavers" serves synthetic 8 KB files, so
// nothing here touches the network or needs a real ROM. LISA_TEST_ONLINE=1 adds one test that checks the
// catalog's pinned hashes against the real site.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const server = fileURLToPath(new URL('../serve.mjs', import.meta.url));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const freePort = () => new Promise((res) => { const s = netServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

// two synthetic "ROM" files and their hashes
const GOOD_LO = Buffer.alloc(8192, 0x11), GOOD_HI = Buffer.alloc(8192, 0x22);
const catalog = (source) => ({
  source, default: 'T',
  roms: [{ id: 'T', label: 'Test ROM', status: 'verified', note: 'synthetic',
    lo: { file: 'TEST-LO.BIN', sha256: sha(GOOD_LO) }, hi: { file: 'TEST-HI.BIN', sha256: sha(GOOD_HI) } }],
});

/** A mock upstream. `files` maps name -> Buffer or a function (req,res) for special behaviour. */
async function mock(files) {
  const hits = [];
  const srv = createServer((req, res) => {
    const name = decodeURIComponent(req.url.slice(1));
    hits.push(name);
    const f = files[name];
    if (typeof f === 'function') return f(req, res);
    if (!f) { res.writeHead(404); return res.end('nope'); }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(f);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}/`, hits, close: () => new Promise((r) => srv.close(r)) };
}

const running = [];
async function start(extra = [], { source, cache } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lisa-serve-'));
  const cat = join(dir, 'roms.json');
  writeFileSync(cat, JSON.stringify(catalog(source ?? 'http://127.0.0.1:1/')));
  const cacheDir = cache ?? join(dir, 'cache');
  const port = await freePort();
  const child = spawn(process.execPath, [server, '--port', String(port), '--rom-catalog', cat, '--rom-cache', cacheDir, ...extra], { stdio: ['ignore', 'ignore', 'ignore'] });
  running.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) { try { await fetch(base + '/rom/index.json'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  return { base, cacheDir, get: (p) => fetch(base + p), close: () => child.kill() };
}
after(() => running.forEach((c) => c.kill()));

test('catalog: /rom/index.json describes what can be fetched', async () => {
  const s = await start();
  const j = await (await s.get('/rom/index.json')).json();
  assert.equal(j.default, 'T');
  assert.equal(j.fetchAllowed, true);
  assert.equal(j.roms[0].lo.file, 'TEST-LO.BIN');
});

test('a catalogued file is fetched, verified, served and cached (the source is asked once)', async () => {
  const up = await mock({ 'TEST-LO.BIN': GOOD_LO, 'TEST-HI.BIN': GOOD_HI });
  const s = await start([], { source: up.url });
  try {
    for (let i = 0; i < 3; i++) {
      const r = await s.get('/rom/TEST-LO.BIN');
      assert.equal(r.status, 200);
      assert.deepEqual(Buffer.from(await r.arrayBuffer()), GOOD_LO);
    }
    assert.equal(up.hits.filter((h) => h === 'TEST-LO.BIN').length, 1, 'later requests come from the cache');
    assert.deepEqual(readFileSync(join(s.cacheDir, 'TEST-LO.BIN')), GOOD_LO);
  } finally { await up.close(); s.close(); }
});

test('only catalogued names are served, and the source is never asked about anything else', async () => {
  const up = await mock({ 'TEST-LO.BIN': GOOD_LO, 'secret.txt': Buffer.from('x'), 'other.BIN': GOOD_LO });
  const s = await start([], { source: up.url });
  try {
    for (const p of ['/rom/other.BIN', '/rom/secret.txt', '/rom/', '/rom/..%2f..%2fetc%2fpasswd', '/rom/TEST-LO.BIN%2f..%2fother.BIN', '/rom/test-lo.bin', '/rom/TEST-LO.BIN.tmp'])
      assert.equal((await s.get(p)).status, 404, p);
    assert.deepEqual(up.hits, [], 'nothing was requested upstream');
  } finally { await up.close(); s.close(); }
});

test('dotfiles and the cache directory are not served by the static file server', async () => {
  const s = await start();
  try {
    for (const p of ['/.rom-cache/anything', '/.gitignore', '/.git/config', '/site/.hidden'])
      assert.equal((await s.get(p)).status, 403, p);
    assert.equal((await s.get('/site/index.html')).status, 200, 'normal files still work');
  } finally { s.close(); }
});

test('a file that does not match its pinned hash is refused and not cached', async () => {
  const bad = Buffer.alloc(8192, 0x99);
  const up = await mock({ 'TEST-LO.BIN': bad });
  const s = await start([], { source: up.url });
  try {
    const r = await s.get('/rom/TEST-LO.BIN');
    assert.equal(r.status, 502);
    assert.match(await r.text(), /pinned SHA-256/);
    assert.ok(!existsSync(join(s.cacheDir, 'TEST-LO.BIN')));
  } finally { await up.close(); s.close(); }
});

test('wrong size, upstream errors, redirects and an unreachable source all fail cleanly (502)', async () => {
  const up = await mock({
    'TEST-LO.BIN': Buffer.alloc(100),
    'TEST-HI.BIN': (req, res) => { res.writeHead(302, { Location: 'http://127.0.0.1:1/evil' }); res.end(); },
  });
  const s = await start([], { source: up.url });
  try {
    assert.equal((await s.get('/rom/TEST-LO.BIN')).status, 502);
    assert.equal((await s.get('/rom/TEST-HI.BIN')).status, 502, 'a redirect is not followed');
  } finally { await up.close(); s.close(); }
  const dead = await start([], { source: 'http://127.0.0.1:1/' });
  try { assert.equal((await dead.get('/rom/TEST-LO.BIN')).status, 502); } finally { dead.close(); }
});

test('cached files are served when the source is gone; a tampered cache entry is not trusted', async () => {
  const up = await mock({ 'TEST-LO.BIN': GOOD_LO });
  const first = await start([], { source: up.url });
  await first.get('/rom/TEST-LO.BIN');
  first.close(); await up.close();
  const offline = await start([], { source: 'http://127.0.0.1:1/', cache: first.cacheDir });
  try {
    assert.equal((await offline.get('/rom/TEST-LO.BIN')).status, 200, 'served from the cache with the source down');
    writeFileSync(join(first.cacheDir, 'TEST-LO.BIN'), Buffer.alloc(8192, 0x77));   // corrupt the cache
    assert.equal((await offline.get('/rom/TEST-LO.BIN')).status, 502, 'the corrupt entry is ignored and the unreachable source is reported');
  } finally { offline.close(); }
});

test('--no-rom-fetch: serves what is cached, never touches the network', async () => {
  const up = await mock({ 'TEST-LO.BIN': GOOD_LO, 'TEST-HI.BIN': GOOD_HI });
  const warm = await start([], { source: up.url });
  await warm.get('/rom/TEST-LO.BIN');
  warm.close();
  const hitsBefore = up.hits.length;
  const s = await start(['--no-rom-fetch'], { source: up.url, cache: warm.cacheDir });
  try {
    assert.equal((await (await s.get('/rom/index.json')).json()).fetchAllowed, false);
    assert.equal((await s.get('/rom/TEST-LO.BIN')).status, 200, 'cached');
    assert.equal((await s.get('/rom/TEST-HI.BIN')).status, 404, 'not cached, and no download allowed');
    assert.equal(up.hits.length, hitsBefore, 'the source was not contacted');
  } finally { await up.close(); s.close(); }
});

test('the real catalog pins hashes for every file, and only 8 KB ROM pairs', () => {
  const cat = JSON.parse(readFileSync(fileURLToPath(new URL('../site/roms.json', import.meta.url)), 'utf8'));
  assert.match(cat.source, /^https:\/\//);
  assert.ok(cat.roms.some((r) => r.id === cat.default));
  for (const r of cat.roms) for (const f of [r.lo, r.hi]) {
    assert.match(f.file, /^[A-Za-z0-9._-]+$/, 'a plain file name');
    assert.match(f.sha256, /^[0-9a-f]{64}$/);
  }
});

test('ONLINE: the pinned hashes match what the real source serves', { skip: process.env.LISA_TEST_ONLINE ? false : 'set LISA_TEST_ONLINE=1 to contact the real source' }, async () => {
  const cat = JSON.parse(readFileSync(fileURLToPath(new URL('../site/roms.json', import.meta.url)), 'utf8'));
  for (const r of cat.roms) for (const f of [r.lo, r.hi]) {
    const b = Buffer.from(await (await fetch(new URL(f.file, cat.source))).arrayBuffer());
    assert.equal(sha(b), f.sha256, f.file);
  }
});
