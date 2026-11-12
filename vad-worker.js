// Silero VAD: a small neural speech detector (2 MB) that tells a voice apart from noise.
// Runs on the processor (wasm), ~1 ms per 32 ms of audio. Input: 512-sample frames at 16 kHz.
import * as ort from './vendor/ort/ort.wasm.min.mjs';
ort.env.wasm.wasmPaths = new URL('./vendor/ort/', import.meta.url).href;
ort.env.wasm.numThreads = 1;

let sess = null, state = null, context = new Float32Array(64), queue = Promise.resolve();
const sr = new ort.Tensor('int64', BigInt64Array.from([16000n]), []);
const reset = () => { state = new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]); context = new Float32Array(64); };

async function handle(d) {
  if (d.type === 'load') {
    sess = await ort.InferenceSession.create(new URL('./vendor/silero/silero_vad.onnx', import.meta.url).href, { executionProviders: ['wasm'] });
    reset();
    return { type: 'ready' };
  }
  if (d.type === 'reset') { reset(); return null; }
  if (!sess) return null;
  const x = new Float32Array(576); x.set(context); x.set(d.frame, 64); // v5 expects 64 samples of context
  const out = await sess.run({ input: new ort.Tensor('float32', x, [1, 576]), state, sr });
  state = out.stateN; context = d.frame.slice(448);
  return { type: 'p', p: out.output.data[0] };
}
self.onmessage = ({ data }) => {
  queue = queue.then(() => handle(data)).then((r) => r && self.postMessage(r)).catch((e) => self.postMessage({ type: 'error', error: String(e?.message || e) }));
};
