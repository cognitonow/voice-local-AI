// Knowledge base: chunks + embeddings kept in this browser (IndexedDB).
const DB = 'roleplay-room', STORE = 'chunks';
const CHUNK = 900, OVERLAP = 150;
let cache = null;

let dbPromise = null; // one connection for the session (opening one per call is slow)
function open() {
  if (dbPromise) return dbPromise;
  return (dbPromise = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    r.onsuccess = () => res(r.result);
    r.onerror = () => { dbPromise = null; rej(r.error); };
  }));
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => res(req && 'result' in req ? req.result : undefined);
    t.onerror = () => rej(t.error);
  });
}

export async function all() {
  if (!cache) {
    try { cache = (await tx('readonly', (s) => s.getAll())) || []; } catch { cache = []; }
  }
  return cache;
}

export async function sources() {
  const map = new Map();
  for (const c of await all()) map.set(c.source, (map.get(c.source) || 0) + 1);
  return [...map].map(([name, chunks]) => ({ name, chunks }));
}

export async function clear() {
  await tx('readwrite', (s) => s.clear());
  cache = [];
}

export async function addFile(file, embedFn, onProgress = () => {}) {
  const text = await readFile(file);
  const parts = chunk(text);
  if (!parts.length) throw new Error(`No readable text in ${file.name}`);
  const records = [];
  for (let i = 0; i < parts.length; i += 16) {
    const batch = parts.slice(i, i + 16);
    const vecs = await embedFn(batch);
    batch.forEach((t, j) => records.push({ source: file.name, text: t, vec: Float32Array.from(vecs[j]) }));
    onProgress(Math.min(1, (i + batch.length) / parts.length));
  }
  await tx('readwrite', (s) => {
    for (const r of records) s.add(r);
    return null;
  });
  cache = null;
  return records.length;
}

// Chunk and embed text held in memory (a character's ## Knowledge and characters/<id>/ files).
export async function embedTexts(items, embedFn) {
  const parts = [];
  for (const it of items) for (const t of chunk(it.text || '')) parts.push({ source: it.source, text: t });
  for (let i = 0; i < parts.length; i += 16) {
    const batch = parts.slice(i, i + 16);
    const vecs = await embedFn(batch.map((p) => p.text));
    batch.forEach((p, j) => { p.vec = Float32Array.from(vecs[j]); });
  }
  return parts;
}

export async function search(query, embedFn, k = 4, minScore = 0.3, extra = []) {
  const chunks = [...(await all()), ...extra];
  if (!chunks.length || !query.trim()) return [];
  const [q] = await embedFn([query]);
  const scored = chunks.map((c) => {
    let s = 0;
    for (let i = 0; i < q.length; i++) s += q[i] * c.vec[i];
    return [s, c];
  });
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, k).filter(([s]) => s >= minScore).map(([score, c]) => ({ ...c, score }));
}

async function readFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf')) {
    const pdfjs = await import('./vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
    const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const content = await (await doc.getPage(p)).getTextContent();
      pages.push(content.items.map((i) => i.str + (i.hasEOL ? '\n' : ' ')).join(''));
    }
    return pages.join('\n\n');
  }
  return file.text();
}

function chunk(text) {
  const paras = text.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const out = [];
  let cur = '';
  for (let para of paras) {
    if (cur.length + para.length + 1 <= CHUNK) { cur = `${cur} ${para}`.trim(); continue; }
    if (cur) out.push(cur);
    while (para.length > CHUNK) { out.push(para.slice(0, CHUNK)); para = para.slice(CHUNK - OVERLAP); }
    cur = out.length ? `${out[out.length - 1].slice(-OVERLAP)} ${para}`.trim() : para;
  }
  if (cur) out.push(cur);
  return out;
}
