// Recorded voice lines live as ordinary .wav files in characters/<id>/voice/, so they travel with the
// folder. File name = <label>-<hash>.wav; the hash identifies the exact text + voice settings, so an
// edited line gets a new recording while the label keeps the folder easy to browse.

// FNV-1a 32-bit: short, stable id for a line's text + voice settings.
export function lineHash(key) {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

// 16-bit mono PCM WAV.
export function encodeWav(audio, sr) {
  const n = audio.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, audio[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  return new Uint8Array(buf);
}

// Reads 16-bit PCM WAVs (what we write, and what most editors export). Mono, or stereo mixed down.
export function decodeWav(arrayBuffer) {
  const v = new DataView(arrayBuffer);
  if (v.getUint32(0, false) !== 0x52494646 || v.getUint32(8, false) !== 0x57415645) throw new Error('not a WAV file');
  let off = 12, sr = 24000, ch = 1, bits = 16, data = null;
  while (off + 8 <= v.byteLength) {
    const id = v.getUint32(off, false), size = v.getUint32(off + 4, true);
    if (id === 0x666d7420) { ch = v.getUint16(off + 10, true); sr = v.getUint32(off + 12, true); bits = v.getUint16(off + 22, true); }
    if (id === 0x64617461) { data = [off + 8, Math.min(size, v.byteLength - off - 8)]; break; }
    off += 8 + size + (size & 1);
  }
  if (!data || bits !== 16) throw new Error('WAV must be 16-bit PCM');
  const frames = Math.floor(data[1] / (2 * ch)), audio = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < ch; c++) s += v.getInt16(data[0] + (i * ch + c) * 2, true);
    audio[i] = s / ch / 0x8000;
  }
  return { audio, sr };
}

const voiceDir = (charId) => `${location.origin}/characters/${encodeURIComponent(charId)}/voice/`;

// hash -> file name for the recordings already in the folder.
export async function listRecordings(charId, tries = 2) {
  try {
    const r = await fetch(voiceDir(charId), { cache: 'no-store' });
    if (r.status === 404) return new Map(); // no voice folder yet
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    let files;
    try { files = JSON.parse(text).files || []; } catch { files = [...text.matchAll(/href="([^"?#/]+\.wav)"/gi)].map((m) => decodeURIComponent(m[1])); }
    const map = new Map();
    for (const f of files) { const m = f.match(/-([0-9a-f]{8})\.wav$/i); if (m) map.set(m[1].toLowerCase(), f); }
    return map;
  } catch { return tries > 1 ? listRecordings(charId, tries - 1) : new Map(); }
}

export async function loadRecording(charId, file) {
  const r = await fetch(voiceDir(charId) + encodeURIComponent(file), { cache: 'no-store' });
  if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`);
  return decodeWav(await r.arrayBuffer());
}

// Needs Start Roleplay Room.bat's server (it accepts saves into characters/<id>/voice/ only).
export async function saveRecording(charId, label, hash, clip) {
  const name = `${label.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase()}-${hash}.wav`;
  const r = await fetch(voiceDir(charId) + encodeURIComponent(name), { method: 'PUT', body: encodeWav(clip.audio, clip.sr), headers: { 'Content-Type': 'audio/wav' } });
  if (!r.ok) throw new Error(`couldn't save ${name} (HTTP ${r.status}); start the app with Start Roleplay Room.bat`);
  return name;
}

export async function deleteRecordings(charId) {
  const files = [...(await listRecordings(charId)).values()];
  let n = 0;
  for (const f of files) { const r = await fetch(voiceDir(charId) + encodeURIComponent(f), { method: 'DELETE' }); if (r.ok) n++; }
  return n;
}
