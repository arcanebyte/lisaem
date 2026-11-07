#!/usr/bin/env node
// Builds the web UI as a plain static site, ready to copy onto any static host (GitHub Pages, ...).
//
//   node build-pages.mjs <out-dir>
//
// The output is self-contained and uses only relative URLs, so it works from any sub-path
// (https://host/emu/lisaem/). No ROMs or disk images are included. The dev server's ROM download and
// media folder endpoints do not exist there; the page notices and hides them.
//
// The Emscripten glue is published as .js rather than .mjs, since not every static host serves .mjs as
// JavaScript, and a module with the wrong MIME type will not load.
import { mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const out = resolve(process.argv[2] ?? '');
if (!process.argv[2]) { console.error('usage: node build-pages.mjs <out-dir>'); process.exit(2); }

const site = ['index.html', 'app.js', 'display.js', 'store.js', 'audio-worklet.js', 'style.css',
  'icon.svg', 'icon-512.png', 'apple-touch-icon.png', 'manifest.webmanifest'];
const rewrite = (text, pairs) => pairs.reduce((t, [a, b]) => { if (!t.includes(a)) throw new Error(`expected ${a}`); return t.replaceAll(a, b); }, text);

await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'js'), { recursive: true });
await mkdir(join(out, 'dist'), { recursive: true });

for (const f of site) {
  if (f === 'app.js') await writeFile(join(out, f), rewrite(await readFile(join(root, 'site', f), 'utf8'), [["'../js/lisa.js'", "'./js/lisa.js'"]]));
  else await copyFile(join(root, 'site', f), join(out, f));
}
await writeFile(join(out, 'js/lisa.js'), rewrite(await readFile(join(root, 'js/lisa.js'), 'utf8'), [["'../dist/lisa-core.mjs'", "'../dist/lisa-core.js'"]]));
await writeFile(join(out, 'dist/lisa-core.js'), await readFile(join(root, 'dist/lisa-core.mjs')));
await copyFile(join(root, 'dist/lisa-core.wasm'), join(out, 'dist/lisa-core.wasm'));
console.log(`static site written to ${out}`);
