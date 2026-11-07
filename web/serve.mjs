#!/usr/bin/env node
// Zero-dependency static server for the web UI (loopback only).
//
//   node serve.mjs [--port 8080] [--media <dir>]
//
// --media exposes the files directly inside <dir> to the page as /media/<name>, with a
// listing at /media/index.json, so the UI can offer your local disk images without
// uploading. Nothing outside web/ and that one directory is ever served.
import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const port = +opt('port', 8080);
const media = opt('media') ? resolve(opt('media')) : null;

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

    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(root, path));
    if (file !== root.replace(/\/$/, '') && !file.startsWith(root)) return send(res, 403, 'forbidden');
    if (file.includes(sep + 'build' + sep) || file.includes(sep + 'node_modules' + sep)) return send(res, 403, 'forbidden');
    send(res, 200, await readFile(file), types[extname(file)] || 'application/octet-stream');
  } catch (e) {
    send(res, e.code === 'ENOENT' ? 404 : 500, e.code === 'ENOENT' ? 'not found' : String(e));
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`LisaEm web UI: http://127.0.0.1:${port}/` + (media ? `   (media: ${media})` : ''));
});
