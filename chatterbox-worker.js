// Chatterbox (Resemble AI): expressive voice with an "exaggeration" control, off the main thread.
// Uses Transformers.js v4 from vendor/transformers4 and the model from models/onnx-community/chatterbox-ONNX.
import { ChatterboxModel, AutoProcessor, Tensor, env } from './vendor/transformers4/transformers-v4.min.js';

env.allowLocalModels = false;
env.remoteHost = `${self.location.origin}/models/`;
env.backends.onnx.wasm.wasmPaths = `${self.location.origin}/vendor/transformers4/`;

const MODEL_ID = 'onnx-community/chatterbox-ONNX';
// Only the language model has quantised variants; the other parts are fp32.
const DTYPE = { embed_tokens: 'fp32', speech_encoder: 'fp32', language_model: 'q4f16', conditional_decoder: 'fp32' };

let model = null, processor = null;
const speakers = new Map();
let queue = Promise.resolve();
const post = (m, t) => self.postMessage(m, t || []);
const log = (step, info) => post({ type: 'log', step, info });

async function handle(d) {
  if (d.type === 'load') {
    const base = `${self.location.origin}/models/${MODEL_ID}/resolve/main/`;
    for (const f of ['config.json', 'tokenizer.json', 'onnx/embed_tokens.onnx', 'onnx/speech_encoder.onnx', 'onnx/language_model_q4f16.onnx', 'onnx/conditional_decoder.onnx']) {
      try { const r = await fetch(base + f, { method: 'HEAD' }); log('cbx.file', { file: f, status: r.status }); if (r.status === 404 && f !== 'tokenizer.json') throw new Error(`Chatterbox file missing: ${f}. Run Download models.bat and answer Y to Chatterbox.`); }
      catch (e) { if (/missing/.test(e.message)) throw e; log('cbx.file', { file: f, error: String(e) }); }
    }
    processor = await AutoProcessor.from_pretrained(MODEL_ID);
    model = await ChatterboxModel.from_pretrained(MODEL_ID, {
      device: 'webgpu', dtype: DTYPE,
      progress_callback: (p) => { if (p.status === 'progress') post({ type: 'progress', what: 'cbx', file: p.file, loaded: p.loaded, total: p.total }); },
    });
    log('cbx.loaded', {});
    return {};
  }
  if (d.type === 'speaker') {
    // Reference voice: 24 kHz mono Float32. Encoded once and cached under its key.
    if (speakers.has(d.key)) return { cached: true };
    const t0 = performance.now();
    const audio = d.audio instanceof Float32Array ? d.audio : new Float32Array(d.audio);
    speakers.set(d.key, await model.encode_speech(new Tensor('float32', audio, [1, audio.length])));
    log('cbx.speaker', { key: d.key, seconds: +(audio.length / 24000).toFixed(1), ms: Math.round(performance.now() - t0) });
    return {};
  }
  if (d.type === 'synth') {
    const spk = speakers.get(d.speaker);
    if (!spk) throw new Error(`Chatterbox speaker "${d.speaker}" not prepared`);
    const t0 = performance.now();
    const inputs = await processor._call(d.text);
    const waveform = await model.generate({
      ...inputs, ...spk,
      exaggeration: d.exaggeration ?? 0.5,
      max_new_tokens: Math.min(1000, 80 + d.text.length * 4), // enough for the sentence, not runaway
    });
    const audio = new Float32Array(waveform.data);
    return { audio, sr: 24000, ms: performance.now() - t0, _transfer: [audio.buffer] };
  }
  throw new Error(`Unknown job ${d.type}`);
}

let current = null;
const failCurrent = (e) => {
  const msg = String(e?.message || e);
  log('cbx.uncaught', { error: msg });
  if (current) { const id = current.id; current = null; post({ id, ok: false, error: /allocation|RangeError|memory/i.test(msg) ? 'Not enough memory for Chatterbox alongside the other models. Use a smaller thinking model or Whisper small.' : msg }); }
};
self.addEventListener('unhandledrejection', (ev) => { ev.preventDefault(); failCurrent(ev.reason); });
self.addEventListener('error', (ev) => { ev.preventDefault(); failCurrent(ev.error || ev.message); });

self.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    current = data;
    try {
      const r = await handle(data);
      if (current === data) { const t = r._transfer; delete r._transfer; post({ id: data.id, ok: true, ...r }, t); }
    } catch (e) { if (current === data) post({ id: data.id, ok: false, error: String(e?.message || e), stack: String(e?.stack || '').slice(0, 1500) }); }
    finally { if (current === data) current = null; }
  });
};
