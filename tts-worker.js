// Kokoro voice, off the main thread.
// vendor/kokoro.web.js is kokoro-js 1.2.1, patched to load from this folder's models/ and vendor/.
import { KokoroTTS } from './vendor/kokoro.web.js';

let tts;
let queue = Promise.resolve();
const post = (m, t) => self.postMessage(m, t || []);

async function handle(d) {
  if (d.type === 'load') {
    tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
      dtype: d.cpu ? 'q8' : 'fp32',
      device: d.cpu ? 'wasm' : 'webgpu',
      progress_callback: (p) => { if (p.status === 'progress') post({ type: 'progress', what: 'voice', file: p.file, loaded: p.loaded, total: p.total }); },
    });
    await tts.generate('Hi.', { voice: d.voice });
    return {};
  }
  if (d.type === 'synth') {
    const t0 = performance.now();
    const a = await tts.generate(d.text, { voice: d.voice, speed: d.speed });
    const ms = performance.now() - t0;
    const audio = a.audio instanceof Float32Array ? a.audio : new Float32Array(a.audio);
    return { audio, sr: a.sampling_rate, ms, _transfer: [audio.buffer] };
  }
  throw new Error(`Unknown job ${d.type}`);
}

self.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    try {
      const r = await handle(data);
      const t = r._transfer; delete r._transfer;
      post({ id: data.id, ok: true, ...r }, t);
    } catch (e) { post({ id: data.id, ok: false, error: String(e?.message || e), stack: String(e?.stack || '').slice(0, 1500) }); }
  });
};
