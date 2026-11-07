#!/usr/bin/env node
// Builds the web UI as a plain static site, ready to copy onto any static host (GitHub Pages, ...).
//
//   node build-pages.mjs <out-dir> [--rom-dir <dir> --rom H] [--media-dir <dir>] [--base <url>]
//
// --rom-dir/--rom bundle one boot ROM (the pair listed in site/roms.json, checked against its pinned
// SHA-256) at rom/, with the catalog the page reads, so the page offers it and loads it by default.
// --media-dir bundles every disk image in the directory at media/, listed in the page's disk combo.
// --base is the absolute URL the site is served from (shown as the ROM source).
//
// The output is self-contained and uses only relative URLs, so it works from any sub-path
// (https://host/emu/lisaem/). No ROMs or disk images are included. The dev server's ROM download and
// media folder endpoints do not exist there; the page notices and hides them.
//
// The Emscripten glue is published as .js rather than .mjs, since not every static host serves .mjs as
// JavaScript, and a module with the wrong MIME type will not load.
import { mkdir, readFile, writeFile, copyFile, rm, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf('--' + n); return i < 0 ? undefined : argv[i + 1]; };
const out = resolve(argv[0] ?? '');
if (!argv[0] || argv[0].startsWith('--')) { console.error('usage: node build-pages.mjs <out-dir>'); process.exit(2); }

const site = ['index.html', 'app.js', 'display.js', 'store.js', 'audio-worklet.js', 'style.css',
  'icon.svg', 'icon-512.png', 'apple-touch-icon.png', 'manifest.webmanifest'];
const rewrite = (text, pairs) => pairs.reduce((t, [a, b]) => { if (!t.includes(a)) throw new Error(`expected ${a}`); return t.replaceAll(a, b); }, text);

await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'js'), { recursive: true });
await mkdir(join(out, 'dist'), { recursive: true });

for (const f of site) {
  // the page asks its own server for /media/ and /rom/: relative here, so the site can live at any sub-path
  if (f === 'app.js') await writeFile(join(out, f), rewrite(await readFile(join(root, 'site', f), 'utf8'), [["'../js/lisa.js'", "'./js/lisa.js'"], ["fetch('/media/", "fetch('media/"], ["fetch('/rom/", "fetch('rom/"]]));
  else await copyFile(join(root, 'site', f), join(out, f));
}
await writeFile(join(out, 'js/lisa.js'), rewrite(await readFile(join(root, 'js/lisa.js'), 'utf8'), [["'../dist/lisa-core.mjs'", "'../dist/lisa-core.js'"]]));
await writeFile(join(out, 'dist/lisa-core.js'), await readFile(join(root, 'dist/lisa-core.mjs')));
await copyFile(join(root, 'dist/lisa-core.wasm'), join(out, 'dist/lisa-core.wasm'));

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
if (opt('rom-dir')) {
  const catalog = JSON.parse(await readFile(join(root, 'site/roms.json'), 'utf8'));
  const id = opt('rom') ?? catalog.default, r = catalog.roms.find((x) => x.id === id);
  if (!r) throw new Error(`no ROM ${id} in roms.json`);
  await mkdir(join(out, 'rom'), { recursive: true });
  for (const f of [r.lo, r.hi]) {
    const bytes = await readFile(join(resolve(opt('rom-dir')), f.file));
    if (bytes.length !== 8192 || sha256(bytes) !== f.sha256) throw new Error(`${f.file} does not match its pinned SHA-256`);
    await writeFile(join(out, 'rom', f.file), bytes);
  }
  const base = opt('base') ?? 'http://localhost/';
  await writeFile(join(out, 'rom/index.json'), JSON.stringify({ default: r.id, source: new URL('rom/', base).href, fetchAllowed: true, roms: [r] }, null, 2) + '\n');
  console.log(`bundled boot ROM ${r.label}`);
}
if (opt('media-dir')) {
  const dir = resolve(opt('media-dir')), list = [];
  await mkdir(join(out, 'media'), { recursive: true });
  for (const n of (await readdir(dir)).filter((x) => /\.(dc42|dc|img|image|dsk|raw|dmg)$/i.test(x)).sort()) {
    await copyFile(join(dir, n), join(out, 'media', n));
    list.push({ name: n, size: (await stat(join(dir, n))).size });
  }
  await writeFile(join(out, 'media/index.json'), JSON.stringify(list, null, 2) + '\n');
  console.log(`bundled disks: ${list.map((d) => d.name).join(', ')}`);
}
console.log(`static site written to ${out}`);
