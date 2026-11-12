// Roleplay Room web server for Node (no dependencies): the same job as serve.ps1, for hosts and
// online editors that run `npm start`. Serves the folder with the headers the app needs, lists the
// characters folder, and lets the app create new characters and save recorded lines.
//   npm start            -> http://localhost:8080 (or the PORT the host provides)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const charRoot = path.join(root, 'characters');
const port = Number(process.env.PORT) || 8080;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream',
  '.bin': 'application/octet-stream', '.vrm': 'model/gltf-binary', '.glb': 'model/gltf-binary',
  '.wav': 'audio/wav', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.pdf': 'application/pdf',
};
// Cross-origin isolation (multi-threading in the browser) + no stale files while editing.
const BASE = { 'Cache-Control': 'no-cache', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' };

const inside = (full, dir) => full === dir || full.startsWith(dir + path.sep);
const send = (res, status, body = '', headers = {}) => { res.writeHead(status, { ...BASE, ...headers }); res.end(body); };

http.createServer((req, res) => {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, ''); } catch { return send(res, 400); }
  if (rel === '') rel = 'index.html';
  const full = path.resolve(root, rel);
  if (!inside(full, root)) return send(res, 403);

  // Writes: a recorded line (characters/<id>/voice/<name>.wav) or a NEW character file (never overwritten).
  if (req.method === 'PUT' || req.method === 'DELETE') {
    const voice = /^characters\/[A-Za-z0-9_-]+\/voice\/[A-Za-z0-9_.-]+\.wav$/.test(rel) && inside(full, charRoot);
    const newChar = req.method === 'PUT' && /^characters\/[a-z0-9][a-z0-9_-]{0,40}\/character\.md$/.test(rel) && inside(full, charRoot);
    if (!voice && !newChar) return send(res, 403);
    if (req.method === 'DELETE') { if (!fs.existsSync(full)) return send(res, 404); fs.unlinkSync(full); return send(res, 200); }
    if (newChar && fs.existsSync(full)) return send(res, 409);
    const limit = newChar ? 1 << 20 : 50 << 20, chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { send(res, 413); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (res.writableEnded) return;
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full + '.part', Buffer.concat(chunks)); fs.renameSync(full + '.part', full);
      send(res, newChar ? 201 : 200);
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405);

  let st; try { st = fs.statSync(full); } catch { return send(res, 404); }
  // Folder listings (as JSON) only inside characters/, which is how the app finds characters and recordings.
  if (st.isDirectory()) {
    if (!inside(full, charRoot)) return send(res, 404);
    const items = fs.readdirSync(full, { withFileTypes: true });
    const body = JSON.stringify({ files: items.filter((d) => d.isFile()).map((d) => d.name), dirs: items.filter((d) => d.isDirectory()).map((d) => d.name) });
    return send(res, 200, req.method === 'HEAD' ? '' : body, { 'Content-Type': 'application/json; charset=utf-8' });
  }
  const headers = { 'Content-Type': TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size };
  if (req.method === 'HEAD') return send(res, 200, '', headers);
  res.writeHead(200, { ...BASE, ...headers });
  fs.createReadStream(full).pipe(res);
}).listen(port, '0.0.0.0', () => console.log(`Roleplay Room: http://localhost:${port}  (Ctrl+C to stop)`));
