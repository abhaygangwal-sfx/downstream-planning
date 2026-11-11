#!/usr/bin/env node
/* Tiny static server for local testing: node scripts/dev-server.mjs [port]
   Serves ./public (or the folder named as the 2nd argument, e.g. offline) with the same security headers as production. */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', process.argv[3] || 'public');
const port = Number(process.argv[2] || process.env.PORT || 5173);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
const headers = {};
try {
  const txt = await readFile(join(root, '_headers'), 'utf8');
  for (const line of txt.split(/\r?\n/)) { const m = line.match(/^\s+([A-Za-z-]+):\s*(.+)$/); if (m) headers[m[1]] = m[2]; }
} catch { /* no headers file */ }

createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = normalize(join(root, p));
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  try {
    if (!(await stat(file)).isFile()) throw new Error();
    const body = await readFile(file);
    res.writeHead(200, { ...headers, 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); }
}).listen(port, () => console.log('Serving ./public on http://localhost:' + port));
