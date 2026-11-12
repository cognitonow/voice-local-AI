// Speech recognition (Whisper) and knowledge-base embeddings, off the main thread.
import { pipeline, env } from './vendor/transformers/transformers.min.js';

// Everything loads from this folder: models/ and vendor/. Nothing from the internet.
env.allowLocalModels = false;
env.remoteHost = `${self.location.origin}/models/`;
env.backends.onnx.wasm.wasmPaths = `${self.location.origin}/vendor/transformers/`;
let asr, embed;
let queue = Promise.resolve(); // models can't run two jobs at once

const post = (m, t) => self.postMessage(m, t || []);
const progress = (what) => (p) => { if (p.status === 'progress') post({ type: 'progress', what, file: p.file, loaded: p.loaded, total: p.total }); };

const log = (step, info) => post({ type: 'log', step, info });

async function handle(d) {
  if (d.type === 'load') {
    // Whisper large-v3-turbo: half-precision encoder + 4-bit decoder, on the graphics card.
    const repo = 'onnx-community/whisper-large-v3-turbo';
    const device = 'webgpu';
    const encoderFile = 'onnx/encoder_model_fp16.onnx';
    const dtype = { encoder_model: 'fp16', decoder_model_merged: 'q4' };
    log('stt.begin', { repo, device });
    // Check the actual weight files exist before the pipeline tries, so we report the real cause.
    const base = (self.location.origin) + '/models/' + repo + '/resolve/main/';
    for (const f of ['config.json', 'tokenizer.json', encoderFile, 'onnx/decoder_model_merged_q4.onnx']) {
      try {
        const r = await fetch(base + f, { method: 'HEAD' });
        log('stt.file', { file: f, status: r.status });
        if (r.status === 404 && f === encoderFile)
          throw new Error(`Whisper turbo file ${encoderFile} isn't downloaded. Run Download models.bat.`);
      } catch (e) { if (/Turbo/.test(e.message)) throw e; log('stt.file', { file: f, error: String(e) }); }
    }
    try {
      asr = await pipeline('automatic-speech-recognition', repo, {
        device,
        dtype,
        progress_callback: progress('ears'),
      });
      log('stt.pipeline.ok', {});
    } catch (e) {
      log('stt.pipeline.fail', { error: String(e.message || e) });
      if (/allocation failed|out of memory|RangeError/i.test(String(e)))
        throw new Error('Not enough graphics memory for the transcription model. Close other GPU-heavy apps or tabs and restart.');
      throw new Error('Transcription model failed to load: ' + (e.message || e));
    }
    try {
      embed = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
        dtype: 'q8', progress_callback: progress('ears'),
      });
      log('embed.ok', {});
    } catch (e) {
      log('embed.fail', { error: String(e.message || e) });
      throw new Error('Knowledge-base reader model failed to load: ' + (e.message || e));
    }
    try {
      await asr(new Float32Array(16000), { language: 'english', task: 'transcribe' });
      await embed(['warm up'], { pooling: 'mean', normalize: true });
      log('stt.warm.ok', {});
    } catch (e) {
      log('stt.warm.fail', { error: String(e.message || e) });
      throw new Error('Transcription model loaded but failed its warm-up run: ' + (e.message || e));
    }
    return {};
  }
  if (d.type === 'asr') {
    const t0 = performance.now();
    const out = await asr(d.audio, { language: d.language || 'english', task: 'transcribe', chunk_length_s: 30 });
    return { text: out.text, ms: performance.now() - t0 };
  }
  if (d.type === 'embed') {
    const t0 = performance.now();
    const t = await embed(d.texts, { pooling: 'mean', normalize: true });
    return { vecs: t.tolist(), ms: performance.now() - t0 };
  }
  throw new Error(`Unknown job ${d.type}`);
}

let currentJob = null;
const failCurrent = (e) => {
  const msg = String(e?.message || e);
  log('worker.uncaught', { error: msg, job: currentJob?.type });
  if (currentJob) {
    const id = currentJob.id; currentJob = null;
    const friendly = /allocation failed|RangeError/i.test(msg)
      ? 'A model file is too large for the browser to load (' + msg + ').'
      : msg;
    post({ id, ok: false, error: friendly });
  }
};
// transformers.js can throw inside its download stream where the pipeline promise never sees it.
self.addEventListener('unhandledrejection', (ev) => { ev.preventDefault(); failCurrent(ev.reason); });
self.addEventListener('error', (ev) => { ev.preventDefault(); failCurrent(ev.error || ev.message); });

self.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    currentJob = data;
    try { const r = await handle(data); if (currentJob === data) post({ id: data.id, ok: true, ...r }); }
    catch (e) { if (currentJob === data) post({ id: data.id, ok: false, error: String(e?.message || e), stack: String(e?.stack || '').slice(0, 1500) }); }
    finally { if (currentJob === data) currentJob = null; }
  });
};
