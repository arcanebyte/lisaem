#!/usr/bin/env node
// Zero-dependency static server for the web UI (loopback only).
//
//   node serve.mjs [--port 8080] [--media <dir>] [--no-rom-fetch] [--rom-source <url>]
//
// --media exposes the files directly inside <dir> to the page as /media/<name>, with a
// listing at /media/index.json, so the UI can offer your local disk images without
// uploading. Nothing outside web/ and that one directory is ever served.
//
// Boot ROMs: the page offers to download a boot ROM, and this server does the downloading for it, because
// bitsavers sends no CORS headers, so a browser page cannot fetch the files itself. Only the exact files
// listed in site/roms.json can be requested (it is not an open proxy), each is checked against a pinned
// SHA-256 before it is served, and verified files are cached in web/.rom-cache so the source is contacted at
// most once per file. --no-rom-fetch serves only what is already cached (no network); --rom-source <url>
// uses a mirror instead of the catalog's source.
import { createServer } from 'node:http';
import { readFile, readdir, stat, mkdir, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, join, normalize, resolve, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const port = +opt('port', 8080);
const media = opt('media') ? resolve(opt('media')) : null;

// ---- boot ROM download (see the header comment) ----
const romCatalogPath = opt('rom-catalog', join(root, 'site', 'roms.json'));
const romCatalog = JSON.parse(await readFile(romCatalogPath, 'utf8'));
const romSource = opt('rom-source', romCatalog.source);
const romFetchAllowed = !args.includes('--no-rom-fetch');
const romCacheDir = opt('rom-cache', join(root, '.rom-cache'));
const ROM_BYTES = 8192;
// file name -> pinned sha256, for every file in the catalog and nothing else
const romFiles = new Map(romCatalog.roms.flatMap((r) => [r.lo, r.hi]).map((f) => [f.file, f.sha256]));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function romBytes(name) {
  const cached = join(romCacheDir, name);
  try {
    const b = await readFile(cached);
    if (b.length === ROM_BYTES && sha256(b) === romFiles.get(name)) return b;   // a bad cache entry is ignored, not trusted
  } catch { /* not cached */ }
  if (!romFetchAllowed) throw Object.assign(new Error('not cached, and downloading is disabled (--no-rom-fetch)'), { status: 404 });
  let res;
  try { res = await fetch(new URL(name, romSource), { signal: AbortSignal.timeout(20000), redirect: 'error' }); }
  catch (e) { throw Object.assign(new Error(`could not reach ${new URL(romSource).host}: ${e.cause?.code ?? e.message}`), { status: 502 }); }
  if (!res.ok) throw Object.assign(new Error(`${new URL(romSource).host} answered ${res.status} for ${name}`), { status: 502 });
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length !== ROM_BYTES) throw Object.assign(new Error(`${name} is ${buf.length} bytes, expected ${ROM_BYTES}`), { status: 502 });
  if (sha256(buf) !== romFiles.get(name)) throw Object.assign(new Error(`${name} does not match its pinned SHA-256; refusing to use it`), { status: 502 });
  await mkdir(romCacheDir, { recursive: true });
  await writeFile(cached + '.tmp', buf); await rename(cached + '.tmp', cached);   // atomic: never a half-written cache file
  return buf;
}

const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
const diskExt = /\.(dc42|dc|img|image|dsk|raw|dmg|twiggy|bin|rom|lo|hi)$/i; // disks and boot ROMs

const send = (res, code, body, type = 'text/plain; charset=utf-8') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = decodeURIComponent(url.pathname);
    if (path === '/') { res.writeHead(302, { Location: '/site/' }); return res.end(); }

    if (path === '/rom/index.json') {
      return send(res, 200, JSON.stringify({ default: romCatalog.default, source: romSource, fetchAllowed: romFetchAllowed, roms: romCatalog.roms }), types['.json']);
    }
    if (path.startsWith('/rom/')) {
      const name = path.slice('/rom/'.length);
      if (!romFiles.has(name)) return send(res, 404, 'not a catalogued ROM file');
      try { return send(res, 200, await romBytes(name), 'application/octet-stream'); }
      catch (e) { console.error(`ROM ${name}: ${e.message}`); return send(res, e.status ?? 502, e.message); }
    }

    if (path.startsWith('/media/')) {
      if (!media) return send(res, 404, 'no --media directory configured');
      if (path === '/media/index.json') {
        const names = (await readdir(media)).filter((n) => diskExt.test(n)).sort();
        const list = [];
        for (const n of names) list.push({ name: n, size: (await stat(join(media, n))).size });
        return send(res, 200, JSON.stringify(list), types['.json']);
      }
      const name = basename(path.slice('/media/'.length));
      if (!diskExt.test(name)) return send(res, 403, 'forbidden');
      return send(res, 200, await readFile(join(media, name)), 'application/octet-stream');
    }

    if (path.split('/').some((seg) => seg.startsWith('.'))) return send(res, 403, 'forbidden');   // dotfiles and dot-directories (.rom-cache, .git, ...)
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(root, path));
    if (file !== root.replace(/\/$/, '') && !file.startsWith(root)) return send(res, 403, 'forbidden');
    if (file.includes(sep + 'build' + sep) || file.includes(sep + 'node_modules' + sep)) return send(res, 403, 'forbidden');
    send(res, 200, await readFile(file), types[extname(file)] || 'application/octet-stream');
  } catch (e) {
    send(res, e.code === 'ENOENT' ? 404 : 500, e.code === 'ENOENT' ? 'not found' : String(e));
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`LisaEm web UI: http://127.0.0.1:${port}/` + (media ? `   (media: ${media})` : '') + (romFetchAllowed ? `   (ROM downloads: ${new URL(romSource).host})` : '   (ROM downloads off)'));
});
