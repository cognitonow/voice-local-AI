import { createStage } from './stage.js';
import * as KB from './kb.js';
import * as M from './metrics.js';
import { initPanel } from './panel.js';
import { CHARACTERS, CHARACTER_ERRORS, loadCharacters } from './characters.js';
import * as Mood from './mood.js';
import { ENGINES } from './engines.js';
import { initLibrary } from './library.js';
import { lineHash, listRecordings, loadRecording, saveRecording, deleteRecordings } from './voicefiles.js';

const MIN_SPEECH_MS = 280;   // ignore coughs and clicks
const MAX_SPEECH_MS = 20000;
const FILLERS_DEFAULT = {
  question: ['Good question.', 'Let me think.', 'Hmm, let me see.'],
  statement: ['Mm, okay.', 'Right.', 'I see.'],
};
// Only models that fit on an 8 GB graphics card at full speed, all on the GPU together:
// Whisper large-v3-turbo fp16 (~2.0 GB) + Kokoro (~0.45 GB) + one thinking model (up to ~4.4 GB).
// `noThink`: Qwen3 / Qwen3.5 reason out loud by default; that's switched off so replies start at once.
export const THINKING_MODELS = [
  { key: 'ministral', name: 'Ministral 3 3B', id: 'Ministral-3-3B-Instruct-2512-BF16-q4f16_1-MLC', gb: 2.9, note: 'Measured on this card: 24-35 words/s' },
  { key: 'hermes3b', name: 'Hermes 3 (Llama 3B)', id: 'Hermes-3-Llama-3.2-3B-q4f16_1-MLC', gb: 2.3, note: 'Tuned for roleplay; Llama 3B measured 25-32 words/s here' },
  { key: 'phi4', name: 'Phi-4 mini', id: 'Phi-4-mini-instruct-q4f16_1-MLC', gb: 3.4, note: 'Smarter; measured 20-21 words/s here' },
];
const thinkingModel = () => THINKING_MODELS.find((m) => m.key === settings.thinkingModel) || THINKING_MODELS[0];
// Graphics memory (8 GB card, ~6.9 GB usable): turbo 2.0 GB + Kokoro 0.45 GB, or turbo + Chatterbox 1.7 GB
// (Kokoro then runs on the processor). A thinking model is offered only if it fits beside them.
const USABLE_GB = 6.9;
// Chatterbox only records scripted lines before the thinking model loads, then shuts down, so it
// never shares memory with it: every listed thinking model fits with either voice choice.
export const fitsWith = (m) => m.gb + 2.0 + 0.45 <= USABLE_GB + 1e-9;
const LISTENING = { name: 'Whisper large-v3-turbo', repo: 'whisper-large-v3-turbo' };
const SPEAKING = { name: 'Kokoro', repo: 'Kokoro-82M-v1.0-ONNX' };
const DEFAULTS = {
  thinkingModel: 'ministral',
  name: 'Layla',
  voice: 'af_heart',
  speed: 1.05,
  prompt: `You are Layla, a friendly cabin services trainer running a spoken roleplay.
You are talking out loud, so reply in one to three short sentences, with no lists, markdown or emojis.
Stay in character. If the reference notes answer the question, use them. If you don't know, say so briefly and ask a follow-up question.`,
  // tuning
  silenceMs: 650,        // pause that ends your turn
  fillerMs: 600,         // play a filler if the answer isn't ready this long after transcription (-1 = never)
  bargeIn: false,        // talking over the avatar stops it (off by default; echo causes false triggers)
  bargeLevel: 2.2,       // how much louder than usual you must be to interrupt
  maxTokens: 160,
  earlyChunk: true,      // start speaking at the first comma instead of the first full stop
  kbTopK: 4,
  emotionSpeed: true,    // Kokoro: speed up excited lines, slow down hesitant ones
  voiceChoice: 'character', // start screen: 'character' (the character's voice_engine), 'kokoro' or 'chatterbox'
  voiceEngine: 'kokoro', // the character's engine
  expressiveness: 0.7,   // Chatterbox exaggeration 0 - 1.5 (stress adds or removes up to 0.2)
  voiceSample: '',       // optional reference recording for Chatterbox (file in characters/)
  micMode: 'auto',       // 'auto' adapts to room noise; 'manual' uses micSensitivity
  micSensitivity: 60,    // 0 = only loud speech, 100 = very sensitive (manual mode only)
  micHold: true,         // half-duplex: ignore the mic while the avatar talks/thinks (stops self-interruption)
  backchannel: true,     // quiet "mm-hm" + nod while you speak a long turn
  backchannelAfterMs: 2500, // start acknowledging once your turn passes this length
  backchannelEveryMs: 2800, // minimum spacing between cues
  character: 'custom',
  greeting: '',
  nodStyle: 'nod',
  temperature: 0.7,
  idleNudge: true,       // character prompts you when you go quiet (if it has idle lines)
  showHud: true,         // show the puzzle state (river banks) on screen
  vad: 'silero',
  voiceDevice: 'gpu',    // Kokoro on 'gpu' or 'cpu' (processor frees ~0.45 GB of graphics memory)         // speech detection: 'silero' (neural, ignores noise) or 'level' (loudness only)
};

// Settings come in layers, so characters never leak into each other:
//   app defaults  ->  the character's file  ->  your Tuning changes for that character.
// Character keys below are per character; everything else (mic, models, display) is yours, for all.
export const CHARACTER_KEYS = ['name', 'voice', 'speed', 'prompt', 'greeting', 'nodStyle', 'temperature', 'maxTokens',
  'fillerMs', 'silenceMs', 'earlyChunk', 'backchannelAfterMs', 'backchannelEveryMs', 'voiceEngine', 'expressiveness', 'voiceSample'];
export let settings = { ...DEFAULTS };
let overrides = {}; // characterId -> { key: value } changed in Tuning / Character
try {
  const saved = JSON.parse(localStorage.getItem('rr-settings') || '{}');
  overrides = JSON.parse(localStorage.getItem('rr-overrides') || '{}');
  // Older versions saved character values globally: keep a custom character's text as its own changes.
  if (!localStorage.getItem('rr-overrides') && (saved.character || 'custom') === 'custom') {
    const legacy = {}; for (const k of ['name', 'prompt', 'greeting', 'voice', 'speed']) if (saved[k] != null && saved[k] !== DEFAULTS[k]) legacy[k] = saved[k];
    if (Object.keys(legacy).length) overrides.custom = legacy;
  }
  for (const [k, v] of Object.entries(saved)) if (!CHARACTER_KEYS.includes(k)) settings[k] = v;
} catch {}
// What a character's file (or the defaults, for Custom) says for a key.
const profileValue = (id, k) => { const c = CHARACTERS[id]; const v = c?.[k]; return v != null && v !== '' ? v : DEFAULTS[k]; };
export const saveSettings = () => {
  try {
    const id = settings.character, mine = {};
    for (const k of CHARACTER_KEYS) if (JSON.stringify(settings[k]) !== JSON.stringify(profileValue(id, k))) mine[k] = settings[k];
    if (Object.keys(mine).length) overrides[id] = mine; else delete overrides[id];
    const globals = {}; for (const [k, v] of Object.entries(settings)) if (!CHARACTER_KEYS.includes(k)) globals[k] = v;
    localStorage.setItem('rr-settings', JSON.stringify(globals));
    localStorage.setItem('rr-overrides', JSON.stringify(overrides));
  } catch {}
};
export const overrideCount = () => Object.keys(overrides[settings.character] || {}).length;
// Undo your Tuning/Character changes for this character (back to its file).
export function resetCharacterOverrides() { delete overrides[settings.character]; applyCharacter(settings.character); saveSettings(); }

let charCutoff = null, cutoffClips = [], cutoffIndex = 0;
let charBackchannel = null, charFillers = null, charIdle = null, idleAfterMs = 9000, idleEveryMs = 14000;
export let mood = null, moodRules = []; // the active character's feelings (null = no ## Mood section)
let sceneEngine = null, scene = null;    // the character's scene engine (puzzle: ...) and its state
let scriptIndex = {}, scriptClips = {}; // which line each script event used last; preloaded recordings

// ---- Actors: each character's live state belongs to its own Actor, kept across switches.
// The turn loop works on the active actor's state (the variables above and below); bindActor() puts an
// actor's state in place and stashActor() saves it back, so switching never mixes characters.
const actors = new Map();
let actor = null;
function newActor(id) {
  const c = CHARACTERS[id] || null;
  const eng = c?.puzzle ? ENGINES[c.puzzle] : null;
  return { id, profile: c, state: {
    mood: c?.mood ? Mood.createMood(c.mood) : null, moodRules: c?.moodRules || [],
    sceneEngine: eng, scene: eng ? eng.create() : null, scriptIndex: {}, scriptClips: {},
    charBackchannel: c?.backchannel ?? null, charFillers: c?.fillerLines ?? null, charIdle: c?.idleLines ?? null, charCutoff: c?.cutoffLines ?? null,
    idleAfterMs: c?.idleAfterMs ?? 9000, idleEveryMs: c?.idleEveryMs ?? 14000,
    cutoffClips: [], cutoffIndex: 0, idleClips: [], idleIndex: 0, backs: [], fillers: { question: [], statement: [] },
    history: [], saidWhileWaiting: [], recordings: new Map(), openerClips: null, openerFor: '',
  } };
}
function stashActor() {
  if (!actor) return;
  Object.assign(actor.state, { mood, moodRules, sceneEngine, scene, scriptIndex, scriptClips, charBackchannel, charFillers, charIdle, charCutoff,
    idleAfterMs, idleEveryMs, cutoffClips, cutoffIndex, idleClips, idleIndex, backs, fillers, history, saidWhileWaiting, recordings, openerClips, openerFor });
}
function bindActor(a) {
  actor = a;
  ({ mood, moodRules, sceneEngine, scene, scriptIndex, scriptClips, charBackchannel, charFillers, charIdle, charCutoff,
    idleAfterMs, idleEveryMs, cutoffClips, cutoffIndex, idleClips, idleIndex, backs, fillers, history, saidWhileWaiting, recordings, openerClips, openerFor } = a.state);
}
export const activeActor = () => actor;
export const actorList = () => [...actors.values()];
// Fresh actors from the (re)loaded character files.
function rebuildActors() { stashActor(); actors.clear(); actor = null; }
// Back to the start of the scene: conversation, mood and puzzle.
function resetActorScene() {
  history = []; saidWhileWaiting = [];
  if (mood) Mood.resetMood(mood);
  if (sceneEngine) { scene = sceneEngine.create(); scriptIndex = {}; }
  renderHud();
}
export function applyCharacter(key) {
  if (key !== 'custom' && !CHARACTERS[key]) key = 'custom';
  stashActor();
  if (!actors.has(key)) actors.set(key, newActor(key));
  bindActor(actors.get(key));
  settings.character = key;
  const mine = overrides[key] || {};
  for (const k of CHARACTER_KEYS) settings[k] = mine[k] ?? profileValue(key, k);
  if (key === 'custom') settings.greeting = mine.greeting ?? '';
  renderHud();
  applyAvatar(CHARACTERS[key]);
}
// Each character can have its own 3D model (characters/<id>/avatar.vrm); otherwise the app-wide
// avatar.vrm if there is one, otherwise the built-in figure.
let avatarNow = '';
async function applyAvatar(c) {
  if (!stage) return;
  const want = c?.hasAvatar ? `./${c.dir}avatar.vrm` : (globalAvatar ? './avatar.vrm' : '');
  if (want === avatarNow) return;
  avatarNow = want;
  try { if (want) await stage.loadVRM(want); else stage.useDefault?.(); M.event('avatar', { character: c?.id || 'custom', file: want || 'built-in' }); }
  catch (e) { M.event('avatar.fail', { file: want, error: e.message }); }
}
let globalAvatar = false;

const $ = (s) => document.querySelector(s);
const ui = {
  intro: $('#intro'), start: $('#start'), status: $('#status'), you: $('#you'), them: $('#them'),
  themName: $('#them-name'), lat: $('#latency'), mute: $('#mute'), reset: $('#reset'), stop: $('#stop'),
  file: $('#vrmfile'), note: $('#note'), loading: $('#loading'), gpuNote: $('#gpu-note'),
  kbOpen: $('#kb-open'), kbDialog: $('#kb-dialog'), kbFiles: $('#kb-files'), kbList: $('#kb-list'),
  kbClear: $('#kb-clear'), kbStatus: $('#kb-status'),
  setOpen: $('#settings-open'), setDialog: $('#settings-dialog'), setForm: $('#settings-form'),
};

let ctx, analyser, stage, engine, speech, tts;
let fillers = { question: [], statement: [] }, history = [];
let turn = 0, active = 0, turnDone = true, generating = false, llmBusy = Promise.resolve();
let current = null; // { id, T, t0 }
let playing = [], nextTime = 0, state = 'idle', muted = false, micLevel = 0, speakingUntil = 0;
const levelBuf = new Float32Array(1024);
export const device = { gpu: null, model: null, voice: null };

// ---------------------------------------------------------------- helpers
const LABEL = { idle: 'Ready', listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking', loading: 'Loading' };
// ---------------------------------------------------------------- idle nudges
let saidWhileWaiting = [];
let idleClips = [], idleIndex = 0, lastActivity = performance.now(), nudgesInSilence = 0;
const markActivity = () => { lastActivity = performance.now(); };
setInterval(() => {
  if (!settings.idleNudge || !idleClips.length || !engine || !ctx || muted || (sceneEngine && sceneEngine.done(scene))) return; // not while you're muted
  const quiet = state === 'listening' && !speaking && !playing.length && !generating &&
    document.getElementById('intro').hidden && document.getElementById('scene-card').hidden &&
    !document.querySelector('dialog[open]');
  if (!quiet) return;
  const wait = nudgesInSilence === 0 ? idleAfterMs : idleEveryMs;
  if (performance.now() - lastActivity < wait) return;
  const clip = idleClips[idleIndex % idleClips.length];
  idleIndex++;
  nudgesInSilence++;
  ui.them.textContent = clip.text;
  // Don't edit past history (that makes the model re-read the whole conversation, ~5 s on a 7B).
  // Instead, mention it at the start of the stranger's next message.
  saidWhileWaiting.push(clip.text);
  M.event('idle.nudge', { text: clip.text, n: nudgesInSilence });
  play(clip, 'reply');
  lastActivity = performance.now();
}, 500);

function setState(s) {
  markActivity();
  if (s !== state) M.event('state', { state: s });
  state = s;
  document.body.dataset.state = s;
  ui.status.textContent = LABEL[s] ?? s;
  stage?.setState(s === 'loading' ? 'idle' : s);
}
function note(msg) { ui.note.textContent = msg; ui.note.hidden = !msg; }

const modelDir = (id) => `${location.origin}/models/mlc-ai/${id}/`;
async function exists(url) {
  try { return (await fetch(url, { method: 'HEAD', cache: 'no-store' })).ok; } catch { return false; }
}
// What's missing from the models folder (empty list = ready).
export async function installedThinking() {
  const res = await Promise.all(THINKING_MODELS.map(async (m) => [m.key, await exists(`${modelDir(m.id)}resolve/main/mlc-chat-config.json`)]));
  return res.filter(([, ok]) => ok).map(([k]) => k);
}
async function missingModels() {
  const checks = [
    [LISTENING.name, `./models/onnx-community/${LISTENING.repo}/resolve/main/onnx/encoder_model_fp16.onnx`],
    [SPEAKING.name, `./models/onnx-community/${SPEAKING.repo}/resolve/main/config.json`],
  ];
  const res = await Promise.all(checks.map(async ([n, u]) => [n, await exists(u)]));
  return res.filter(([, ok]) => !ok).map(([n]) => n);
}

function rpcWorker(file) {
  const w = new Worker(new URL(file, import.meta.url), { type: 'module' });
  const pending = new Map();
  let n = 0;
  const api = { onProgress: () => {} };
  w.onmessage = ({ data }) => {
    if (data.type === 'progress') return api.onProgress(data);
    if (data.type === 'log') { console.info('[' + file + ']', data.step, data.info || {}); return M.event('worker.' + data.step, data.info || {}); }
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    if (data.ok) p.resolve(data);
    else { const err = new Error(data.error); err.worker = file; err.workerStack = data.stack || ''; p.reject(err); }
  };
  w.onerror = (e) => {
    e.preventDefault?.();
    const msg = e.message || "it couldn't load its files from the vendor folder";
    for (const p of pending.values()) p.reject(new Error(msg));
    pending.clear();
  };
  api.terminate = () => { w.terminate(); for (const p of pending.values()) p.reject(new Error('worker stopped')); pending.clear(); };
  api.call = (type, payload = {}, transfer = []) => new Promise((resolve, reject) => {
    const id = ++n;
    pending.set(id, { resolve, reject });
    w.postMessage({ id, type, ...payload }, transfer);
  });
  return api;
}

function progressTracker(rowId) {
  const row = document.getElementById(rowId);
  const bar = row.querySelector('progress');
  const files = new Map();
  row.querySelector('.size').textContent = 'Loading...';
  let stepText = false; // once a later step is announced, late download updates must not overwrite it
  return {
    file(p) {
      if (!p.total || stepText) return;
      files.set(p.file, [p.loaded, p.total]);
      let l = 0, t = 0;
      for (const [a, b] of files.values()) { l += a; t += b; }
      bar.value = l / t;
      row.querySelector('.size').textContent = l >= t ? `${Math.round(t / 1e6)} MB loaded - preparing on the graphics card...` : `${Math.round(l / 1e6)} of ${Math.round(t / 1e6)} MB`;
    },
    set(v, text) { bar.value = v; if (text) { stepText = !/^(Loading|Waiting)/.test(text); row.querySelector('.size').textContent = text; } },
    done(ms) { bar.value = 1; row.dataset.done = 'yes'; row.querySelector('.size').textContent = `Ready in ${(ms / 1000).toFixed(1)} s`; },
    fail(err) { row.dataset.failed = 'yes'; row.querySelector('.size').textContent = `Failed: ${err.message}`.slice(0, 140); },
  };
}

const embedFn = async (texts) => (await speech.call('embed', { texts })).vecs;

// ---------------------------------------------------------------- loading
const BACKCHANNELS_DEFAULT = ['Mm-hm.', 'Mm.', 'Right.', 'I see.', 'Okay.', 'Yeah.'];
let backs = [];
// ---------------------------------------------------------------- voice (Kokoro)
// Kokoro has no emotion control, so lean on pace: excited lines faster, hesitant ones slower.
function emotionFactor(text) {
  if (!settings.emotionSpeed) return 1;
  const caps = (text.match(/\b[A-Z]{3,}\b/g) || []).length;
  if (/!/.test(text) || caps) return 1.08;
  if (/\.\.\.|\u2026/.test(text)) return 0.93;
  return 1;
}
export const voiceEngine = () => (settings.voiceChoice && settings.voiceChoice !== 'character') ? settings.voiceChoice : (settings.voiceEngine || 'kokoro');
let cbx = null, cbxReady = null, cbxSpeakerKey = '', cbxError = '';
// Stress shapes delivery: a panicked character speaks faster and (Chatterbox) more dramatically.
const stressSpeed = () => (mood ? 1 + 0.12 * (mood.state.stress - 0.5) : 1);

async function kokoroSynth(text, speedMul = 1) {
  const r = await tts.call('synth', { text, voice: settings.voice, speed: settings.speed * speedMul * emotionFactor(text) * stressSpeed() });
  return { ...r, engine: 'kokoro' };
}

// Chatterbox needs a few seconds of reference voice. Use the character's voice_sample file if it
// has one, otherwise let Kokoro speak a reference in the character's voice (so voices stay consistent).
async function chatterboxSpeaker() {
  const key = settings.character + '|' + (settings.voiceSample || settings.voice);
  if (cbxSpeakerKey === key) return key;
  let audio = null;
  if (settings.voiceSample) {
    try {
      const c = CHARACTERS[settings.character];
      const tryUrls = [`./characters/${settings.voiceSample}`, c ? `./characters/${c.id}/${settings.voiceSample}` : null].filter(Boolean);
      for (const u of tryUrls) {
        const r = await fetch(u, { cache: 'no-store' });
        if (!r.ok) continue;
        const decoded = await ctx.decodeAudioData(await r.arrayBuffer());
        const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * 24000), 24000);
        const src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start();
        audio = (await off.startRendering()).getChannelData(0).slice(0, 24000 * 15);
        M.event('cbx.sample', { file: u, seconds: +(audio.length / 24000).toFixed(1) });
        break;
      }
      if (!audio) M.event('cbx.sample.missing', { file: settings.voiceSample });
    } catch (e) { M.event('cbx.sample.fail', { error: e.message }); }
  }
  if (!audio) {
    const ref = (settings.greeting || 'Hello there. I am so glad you came. Please, we really need to talk about this right now.').slice(0, 260);
    const r = await tts.call('synth', { text: ref, voice: settings.voice, speed: settings.speed });
    audio = r.audio;
  }
  await cbx.call('speaker', { key, audio }, []);
  cbxSpeakerKey = key;
  return key;
}

async function chatterboxSynth(text) {
  if (!cbxReady) throw new Error(cbxError ? `it couldn't load: ${cbxError}` : 'it was never started');
  await cbxReady;
  const speaker = await chatterboxSpeaker();
  const r = await cbx.call('synth', { text, speaker, exaggeration: Math.max(0, Math.min(1.5, settings.expressiveness + (mood ? 0.4 * (mood.state.stress - 0.5) : 0))) });
  return { ...r, engine: 'chatterbox' };
}

// Load Chatterbox on demand (at start if a character uses it, or when picked in Tuning).
function ensureChatterbox(tracker) {
  if (cbxReady) return cbxReady;
  cbx = rpcWorker('./chatterbox-worker.js');
  if (tracker) cbx.onProgress = (p) => tracker.file(p);
  const t0 = performance.now();
  M.event('cbx.load.begin', {}); cbxError = '';
  cbxReady = cbx.call('load', {}).then(() => {
    tracker?.set(1, 'Chatterbox ready');
    M.event('cbx.load.done', { ms: Math.round(performance.now() - t0) });
  }, async (e) => {
    // If the worker couldn't even start, say exactly which file is missing.
    if (/vendor folder|failed to start/i.test(e.message)) {
      const need = ['./chatterbox-worker.js', './vendor/transformers4/transformers-v4.min.js',
        './vendor/transformers4/ort-wasm-simd-threaded.mjs', './vendor/transformers4/ort-wasm-simd-threaded.wasm',
        './vendor/transformers4/ort-wasm-simd-threaded.asyncify.mjs', './vendor/transformers4/ort-wasm-simd-threaded.asyncify.wasm'];
      const missing = [];
      for (const f of need) if (!(await exists(f))) missing.push(f.slice(2));
      if (missing.length) e = new Error(`these files are missing: ${missing.join(', ')}`);
    }
    cbxError = e.message;
    M.event('cbx.load.fail', { error: e.message, stack: String(e.workerStack || '').split('\n').slice(0, 6).join(' | ') });
    console.error('[chatterbox] load failed:', e.message, e.workerStack || '');
    device.voice = `Kokoro (Chatterbox failed: ${e.message.slice(0, 80)})`;
    cbxReady = null; cbx = null; throw e;
  });
  return cbxReady;
}


// Hybrid voice: with Chatterbox chosen, every scripted line (opener, fillers, interjections, idle
// lines, script reactions) is recorded once by Chatterbox and kept; live replies are always Kokoro.
let runEngine = 'kokoro'; // what this session actually uses (set at Start)
let recordings = new Map(); // hash -> recorded line, read from characters/<id>/voice/ at Start
const cleanLine = (t) => String(t).trim().replace(/[*_#`>]/g, '');
// A recording belongs to the exact text + voice settings; change either and that line is recorded anew.
const lineKey = (text) => lineHash(['chatterbox', settings.voice, settings.voiceSample || '-', (+settings.expressiveness || 0).toFixed(1), cleanLine(text)].join('|'));
async function synthVoice(text, { speedMul = 1 } = {}) {
  if (runEngine === 'chatterbox') {
    const hit = recordings.get(lineKey(text));
    if (hit) return { audio: hit.audio, sr: hit.sr, ms: 0, engine: 'recorded' };
    M.event('line.not_recorded', { text: cleanLine(text).slice(0, 80), note: 'Kokoro used; restart to record it' });
  }
  return kokoroSynth(cleanLine(text), speedMul);
}
// Every pre-made line, with a label for its file name (opener-1, idle-04, across_duck-2, ...).
function scriptedLines() {
  const c = CHARACTERS[settings.character];
  const opener = (settings.greeting.match(/[^.!?\u2026]+[.!?\u2026]*/g) || (settings.greeting ? [settings.greeting] : []));
  const pad = (i) => String(i + 1).padStart(2, '0');
  const groups = [['opener', opener], ['filler', charFillers || Object.values(FILLERS_DEFAULT).flat()],
    ['interject', charBackchannel || BACKCHANNELS_DEFAULT], ['idle', charIdle || []], ['cutoff', charCutoff || []],
    ...Object.entries(c?.script || {})];
  const seen = new Set(), out = [];
  for (const [label, lines] of groups) lines.forEach((t, i) => { const text = cleanLine(t); if (text && !seen.has(text)) { seen.add(text); out.push({ text, label: `${label}-${pad(i)}` }); } });
  return out;
}
const scriptedTexts = () => scriptedLines().map((l) => l.text);
// Read this character's recordings from its voice folder (only the lines it currently uses).
async function loadCharacterRecordings() {
  recordings = new Map();
  const c = CHARACTERS[settings.character];
  if (!c) return { have: 0, need: 0 };
  const files = await listRecordings(c.id), lines = scriptedLines();
  const todo = lines.map((l) => [lineKey(l.text), files.get(lineKey(l.text))]).filter(([, f]) => f);
  // Several at a time: one by one is slow (each request waits on the last).
  for (let i = 0; i < todo.length; i += 8) {
    await Promise.all(todo.slice(i, i + 8).map(async ([h, f]) => {
      try { recordings.set(h, await loadRecording(c.id, f)); } catch (e) { M.event('line.load.fail', { file: f, error: e.message }); }
    }));
  }
  M.event('lines.loaded', { character: c.id, have: recordings.size, need: lines.length });
  return { have: recordings.size, need: lines.length };
}
// First start with Chatterbox (or after lines change): record what's missing, then shut Chatterbox down.
async function recordScriptedLines(tracker) {
  const c = CHARACTERS[settings.character];
  await loadCharacterRecordings();
  const lines = scriptedLines(), missing = lines.filter((l) => !recordings.has(lineKey(l.text)));
  M.event('lines.check', { total: lines.length, toRecord: missing.length });
  if (!missing.length) { tracker.set(1, `All ${lines.length} recorded lines found in characters/${c.id}/voice`); return; }
  if (!(await cbxInstalled())) {
    note(`${missing.length} of ${lines.length} lines have no recording in characters/${c.id}/voice and Chatterbox isn't downloaded, so Kokoro speaks those.`);
    return;
  }
  // Loading Chatterbox takes about 2 minutes with nothing to show, so count the seconds.
  const s0 = performance.now();
  const tick = () => tracker.set(0, `Starting Chatterbox to record ${missing.length} lines: ${Math.round((performance.now() - s0) / 1000)} s (usually about 2 min)`);
  tick(); const timer = setInterval(tick, 1000);
  try { await ensureChatterbox(); }
  catch (e) { clearInterval(timer); note(`Chatterbox couldn't load, so Kokoro voices everything: ${e.message.replace(/\.+$/, '').slice(0, 200)}.`); runEngine = 'kokoro'; return; }
  clearInterval(timer);
  M.event('cbx.ready', { ms: Math.round(performance.now() - s0) });
  const t0 = performance.now();
  let saveWarned = false, done = 0, failed = 0, inARow = 0, firstError = '';
  for (const [i, { text, label }] of missing.entries()) {
    const left = i ? Math.round(((performance.now() - t0) / i) * (missing.length - i) / 60000) : null;
    tracker.set(i / missing.length, `Recording ${settings.name}'s lines with Chatterbox (first time only): ${i + 1} of ${missing.length}${left != null ? `, about ${left} min left` : ''}`);
    const t1 = performance.now();
    try {
      const clip = await chatterboxSynth(text);
      recordings.set(lineKey(text), { audio: clip.audio, sr: clip.sr });
      try { await saveRecording(c.id, label, lineKey(text), clip); }
      catch (e) { if (!saveWarned) { saveWarned = true; note(`Recorded lines can't be saved to the folder (${e.message}). They'll work this session only.`); } }
      M.event('line.recorded', { i: i + 1, of: missing.length, ms: Math.round(performance.now() - t1), text: text.slice(0, 60) });
      done++; inARow = 0;
    } catch (e) {
      failed++; inARow++; firstError ||= e.message;
      M.event('line.record.fail', { i: i + 1, text: text.slice(0, 60), error: e.message });
      if (inARow >= 3) { M.event('lines.record.stopped', { after: i + 1, error: e.message }); break; } // Chatterbox has stopped working
    }
  }
  cbx?.terminate(); cbx = null; cbxReady = null; cbxSpeakerKey = '';
  M.event('cbx.shutdown', { recorded: done, failed, ms: Math.round(performance.now() - t0) });
  const notDone = missing.length - done;
  if (notDone) note(`Recorded ${done} of ${missing.length} lines; ${notDone} still missing (Kokoro speaks those for now). Chatterbox error: ${firstError.replace(/\.+$/, '').slice(0, 160)}. Press Start next time to record the rest. Details: Stats > Log (line.record.fail).`);
}

// The opener is voiced during loading so it plays the instant you press Begin.
let openerClips = [], openerFor = '';
async function synthOpener(tracker) {
  const text = settings.greeting || '';
  const clips = [];
  const parts = (text.match(/[^.!?\u2026]+[.!?\u2026]*/g) || (text ? [text] : [])).map((p) => p.trim().replace(/[*_#`>]/g, '')).filter(Boolean);
  for (const [i, clean] of parts.entries()) {
    tracker?.set(1, `Preparing the opener: ${i + 1} of ${parts.length}`);
    const t0 = performance.now();
    clips.push(await synthVoice(clean));
    M.event('opener.voiced', { part: i + 1, of: parts.length, engine: clips[clips.length - 1].engine, ms: Math.round(performance.now() - t0) });
  }
  openerClips = clips; openerFor = text + '|' + settings.voice + '|' + settings.speed + '|' + runEngine;
}
// Everything else is voiced in the background after the scene is ready.
async function voiceCharacterLines() {
  const t0 = performance.now();
  M.event('voice.background.start', { character: settings.character });
  try { await synthFillers(); M.event('voice.background.done', { ms: Math.round(performance.now() - t0), fillers: fillers.question.length, interjections: backs.length, idle: idleClips.length }); }
  catch (e) { M.event('voice.background.fail', { error: e.message }); }
}
// A character's own knowledge, embedded once per character and searched alongside the Knowledge store.
let charKB = { key: '', chunks: [] }, charKBBuilding = null;
function ensureCharKB() {
  const c = CHARACTERS[settings.character];
  const key = c ? c.id + ':' + (c.knowledge || '').length + ':' + (c.knowledgeFiles || []).map((f) => f.name + f.text.length).join(',') : '';
  if (charKB.key === key) return Promise.resolve(charKB.chunks);
  if (charKBBuilding?.key === key) return charKBBuilding.p;
  const items = c ? [
    ...(c.knowledge ? [{ source: `${c.file} (Knowledge)`, text: c.knowledge }] : []),
    ...(c.knowledgeFiles || []).map((f) => ({ source: `${c.id}/${f.name}`, text: f.text })),
  ] : [];
  const p = (items.length && speech ? KB.embedTexts(items, embedFn) : Promise.resolve([]))
    .then((chunks) => { charKB = { key, chunks }; M.event('character.knowledge', { character: settings.character, sections: chunks.length }); return chunks; })
    .catch((e) => { M.event('character.knowledge.fail', { error: e.message }); charKB = { key, chunks: [] }; return []; });
  charKBBuilding = { key, p };
  return p;
}

async function synthFillers() {
  const out = { question: [], statement: [] };
  if (charFillers) {
    // A character's fillers suit any turn: voice each once and share them.
    for (const text of charFillers) out.question.push({ ...(await synthVoice(text)), text });
    out.statement = out.question;
  } else {
    for (const kind of Object.keys(FILLERS_DEFAULT)) {
      for (const text of FILLERS_DEFAULT[kind]) {
        const r = await synthVoice(text);
        out[kind].push({ ...r, text });
      }
    }
  }
  fillers = out;
  const b = [];
  for (const text of (charBackchannel || BACKCHANNELS_DEFAULT)) {
    const r = await synthVoice(text, { speedMul: 1.08 });
    b.push({ ...r, text });
  }
  backs = b;
  const idle = [];
  for (const text of (charIdle || [])) {
    const r = await synthVoice(text);
    idle.push({ ...r, text });
  }
  idleClips = idle;
  idleIndex = 0;
  const cut = [];
  for (const text of (charCutoff || [])) cut.push({ ...(await synthVoice(text)), text: cleanLine(text) });
  cutoffClips = cut; cutoffIndex = 0;
  const sc = {};
  for (const [ev, lines] of Object.entries(CHARACTERS[settings.character]?.script || {})) {
    sc[ev] = [];
    for (const text of lines) sc[ev].push({ ...(await synthVoice(text)), text: cleanLine(text) });
  }
  scriptClips = sc;
}

// Play a short acknowledgement at reduced volume while the user is still talking.
function playBackchannel() {
  if (!backs.length) return;
  const { audio, sr, text } = backs[Math.floor(Math.random() * backs.length)];
  const ab = ctx.createBuffer(1, audio.length, sr);
  ab.copyToChannel(audio, 0);
  const src = ctx.createBufferSource();
  src.buffer = ab;
  const g = ctx.createGain();
  g.gain.value = 0.35; // quiet, so it sits under the user's voice
  src.connect(g).connect(ctx.destination);
  src.start();
  stage?.cue?.(settings.nodStyle);
  M.event('backchannel', { text });
}

async function loadModels() {
  const adapter = navigator.gpu ? await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }) : null;
  if (!adapter) throw new Error('This browser has no WebGPU. Use a recent Chrome or Edge on a desktop or laptop.');
  const info = adapter.info || {};
  device.gpu = [info.vendor, info.architecture, info.description].filter(Boolean).join(' / ') || 'unknown GPU';
  const f16 = adapter.features.has('shader-f16');
  M.event('gpu', { gpu: device.gpu, f16, maxBuffer: adapter.limits.maxBufferSize });

  if (!f16) throw new Error('This graphics card lacks half-precision (shader-f16) support, which the models need.');
  const tm = thinkingModel();
  if (!(await installedThinking()).includes(tm.key)) throw new Error(`${tm.name} isn't in the models folder. Run 'Download models.bat'.`);
  const modelId = tm.id;
  device.model = tm.name;
  device.transcription = LISTENING.name;
  const engineChoice = voiceEngine();
  runEngine = engineChoice === 'chatterbox' ? 'chatterbox' : 'kokoro';
  const kokoroWhere = settings.voiceDevice === 'cpu' ? 'Kokoro on processor' : 'Kokoro on graphics card';
  device.voice = runEngine === 'chatterbox' ? `Recorded lines (characters folder) + ${kokoroWhere} (live replies)` : kokoroWhere;
  M.event('load.plan', { thinking: modelId, listening: LISTENING.repo, voice: SPEAKING.repo, crossOriginIsolated: self.crossOriginIsolated, cpuThreads: navigator.hardwareConcurrency, gpu: device.gpu });

  const pBrain = progressTracker('p-brain'), pEars = progressTracker('p-ears'), pVoice = progressTracker('p-voice');
  let CreateWebWorkerMLCEngine, prebuiltAppConfig;
  try {
    ({ CreateWebWorkerMLCEngine, prebuiltAppConfig } = await import('./vendor/web-llm.js'));
  } catch (e) {
    const err = new Error(`couldn't load the model library (${e.message})`);
    pBrain.fail(err); throw err;
  }
  const rec = prebuiltAppConfig.model_list.find((m) => m.model_id === modelId);

  const appConfig = {
    ...prebuiltAppConfig,
    model_list: [{ ...rec, model: modelDir(modelId), model_lib: `${location.origin}/vendor/mlc-libs/${rec.model_lib.split('/').pop()}` }],
  };
  speech = rpcWorker('./speech-worker.js');
  tts = rpcWorker('./tts-worker.js');
  speech.onProgress = (p) => pEars.file(p);
  tts.onProgress = (p) => pVoice.file(p);

  const t0 = performance.now();
  const timed = (name, tracker) => [
    () => { const ms = performance.now() - t0; tracker.done(ms); M.event('load.done', { part: name, ms: Math.round(ms) }); },
    (e) => { tracker.fail(e); M.event('load.fail', { part: name, error: e.message }); throw e; },
  ];
  M.event('load.begin', { parts: ['thinking', 'listening', 'voice'] });
  // Voice first: Kokoro, then (Chatterbox only) record missing scripted lines and shut Chatterbox down,
  // so it is gone from graphics memory before the thinking and listening models load.
  pBrain.set(0, 'Waiting for the voice...'); pEars.set(0, 'Waiting for the voice...');
  await tts.call('load', { voice: settings.voice, cpu: settings.voiceDevice === 'cpu' }).catch((e) => { pVoice.fail(e); throw e; });
  if (runEngine === 'chatterbox') await recordScriptedLines(pVoice);
  pBrain.set(0, 'Loading...'); pEars.set(0, 'Loading...');
  // Watchdog: if the thinking model makes no progress for 45s, it's almost certainly a
  // model/library mismatch rather than a slow load — fail loudly instead of hanging forever.
  let lastBrainProgress = performance.now(), brainDone = false;
  const watchdog = setInterval(() => {
    if (brainDone) { clearInterval(watchdog); return; }
    if (performance.now() - lastBrainProgress > 45000) {
      clearInterval(watchdog);
      pBrain.fail(new Error('stalled — try another model, or re-download this one'));
      M.event('load.stalled', { part: 'thinking', model: modelId });
    }
  }, 5000);
  const brain = CreateWebWorkerMLCEngine(new Worker(new URL('./llm-worker.js', import.meta.url), { type: 'module' }), modelId, {
    appConfig,
    initProgressCallback: (r) => { lastBrainProgress = performance.now(); pBrain.set(r.progress, r.text.replace(/\[.*?\]\s*/, '').slice(0, 60)); },
  }).then(async (e) => {
    engine = e; brainDone = true; clearInterval(watchdog);
    // Warm-up: the graphics card prepares its code on first use, which made the first reply take 5-6 s.
    // A tiny reply now (with the real instructions, so the long-prompt path is prepared too) moves that here.
    pBrain.set(1, 'Warming up...');
    const w0 = performance.now();
    try {
      await engine.chat.completions.create({ messages: [{ role: 'system', content: settings.prompt }, { role: 'user', content: 'Hello?' }],
        max_tokens: 2, temperature: 0, ...(thinkingModel().noThink ? { extra_body: { enable_thinking: false } } : {}) });
      await engine.resetChat();
      M.event('llm.warm', { ms: Math.round(performance.now() - w0) });
    } catch (err) { M.event('llm.warm.fail', { error: err.message }); }
  }).then(...timed('thinking', pBrain));
  // Fail a load that hangs with no resolution/rejection, so startup can never freeze silently.
  const withTimeout = (p, ms, label) => Promise.race([p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms / 1000}s — check the Log for the last step reached`)), ms))]);
  const ears = withTimeout(speech.call('load', {}), 120000, 'Transcription model').then(...timed('listening', pEars));
  const voice = withTimeout(synthOpener(pVoice), 120000, 'Voice').then(...timed('voice', pVoice));
  const results = await Promise.allSettled([brain, ears, voice]);
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length) throw failed[0].reason;
  M.event('ready', { model: modelId, voice: device.voice });
  voiceCharacterLines(); // not awaited: fillers, interjections and idle lines voice in the background
  ensureCharKB();
}

// ---------------------------------------------------------------- playback
// Returns { startsInMs, gapMs } so the turn can record when audio is actually heard.
function play({ audio, sr }, kind) {
  const ab = ctx.createBuffer(1, audio.length, sr);
  ab.copyToChannel(audio, 0);
  const src = ctx.createBufferSource();
  src.buffer = ab;
  src.connect(analyser);
  const now = ctx.currentTime;
  const gapMs = nextTime > 0 && now > nextTime && kind === 'reply' ? Math.round((now - nextTime) * 1000) : 0;
  const at = Math.max(now + 0.02, nextTime);
  src.start(at);
  nextTime = at + ab.duration;
  src.kind = kind;
  playing.push(src);
  setState('speaking');
  src.onended = () => {
    playing = playing.filter((s) => s !== src);
    speakingUntil = performance.now() + 350; // echo tail: ignore the mic briefly after audio stops
    if (!playing.length && turnDone && state === 'speaking') setState('listening');
  };
  return { startsInMs: Math.round((at - now) * 1000), gapMs, durMs: Math.round(ab.duration * 1000) };
}

function stopPlayback() {
  for (const s of playing) { try { s.stop(); } catch {} }
  playing = [];
  nextTime = 0;
}

function mouthLevel() {
  if (!analyser || !playing.length) return 0;
  analyser.getFloatTimeDomainData(levelBuf);
  let s = 0;
  for (const x of levelBuf) s += x * x;
  return Math.min(1, Math.max(0, (Math.sqrt(s / levelBuf.length) - 0.012) * 7));
}

// ---------------------------------------------------------------- interruption
export function interrupt(reason) {
  const busy = playing.length || generating || state === 'thinking';
  if (!busy) return false;
  const c = current;
  if (c && c.id === active) {
    const t = c.T;
    t.interrupted = true;
    t.interruptReason = reason;
    t.interruptedAtMs = Math.round(performance.now() - c.t0);
    t.heardSentences = t.sentences.filter((s) => s.played).length;
    M.update(t);
  }
  const wasSpeaking = playing.length > 0;
  M.event('interrupt', { turn: c?.T.n, reason, generating, playingClips: playing.length });
  stopPlayback();
  if (reason === 'talked over' && wasSpeaking && cutoffClips.length) {
    const clip = cutoffClips[cutoffIndex++ % cutoffClips.length];
    play(clip, 'cutoff');
    M.event('cutoff', { text: clip.text });
  }
  active = 0;
  turnDone = true;
  if (generating) engine.interruptGenerate();
  setState('listening');
  return true;
}

// ---------------------------------------------------------------- conversation
const FULL_STOP = /[.!?\u2026]+["')\]]*\s+|\n+/g;
const SOFT_STOP = /[.!?\u2026,;:\u2014]+["')\]]*\s+|\n+/g;
function popSentences(buf, final, first) {
  const re = first && settings.earlyChunk ? SOFT_STOP : FULL_STOP;
  const minLen = first && settings.earlyChunk ? 24 : 18;
  const out = [];
  let start = 0, pending = '', m;
  re.lastIndex = 0;
  while ((m = re.exec(buf))) {
    pending += buf.slice(start, m.index + m[0].length);
    start = m.index + m[0].length;
    if (pending.trim().length >= minLen) { out.push(pending.trim()); pending = ''; if (first && settings.earlyChunk) break; }
  }
  let rest = pending + buf.slice(start);
  if (final && rest.trim()) { out.push(rest.trim()); rest = ''; }
  return [out, rest];
}

function pickFiller(text) {
  const q = /\?\s*$/.test(text) || /^(what|why|how|when|where|who|which|can|could|should|would|do|does|is|are|will)\b/i.test(text);
  const set = fillers[q ? 'question' : 'statement'];
  return set.length ? set[Math.floor(Math.random() * set.length)] : null;
}

// After the reply: apply the character's own judgement (#mood tag) with inertia, set its face.
async function updateMood(T) {
  let tag = Mood.parseTag(T.moodTag || '');
  T.appraisedBy = tag ? 'model tag' : 'reply';
  if (!tag) {
    try { tag = await Mood.appraiseFromReply(T.reply, embedFn); } catch (e) { M.event('mood.appraise.fail', { error: e.message }); }
    M.event('mood.from_reply', { turn: T.n, act: tag?.act, score: tag?.score });
  }
  const { before, after } = Mood.applyDelta(mood, tag?.delta || {});
  const face = tag?.face || Mood.faceFromMood(after);
  Object.assign(T, { act: tag?.act || null, moodDelta: tag?.delta || null, mood: { ...after }, face });
  setFace(face);
  M.event('mood.update', { turn: T.n, by: T.appraisedBy, act: T.act, delta: T.moodDelta, before, after, face, tag: T.moodTag || null });
  M.update(T);
}
function setFace(face) { stage?.setExpression?.(face); device.face = face; }
// The scene as the user would see it (drawn by the character's scene engine, e.g. the river banks).
function renderHud() {
  const hud = document.getElementById('scene-hud');
  if (!hud) return;
  const html = sceneEngine && settings.showHud ? sceneEngine.hud(scene) : '';
  hud.hidden = !html;
  if (html) hud.innerHTML = html;
}

// A reply is looping if one word repeats 4+ times in a row, or its last 12 words use 4 or fewer
// different words. ("No no no!" and "Oh god, oh god" are fine.)
function looping(text) {
  const w = String(text).toLowerCase().match(/[a-z']+/g) || [];
  for (let i = 3; i < w.length; i++) if (w[i] === w[i - 1] && w[i] === w[i - 2] && w[i] === w[i - 3]) return true;
  const tail = w.slice(-12);
  return tail.length >= 12 && new Set(tail).size <= 4;
}
// Keep only the part of the pending text before the repetition began (often nothing).
function cutLoop(text) {
  const parts = String(text).split(/(?<=[.!?\u2026])\s+/);
  const keep = [];
  for (const p of parts) { if (looping(p) || looping([...keep, p].join(' '))) break; keep.push(p); }
  return keep.join(' ');
}
const META = /#\s*mood\b|^\s*mood\s*[:=]|\bface\s*=|\b[psdt]\s*=\s*[-+]?\d|\[\s*state\b|^\s*state\s*:/i;
async function runTurn(id, audio, meta) {
  const t0 = meta.t0;
  const rel = () => Math.round(performance.now() - t0);
  const T = M.newTurn({
    model: device.model, voiceDevice: device.voice, userSpeechMs: meta.speechMs,
    audioSec: +(audio.length / 16000).toFixed(2), endWaitMs: settings.silenceMs,
  });
  current = { id, T, t0 };
  M.event('turn.start', { turn: T.n, speechMs: meta.speechMs });

  T.stage = 'transcription';
  const asr = await speech.call('asr', { audio }, [audio.buffer]);
  T.sttMs = rel(); T.sttComputeMs = Math.round(asr.ms);
  const said = (asr.text || '').trim();
  T.text = said;
  M.event('stt.done', { turn: T.n, ms: T.sttMs, text: said });
  M.update(T);
  if (id !== active) return;
  const JUNK = /^(you|thanks for watching.*|see you (guys )?in the next.*|please subscribe.*|i'?m going to.*already done.*)$/i;
  if (said.length < 2 || /^[\[(*].*[\])*]$/.test(said) || JUNK.test(said)) {
    T.empty = true; T.totalMs = rel(); M.update(T);
    M.event('stt.empty', { turn: T.n, text: said });
    turnDone = true; setState('listening'); return;
  }
  ui.you.textContent = said;

  // ---- Scripted reactions: if this was a puzzle move, the app judges it and plays the recorded line.
  if (sceneEngine && CHARACTERS[settings.character]?.script) {
    const res = sceneEngine.handle(said, scene);
    if (res) {
      const ev = res.event, evLines = CHARACTERS[settings.character].script[ev];
      scene = res.state; renderHud();
      T.scripted = ev; T.banks = sceneEngine.describe(scene);
      M.event('script.move', { turn: T.n, said, move: res.detail, event: ev, scene: T.banks });
      if (evLines?.length) {
        const i = (scriptIndex[ev] = ((scriptIndex[ev] ?? -1) + 1) % evLines.length);
        const line = cleanLine(evLines[i]);
        const clip = scriptClips[ev]?.[i] || await synthVoice(line);
        if (id !== active) return;
        const p = play(clip, 'reply');
        T.sentences.push({ i: 0, text: line, chars: line.length, played: true, engine: clip.engine, playAtMs: rel() + p.startsInMs, audioMs: Math.round((clip.audio.length / clip.sr) * 1000) });
        T.firstAudioMs = rel() + p.startsInMs; T.reply = line;
        ui.them.textContent = line;
        history.push({ role: 'user', content: said }, { role: 'assistant', content: line });
        if (mood) {
          T.moodBefore = { ...mood.state };
          const fx = sceneEngine.effects[ev] || { act: 'neutral', delta: {}, face: null };
          const { after } = Mood.applyDelta(mood, fx.delta);
          Object.assign(T, { act: fx.act, moodDelta: fx.delta, mood: { ...after }, face: fx.face, appraisedBy: 'script' });
          if (fx.face) setFace(fx.face);
          M.event('mood.update', { turn: T.n, by: 'script', act: fx.act, after, face: fx.face });
        }
        const d = M.derive(T);
        ui.lat.textContent = `Heard you in ${T.sttMs} ms. Scripted reaction after ${(d.firstAnswerMs / 1000).toFixed(1)} s (including the ${settings.silenceMs} ms pause)`;
        T.totalMs = rel(); M.update(T);
        turnDone = true;
        return;
      }
      // No line written for this event: the thinking model reacts, knowing the new state.
    }
  }

  // Filler: only if the real answer isn't ready to speak in time.
  let answerReady = false;
  const fillerTimer = settings.fillerMs >= 0 ? setTimeout(() => {
    if (answerReady || id !== active) return;
    const f = pickFiller(said);
    if (!f) return;
    const p = play(f, 'filler');
    T.filler = f.text; T.fillerAtMs = rel() + p.startsInMs;
    M.event('filler', { turn: T.n, text: f.text, atMs: T.fillerAtMs });
    if (!ui.them.textContent) ui.them.textContent = f.text;
    M.update(T);
  }, settings.fillerMs) : null;

  T.stage = 'knowledge';
  const kb0 = performance.now();
  const extra = await ensureCharKB().catch((e) => { M.event('character.knowledge.fail', { error: e.message }); return []; });
  const notes = await KB.search(said, embedFn, settings.kbTopK, 0.3, extra).catch(() => []);
  T.kbMs = Math.round(performance.now() - kb0);
  T.kbHits = notes.map((c) => ({ source: c.source, score: +c.score.toFixed(3) }));
  M.event('kb.done', { turn: T.n, ms: T.kbMs, hits: T.kbHits });
  let system = settings.prompt;
  if (notes.length) system += `\n\nReference notes (use if relevant, never read them out verbatim):\n${notes.map((c) => c.text).join('\n---\n')}`;
  const waited = saidWhileWaiting.length ? `[While waiting for an answer, you said: "${saidWhileWaiting.join(' ')}"]\n` : '';
  saidWhileWaiting = [];
  let stateNote = '';
  if (mood) {
    const rules = Mood.activeRules(mood, moodRules);
    T.moodBefore = { ...mood.state }; T.rules = rules.map((r) => r.text);
    stateNote = `[STATE: you feel ${Mood.describe(mood.state)}.${rules.length ? ' ' + rules.map((r) => r.text).join(' ') : ''}${sceneEngine ? ' ' + sceneEngine.describe(scene) : ''}]\n`;
    M.event('mood.rules', { turn: T.n, active: T.rules });
  } else if (sceneEngine) stateNote = `[STATE: ${sceneEngine.describe(scene)}]\n`;
  history.push({ role: 'user', content: stateNote + waited + said });
  // Keep up to 24 recent messages; when over, drop back to 12 in one go. Trimming one message per turn
  // changed the start of the conversation every time, so the model re-read everything (~4.5 s).
  if (history.length > 24) { history = history.slice(-12); M.event('history.trim', { turn: T.n, kept: 12 }); }
  const messages = [{ role: 'system', content: system }, ...history];

  const prev = llmBusy;
  let release;
  llmBusy = new Promise((r) => { release = r; });
  await prev;
  let reply = '', raw = '', buf = '', replyStarted = false, playChain = Promise.resolve(), idx = 0;

  const speak = (sentence) => {
    // Never voice notes or tags the model writes by mistake ([STATE ...], #mood ..., face=..., p=0.2 ...).
    const unbracketed = sentence.replace(/\[[^\]]*\]?/g, '').replace(/\([^)]*\b(?:mood|state|face)\b[^)]*\)/gi, '');
    if (META.test(unbracketed) || looping(unbracketed) || unbracketed.replace(/[^a-z0-9]/gi, '').length < 2) { M.event('meta.dropped', { turn: T.n, text: sentence.slice(0, 120) }); return; }
    const clean = unbracketed.replace(/[*_#`>]/g, '').trim();
    const s = { i: idx++, text: clean, chars: clean.length, queuedAtMs: rel() };
    T.sentences.push(s);
    if (s.i === 0) { T.firstSentenceMs = Math.round(performance.now() - T._llmStart); }
    M.event('sentence.queued', { turn: T.n, i: s.i, chars: s.chars });
    const job = kokoroSynth(clean)
      .then((r) => {
        s.readyAtMs = rel(); s.computeMs = Math.round(r.ms); s.audioMs = Math.round((r.audio.length / r.sr) * 1000);
        s.speed = +(s.audioMs / Math.max(1, s.computeMs)).toFixed(2); s.engine = r.engine;
        if (s.i === 0) { answerReady = true; clearTimeout(fillerTimer); }
        M.event('tts.done', { turn: T.n, i: s.i, engine: r.engine, computeMs: s.computeMs, audioMs: s.audioMs });
        return r;
      })
      .catch((e) => { M.event('tts.fail', { turn: T.n, i: s.i, error: e.message }); return null; });
    playChain = playChain.then(async () => {
      const r = await job;
      if (!r || id !== active) return;
      const p = play(r, 'reply');
      s.played = true; s.playAtMs = rel() + p.startsInMs; s.gapMs = p.gapMs;
      T.underrunMs += p.gapMs;
      if (p.gapMs) M.event('gap', { turn: T.n, i: s.i, ms: p.gapMs });
      if (s.i === 0) {
        T.firstAudioMs = s.playAtMs;
        const d = M.derive(T);
        ui.lat.textContent = `Heard you in ${T.sttMs} ms. First sound after ${(d.firstSoundMs / 1000).toFixed(1)} s, answer after ${(d.firstAnswerMs / 1000).toFixed(1)} s (including the ${settings.silenceMs} ms pause)`;
      }
      ui.them.textContent = replyStarted ? `${ui.them.textContent} ${clean}` : clean;
      replyStarted = true;
      M.update(T);
    });
  };

  generating = true;
  try {
    if (id !== active) return;
    T._llmStart = performance.now();
    T.stage = 'thinking';
    M.event('llm.start', { turn: T.n, promptMessages: messages.length, promptChars: messages.reduce((n, m) => n + m.content.length, 0) });
    const stream = await engine.chat.completions.create({
      messages, stream: true, temperature: settings.temperature, max_tokens: settings.maxTokens,
      frequency_penalty: 0.2, // mild: strong penalties make small models drift into near-repeats
      ...(thinkingModel().noThink ? { extra_body: { enable_thinking: false } } : {}),
      stream_options: { include_usage: true },
    });
    let tokens = 0, thinkBuf = '', inThink = false;
    const tagF = Mood.createTagFilter();
    for await (const chunk of stream) {
      if (id !== active) { engine.interruptGenerate(); break; }
      let tok = chunk.choices?.[0]?.delta?.content || '';
      // Safety net: drop any <think>...</think> reasoning so it's never spoken.
      if (tok) {
        thinkBuf += tok; tok = '';
        while (thinkBuf) {
          if (inThink) { const e = thinkBuf.indexOf('</think>'); if (e < 0) { const k = thinkBuf.lastIndexOf('<'); thinkBuf = (k >= 0 && k > thinkBuf.length - 9) ? thinkBuf.slice(k) : ''; break; } thinkBuf = thinkBuf.slice(e + 8); inThink = false; continue; }
          const b = thinkBuf.indexOf('<think>');
          if (b < 0) { const keep = thinkBuf.lastIndexOf('<'); if (keep >= 0 && keep > thinkBuf.length - 8) { tok += thinkBuf.slice(0, keep); thinkBuf = thinkBuf.slice(keep); } else { tok += thinkBuf; thinkBuf = ''; } break; }
          tok += thinkBuf.slice(0, b); thinkBuf = thinkBuf.slice(b + 7); inThink = true;
        }
      }
      if (tok) {
        if (!tokens) { T.llmTtftMs = Math.round(performance.now() - T._llmStart); M.event('llm.first_token', { turn: T.n, ms: T.llmTtftMs }); }
        tokens++;
      }
      if (chunk.usage) {
        const u = chunk.usage, x = u.extra || {};
        T.tokens = u.completion_tokens; T.prefillTokens = u.prompt_tokens;
        T.decodeTps = x.decode_tokens_per_s != null ? +x.decode_tokens_per_s.toFixed(1) : null;
        T.prefillTps = x.prefill_tokens_per_s != null ? +x.prefill_tokens_per_s.toFixed(1) : null;
      }
      raw += tok;
      const spokenTok = tagF.push(tok);
      reply += spokenTok; buf += spokenTok;
      // Loop guard: stop the moment the reply starts repeating itself, and never voice the loop.
      if (looping(buf) || looping(reply.slice(-160))) {
        M.event('llm.loop', { turn: T.n, tail: reply.slice(-120) });
        T.loopCut = true;
        buf = cutLoop(buf);
        try { engine.interruptGenerate(); } catch {}
        break;
      }
      const [sents, rest] = popSentences(buf, false, idx === 0);
      buf = rest;
      sents.forEach(speak);
    }
    if (!inThink && thinkBuf) { raw += thinkBuf; const t = tagF.push(thinkBuf); reply += t; buf += t; thinkBuf = ''; } // flush held-back text
    { const t = tagF.flush(); reply += t; buf += t; }
    T.moodTag = tagF.tag;
    if (T.tokens == null) T.tokens = tokens;
    T.genMs = Math.round(performance.now() - T._llmStart);
    M.event('llm.done', { turn: T.n, tokens: T.tokens, ms: T.genMs, tps: T.decodeTps });
    if (T.decodeTps && T.decodeTps < 6 && T.n > 1 && !runTurn.slowWarned) {
      runTurn.slowWarned = true;
      M.event('gpu.overfull', { tps: T.decodeTps, model: device.model });
      note(`Thinking is running at ${T.decodeTps} words/s, about 10x slower than normal. Graphics memory is probably full: close other GPU-heavy apps or browser tabs and restart.`);
    }
    if (id === active) popSentences(buf, true, idx === 0)[0].forEach(speak);
  } finally {
    generating = false;
    delete T._llmStart;
    T.reply = reply.trim();
    // History keeps exactly what the model wrote (tag included) so it can reuse its cache next turn.
    history.push({ role: 'assistant', content: raw.trim() || '(interrupted)' });
    release();
  }
  if (mood) await updateMood(T);
  await playChain;
  T.totalMs = rel();
  M.update(T);
  M.event('turn.done', { turn: T.n, ms: T.totalMs, interrupted: T.interrupted });
  if (id === active) {
    turnDone = true;
    if (!playing.length) setState('listening');
  }
}

// ---------------------------------------------------------------- mic + voice detection
let frameLen, frame, fi = 0, floor = 0.006, speaking = false, loudRun = 0;
let quietMs = 0, speechMs = 0, utter = [], preroll = [];

async function startMic() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  await ctx.audioWorklet.addModule(new URL('./mic-worklet.js', import.meta.url).href);
  if (settings.vad !== 'level') startVad();
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'mic');
  const sink = ctx.createGain();
  sink.gain.value = 0;
  src.connect(node).connect(sink).connect(ctx.destination);
  frameLen = Math.round(ctx.sampleRate * 0.02);
  frame = new Float32Array(frameLen);
  node.port.onmessage = (e) => {
    const d = e.data;
    for (let i = 0; i < d.length; i++) {
      frame[fi++] = d[i];
      if (fi === frameLen) { onFrame(frame.slice()); fi = 0; }
    }
  };
}

function baseThreshold() {
  return settings.micMode === 'manual'
    ? 0.084 - (settings.micSensitivity / 100) * 0.08   // 100 -> 0.004 (sensitive), 0 -> 0.084
    : Math.max(floor * 3, 0.014);
}
export const getThreshold = (avatarTalking = playing.length > 0) => baseThreshold() * (avatarTalking ? settings.bargeLevel : 1);
export const getHearing = () => document.body.dataset.hearing === 'yes';

function micBusy() {
  // Half-duplex: while the avatar is talking or thinking (and a short tail after), don't listen.
  return settings.micHold && (playing.length > 0 || generating || state === 'thinking' || performance.now() < speakingUntil);
}

let utterMax = 0, lastBackchannel = 0;
// ---- Silero speech detection: feed it 16 kHz audio, keep its latest speech probability.
let vadWorker = null, vadReady = false, vadProb = 0, vadBuf = new Float32Array(512), vadFill = 0, vadPhase = 0;
function startVad() {
  if (vadWorker) return;
  M.event('vad.start', {});
  setTimeout(() => { if (!vadReady) M.event('vad.fail', { error: 'no answer from the speech detector after 15 s (check vendor/ort and vendor/silero files)', fallback: 'loudness' }); }, 15000);
  try {
    vadWorker = new Worker(new URL('./vad-worker.js', import.meta.url), { type: 'module' });
    vadWorker.onmessage = ({ data }) => {
      if (data.type === 'p') vadProb = data.p;
      else if (data.type === 'ready') { vadReady = true; M.event('vad.ready', { detector: 'silero' }); }
      else if (data.type === 'error') { vadReady = false; M.event('vad.fail', { error: data.error, fallback: 'loudness' }); }
    };
    vadWorker.onerror = (e) => { vadReady = false; M.event('vad.fail', { error: e.message || 'worker failed to start', fallback: 'loudness' }); };
    vadWorker.postMessage({ type: 'load' });
  } catch (e) { M.event('vad.fail', { error: e.message, fallback: 'loudness' }); }
}
function feedVad(f) {
  const step = ctx.sampleRate / 16000, span = Math.max(1, Math.round(step));
  for (; vadPhase < f.length; vadPhase += step) {
    const i = Math.floor(vadPhase);
    let acc = 0, n = 0;
    for (let k = i; k < Math.min(f.length, i + span); k++) { acc += f[k]; n++; } // average = simple low-pass
    vadBuf[vadFill++] = n ? acc / n : 0;
    if (vadFill === 512) { vadWorker.postMessage({ type: 'frame', frame: vadBuf }, [vadBuf.buffer]); vadBuf = new Float32Array(512); vadFill = 0; }
  }
  vadPhase -= f.length;
}

function onFrame(f) {
  if (muted || !engine || !ui.intro.hidden || !document.getElementById('scene-card').hidden) return; // only listen once the scene is running
  let s = 0;
  for (const x of f) s += x * x;
  const rms = Math.sqrt(s / f.length);
  micLevel = rms;
  const silero = vadReady && settings.vad !== 'level';
  if (silero) feedVad(f);
  if (micBusy()) { if (speaking) { speaking = false; loudRun = 0; } return; }
  const avatarTalking = playing.length > 0;
  if (avatarTalking && !settings.bargeIn) return;
  const thr = getThreshold(avatarTalking);
  // Speech = Silero says it's a voice (and, while the character talks, it's also loud enough to be you).
  const voiced = silero ? vadProb >= (speaking ? 0.35 : 0.5) && (!avatarTalking || rms > thr) : rms > thr;
  if (speaking) utterMax = Math.max(utterMax, rms);
  if (!speaking) {
    preroll.push(f);
    if (preroll.length > 15) preroll.shift();
    if (voiced) {
      if (++loudRun >= (silero ? 2 : 3)) {
        speaking = true; utter = preroll; preroll = []; quietMs = 0; speechMs = 60; utterMax = rms; lastBackchannel = performance.now();
        onSpeechStart();
      }
    } else {
      loudRun = 0;
      if (settings.micMode === 'auto') floor = Math.max(0.002, floor * 0.98 + rms * 0.02);
    }
    return;
  }
  utter.push(f);
  speechMs += 20;
  quietMs = (silero ? vadProb < 0.35 : rms < thr * 0.7) ? quietMs + 20 : 0;
  if (settings.backchannel && speechMs >= settings.backchannelAfterMs &&
      performance.now() - lastBackchannel >= settings.backchannelEveryMs && quietMs >= 120 && quietMs < 260) {
    lastBackchannel = performance.now();
    playBackchannel();
  }
  if (quietMs >= settings.silenceMs || speechMs >= MAX_SPEECH_MS) { speaking = false; loudRun = 0; onSpeechEnd(); }
}
export const getMicLevel = () => micLevel;
export const getFloor = () => floor;

function onSpeechStart() {
  nudgesInSilence = 0;
  markActivity();
  M.event('vad.start', { floor: +floor.toFixed(4) });
  interrupt('talked over');
  setState('listening');
  document.body.dataset.hearing = 'yes';
}

function onSpeechEnd() {
  document.body.dataset.hearing = 'no';
  const voiced = speechMs - quietMs;
  if (voiced < MIN_SPEECH_MS) { M.event('vad.ignored', { voicedMs: voiced }); return; }
  if (utterMax < baseThreshold() * 1.4) { M.event('vad.ignored', { reason: 'too quiet', peak: +utterMax.toFixed(4) }); return; }
  const t0 = performance.now();
  M.event('vad.end', { voicedMs: voiced });
  const captured = utter;
  utter = [];
  turn += 1;
  active = turn;
  turnDone = false;
  ui.them.textContent = '';
  setState('thinking');
  const myTurn = turn;
  let stage = 'resampling';
  to16kHQ(captured, ctx.sampleRate).then((audio) => { stage = 'turn'; return runTurn(myTurn, audio, { t0, speechMs: voiced }); }).catch((err) => {
    const where = stage === 'resampling' ? 'resampling' : (current?.T?.stage || 'unknown');
    const stack = String(err.workerStack || err.stack || '').split('\n').slice(0, 8).join(' | ');
    M.event('turn.error', { stage: where, worker: err.worker || null, error: err.message, stack });
    console.error('[turn.error]', where, err.worker || '', err, err.workerStack || '');
    note(`That turn failed during ${stage === 'resampling' ? 'resampling' : (current?.T?.stage || 'the turn')}: ${err.message}. Details in Stats > Log (turn.error).`);
    turnDone = true;
    setState('listening');
  });
}

// High-quality resample to 16 kHz: windowed-sinc low-pass (cutoff 7.2 kHz) before decimating,
// so high-frequency noise doesn't fold back into the speech band and consonants stay crisp.
let lpCache = { rate: 0, h: null };
function lowpassKernel(rate) {
  if (lpCache.rate === rate) return lpCache.h;
  const taps = 64, fc = 7200 / rate, h = new Float32Array(taps + 1);
  let sum = 0;
  for (let i = 0; i <= taps; i++) {
    const m = i - taps / 2;
    const sinc = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m);
    const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / taps) + 0.08 * Math.cos(4 * Math.PI * i / taps); // Blackman
    h[i] = sinc * w; sum += h[i];
  }
  for (let i = 0; i <= taps; i++) h[i] /= sum;
  lpCache = { rate, h };
  return h;
}
async function to16kHQ(frames, rate) {
  const total = frames.reduce((n, f) => n + f.length, 0);
  const all = new Float32Array(total);
  let o = 0;
  for (const f of frames) { all.set(f, o); o += f.length; }
  if (rate === 16000) return all;
  const h = lowpassKernel(rate), half = (h.length - 1) / 2;
  const L = h.length;
  const filt = (c) => {
    const k0 = c - half, i0 = k0 < 0 ? -k0 : 0, i1 = Math.min(L, total - k0);
    let acc = 0;
    for (let i = i0; i < i1; i++) acc += all[k0 + i] * h[i];
    return acc;
  };
  const ratio = rate / 16000, n = Math.floor(total / ratio), out = new Float32Array(n);
  for (let j = 0; j < n; j++) {
    const pos = j * ratio, c = Math.floor(pos), t = pos - c;
    out[j] = t < 1e-6 ? filt(c) : filt(c) * (1 - t) + filt(c + 1) * t;
  }
  // Lift quiet recordings to a healthy level for Whisper (peak ~0.9, at most 4x gain).
  let peak = 0; for (const x of out) peak = Math.max(peak, Math.abs(x));
  if (peak > 0.01 && peak < 0.5) { const g = Math.min(4, 0.9 / peak); for (let i = 0; i < out.length; i++) out[i] *= g; }
  return out;
}

function to16k(frames, rate) {
  const total = frames.reduce((n, f) => n + f.length, 0);
  const all = new Float32Array(total);
  let o = 0;
  for (const f of frames) { all.set(f, o); o += f.length; }
  const ratio = rate / 16000, n = Math.floor(total / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * ratio), b = Math.min(total, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = a; j < b; j++) sum += all[j];
    out[i] = sum / Math.max(1, b - a);
  }
  return out;
}

// ---------------------------------------------------------------- knowledge base UI
async function renderKB() {
  const list = await KB.sources();
  ui.kbList.replaceChildren(...list.map((s) => {
    const li = document.createElement('li');
    li.textContent = `${s.name} (${s.chunks} ${s.chunks === 1 ? 'section' : 'sections'})`;
    return li;
  }));
  ui.kbClear.hidden = !list.length;
  ui.kbOpen.textContent = list.length ? `Knowledge (${list.length})` : 'Knowledge';
}

ui.kbOpen.addEventListener('click', () => { renderKB(); ui.kbDialog.showModal(); });
ui.kbFiles.addEventListener('change', async () => {
  if (!speech) { ui.kbStatus.textContent = 'Start the conversation first so the reader model is loaded.'; return; }
  for (const f of ui.kbFiles.files) {
    try {
      ui.kbStatus.textContent = `Reading ${f.name}...`;
      const n = await KB.addFile(f, embedFn, (p) => { ui.kbStatus.textContent = `Indexing ${f.name}: ${Math.round(p * 100)}%`; });
      ui.kbStatus.textContent = `Added ${f.name} (${n} sections).`;
      M.event('kb.add', { file: f.name, sections: n });
    } catch (e) {
      ui.kbStatus.textContent = `Couldn't add ${f.name}: ${e.message}`;
    }
  }
  ui.kbFiles.value = '';
  renderKB();
});
ui.kbClear.addEventListener('click', async () => {
  await KB.clear();
  ui.kbStatus.textContent = 'Knowledge cleared.';
  renderKB();
});

// ---------------------------------------------------------------- character UI
// Characters come from characters/*.md (see the Character Files Spec).
const charSummary = await loadCharacters((type, data) => M.event(type, data));
rebuildActors();
if (charSummary.error) note(`No characters loaded (${charSummary.error}). Check that the "characters" folder sits next to index.html, then close the black server window and run "Start Roleplay Room.bat" again.`);
else if (charSummary.failed) note(`${charSummary.failed} character file(s) have problems. See Stats > Log (character.load.fail).`);

const presetSel = $('#char-preset');
function characterOptions(customLabel) {
  return `<option value="custom">${customLabel}</option>` +
    Object.entries(CHARACTERS).map(([k, c]) => `<option value="${k}">${c.label}</option>`).join('') +
    Object.entries(CHARACTER_ERRORS).map(([k, why]) => `<option value="${k}" disabled>${k}.md (can't load: ${why})</option>`).join('');
}
function populatePickers() {
  if (presetSel) presetSel.innerHTML = characterOptions('Custom (edit below)');
  if (typeof introSel !== 'undefined' && introSel) { introSel.innerHTML = characterOptions('Custom character (set in Character)'); syncIntroCharacter(); }
}
function fillSettings() {
  const f = ui.setForm.elements;
  if (f.preset) f.preset.value = settings.character || 'custom';
  f.name.value = settings.name;
  f.voice.value = settings.voice;
  f.speed.value = settings.speed;
  f.prompt.value = settings.prompt;
  // File characters are edited in Notepad; the dialog just shows what was loaded.
  const c = CHARACTERS[settings.character];
  for (const el of [f.name, f.voice, f.speed, f.prompt]) el.disabled = !!c;
  $('#char-file-note').hidden = !c;
  if (c) $('#char-file-name').textContent = `characters/${c.file}`;
  ui.setForm.querySelector('button[value="save"]').disabled = !!c;
  $('#settings-defaults').disabled = !!c;
}
// Switching character mid-session: use its recordings if it has them. Recording itself only happens
// at Start (Chatterbox can't share graphics memory with the loaded thinking model).
async function rebuildVoices() {
  if (!tts) return;
  runEngine = voiceEngine() === 'chatterbox' ? 'chatterbox' : 'kokoro';
  if (runEngine === 'chatterbox') {
    const { have, need } = await loadCharacterRecordings();
    if (have < need) note(`${settings.name} has ${have} of ${need} lines recorded; Kokoro speaks the rest. To record them, choose ${settings.name} on the start screen and press Start (reload the page first).`);
    device.voice = 'Recorded lines (characters folder) + Kokoro (live replies)';
  } else device.voice = settings.voiceDevice === 'cpu' ? 'Kokoro on processor' : 'Kokoro on graphics card';
  synthOpener().catch(() => {}); voiceCharacterLines();
}
if (presetSel) presetSel.addEventListener('change', () => {
  applyCharacter(presetSel.value);
  saveSettings();
  rebuildVoices(); // re-voice this character's opener, fillers, interjections and idle lines
  markInstalled();
  ui.themName.textContent = settings.name;
  syncIntroCharacter();
  fillSettings();
  M.event('character.preset', { key: presetSel.value });
});
ui.setOpen.addEventListener('click', () => { fillSettings(); ui.setDialog.showModal(); });
ui.setForm.addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'save') return;
  const f = ui.setForm.elements;
  const voiceChanged = f.voice.value !== settings.voice || Number(f.speed.value) !== settings.speed;
  // If they edited any field by hand, the character is no longer the stock preset.
  const edited = f.name.value.trim() !== settings.name || f.voice.value !== settings.voice ||
    Number(f.speed.value) !== settings.speed || f.prompt.value.trim() !== settings.prompt;
  Object.assign(settings, { name: f.name.value.trim() || DEFAULTS.name, voice: f.voice.value, speed: Number(f.speed.value), prompt: f.prompt.value.trim() || DEFAULTS.prompt });
  if (CHARACTERS[settings.character]) return; // file characters are read-only here
  saveSettings();
  ui.themName.textContent = settings.name;
  M.event('settings.character', { name: settings.name, voice: settings.voice, speed: settings.speed, character: settings.character });
  if (voiceChanged && tts) synthFillers();
});
$('#settings-defaults').addEventListener('click', () => {
  Object.assign(settings, { name: DEFAULTS.name, voice: DEFAULTS.voice, speed: DEFAULTS.speed, prompt: DEFAULTS.prompt });
  fillSettings();
});

// ---------------------------------------------------------------- controls
stage = createStage($('#stage'), mouthLevel);
setState('idle');
// Restore the active character after a reload (its fillers / interjections live in memory only).
if (CHARACTERS[settings.character]) applyCharacter(settings.character);
else if (settings.character && settings.character !== 'custom') { M.event('character.missing', { character: settings.character }); applyCharacter('custom'); saveSettings(); }
ui.themName.textContent = settings.name;
renderKB();

// Start-screen character picker.
var introSel = $('#intro-character');
function syncIntroCharacter() { introSel.value = CHARACTERS[settings.character] ? settings.character : 'custom'; }
populatePickers();
introSel.addEventListener('change', () => {
  applyCharacter(introSel.value);
  saveSettings();
  rebuildVoices();
  markInstalled(); // voice options and recordings depend on the character
  ui.themName.textContent = settings.name;
  M.event('character.preset', { key: introSel.value, from: 'start screen' });
});

// Scene card: sets the stage, then the character speaks when you press Begin.
function startScene() {
  if (mood) setFace(Mood.faceFromMood(mood.state));
  const c = CHARACTERS[settings.character];
  if (!c?.scene) { greet(); return; }
  $('#scene-title').textContent = c.scene.title;
  $('#scene-setup').textContent = c.scene.setup;
  $('#scene-goal').textContent = c.scene.goal ? `Your goal: ${c.scene.goal}` : '';
  $('#scene-go').textContent = `Begin`;
  $('#scene-card').hidden = false;
  M.event('scene.card', { character: settings.character });
}
$('#scene-go').addEventListener('click', () => {
  $('#scene-card').hidden = true;
  M.event('scene.begin', { character: settings.character });
  greet();
});
initPanel({ settings, saveSettings, defaults: DEFAULTS, device, getMicLevel, getThreshold, getHearing, turnsStarted: () => turn, characters: CHARACTERS, applyCharacter, getMood: () => mood?.state || null, onResetCharacter: resetCharacterOverrides, overrideCount });

const cbxInstalled = () => exists('./models/onnx-community/chatterbox-ONNX/resolve/main/config.json');
async function markInstalled() {
  const have = await installedThinking();
  // Voice choice: recorded lines need Chatterbox, or recordings already in the character's voice folder.
  const c = CHARACTERS[settings.character];
  const hasRec = c ? (await listRecordings(c.id)).size > 0 : false;
  const vSel = $('#voice-choice'), cbxOk = (await cbxInstalled()) || hasRec;
  vSel.querySelector('option[value="chatterbox"]').disabled = !cbxOk;
  vSel.querySelector('option[value="chatterbox"]').textContent = cbxOk ? 'Recorded lines + Kokoro live' : 'Recorded lines (needs Chatterbox)';
  if (!cbxOk && settings.voiceChoice === 'chatterbox') settings.voiceChoice = 'character';
  vSel.value = settings.voiceChoice; vSel.disabled = false;
  vSel.querySelector('option[value="character"]').textContent = `Character's choice (${settings.voiceEngine === 'chatterbox' ? 'recorded lines' : 'Kokoro'})`;
  const engine = voiceEngine() === 'chatterbox' && cbxOk ? 'chatterbox' : 'kokoro';
  const radios = [...document.querySelectorAll('input[name="thinking"]')];
  for (const r of radios) {
    const m = THINKING_MODELS.find((x) => x.key === r.value);
    const state = !have.includes(r.value) ? 'yes' : !fitsWith(m, engine) ? 'big' : 'no';
    r.disabled = state !== 'no'; r.closest('.choice').dataset.missing = state;
  }
  const pick = radios.find((r) => !r.disabled && r.value === settings.thinkingModel) || radios.find((r) => !r.disabled);
  if (pick) { pick.checked = true; settings.thinkingModel = pick.value; }
  const missing = await missingModels();
  if (!have.length) missing.push('a thinking model');
  if (missing.length) {
    ui.start.disabled = true;
    note(`Missing from the models folder: ${missing.join(', ')}. Run 'Download models.bat' once (needs internet), then reload this page.`);
    M.event('models.missing', { missing });
  }
}
// Thinking-model picker (only models that fit at full speed).
$('#thinking-list').innerHTML = THINKING_MODELS.map((m) =>
  `<label class="choice"><input type="radio" name="thinking" value="${m.key}"><span>${m.name}<br><small>${m.note}</small></span><small>${m.gb.toFixed(1)} GB</small></label>`).join('');
for (const r of document.querySelectorAll('input[name="thinking"]')) r.addEventListener('change', () => { settings.thinkingModel = r.value; saveSettings(); });
$('#voice-choice').addEventListener('change', (e) => { settings.voiceChoice = e.target.value; saveSettings(); markInstalled(); M.event('voice.choice', { choice: settings.voiceChoice, engine: voiceEngine() }); });
markInstalled();
if (!navigator.gpu) ui.gpuNote.hidden = false;

window.addEventListener('unhandledrejection', (e) => {
  M.event('error', { error: String(e.reason?.message || e.reason) });
  note(`Error: ${e.reason?.message || e.reason}`);
});
window.__roleplayReady = true;

ui.start.addEventListener('click', async () => {
  ui.start.disabled = true;
  ui.loading.hidden = false;
  document.querySelectorAll('input[name="thinking"]').forEach((r) => { r.disabled = true; });
  $('#voice-choice').disabled = true;
  setState('loading');
  try {
    ctx = new AudioContext();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.connect(ctx.destination);
    const mic = startMic().then(() => null, (e) => e);
    await loadModels();
    const micErr = await mic;
    if (micErr) throw micErr;
    ui.intro.hidden = true;
    setState('listening');
    startScene();
    if (/\b(xe-lpg|xe lpg|iris|uhd graphics|radeon.*graphics|integrated|llvmpipe|swiftshader|microsoft basic)\b/i.test(device.gpu || '')) {
      note(`Running on the integrated GPU (${device.gpu}), which is too slow for this. Set the browser to use the NVIDIA card: Windows Settings > System > Display > Graphics > pick the browser > Options > High performance, plug in the laptop, then fully quit and reopen the browser.`);
      M.event('gpu.integrated', { gpu: device.gpu });
    }
  } catch (err) {
    M.event('start.fail', { error: err.message });
    note(err.name === 'NotAllowedError'
      ? 'Microphone access was blocked. Allow it from the icon in the address bar, then reload.'
      : err.name === 'NotFoundError' || /device not found/i.test(err.message)
        ? "No microphone found. Plug in or switch on your microphone or headset (and check Windows Settings > Privacy & security > Microphone is on), then press Try again. Your recorded lines are already saved."
        : err.name === 'NotReadableError'
          ? 'The microphone is in use by another app (Teams, Zoom...) or was just unplugged. Close that app or reconnect it, then press Try again.'
          : `Couldn't start: ${err.message}`);
    ui.start.disabled = false;
    ui.start.textContent = 'Try again';
    markInstalled();
    setState('idle');
  }
});

ui.stop.addEventListener('click', () => interrupt('stop button'));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !document.querySelector('dialog[open]')) interrupt('escape key');
});

ui.mute.addEventListener('click', () => {
  muted = !muted;
  ui.mute.setAttribute('aria-pressed', String(muted));
  ui.mute.textContent = muted ? 'Unmute mic' : 'Mute mic';
  M.event('mic', { muted });
});

ui.reset.addEventListener('click', () => {
  interrupt('new conversation');
  history = []; saidWhileWaiting = [];
  if (mood) { Mood.resetMood(mood); M.event('mood.reset', { state: { ...mood.state } }); }
  if (sceneEngine) { scene = sceneEngine.create(); scriptIndex = {}; renderHud(); }
  ui.you.textContent = ''; ui.them.textContent = ''; ui.lat.textContent = '';
  turnDone = true;
  M.event('conversation.reset');
  setState(engine ? 'listening' : 'idle');
  startScene();
});

async function greet() {
  if (!settings.greeting || !tts) return;
  ui.them.textContent = settings.greeting;
  history.push({ role: 'assistant', content: settings.greeting });
  M.event('greeting', { text: settings.greeting });
  if (openerFor !== settings.greeting + '|' + settings.voice + '|' + settings.speed + '|' + runEngine) {
    M.event('greeting.voice.late', {}); // character changed after loading: voice it now
    try { await synthOpener(); } catch {}
  }
  for (const clip of openerClips) play(clip, 'reply');
}

ui.file.addEventListener('change', async () => {
  const f = ui.file.files[0];
  if (!f) return;
  try { await stage.loadVRM(URL.createObjectURL(f)); note(''); }
  catch (err) { note(`Couldn't load that avatar: ${err.message}`); }
});

// An app-wide avatar.vrm is used for characters that don't have their own.
fetch('./avatar.vrm', { method: 'HEAD' })
  .then((r) => { globalAvatar = r.ok; avatarNow = null; applyAvatar(CHARACTERS[settings.character]); })
  .catch(() => {});

// Reload characters from disk after editing a file in Notepad.
// Re-read every character file (after editing in Notepad, or after creating one).
async function reloadCharacters() {
  const r = await loadCharacters((type, data) => M.event(type, data));
  rebuildActors(); // actors pick up the edited files
  applyCharacter(CHARACTERS[settings.character] ? settings.character : 'custom');
  saveSettings();
  populatePickers();
  fillSettings();
  ui.themName.textContent = settings.name;
  rebuildVoices();
  markInstalled();
  library?.render();
  return r;
}
$('#char-reload').addEventListener('click', async () => {
  const btn = $('#char-reload');
  btn.disabled = true; btn.textContent = 'Reloading...';
  const r = await reloadCharacters();
  btn.disabled = false;
  btn.textContent = `Reloaded ${r.loaded}${r.failed ? `, ${r.failed} with problems` : ''}`;
  setTimeout(() => { btn.textContent = 'Reload characters'; }, 3000);
});

// ---- Character library (start screen)
// Every pre-made line a character file asks for (same rules as scriptedLines, from the file itself).
function profileLines(c) {
  const opener = (c.greeting || '').match(/[^.!?\u2026]+[.!?\u2026]*/g) || [];
  const all = [...opener, ...(c.fillerLines || Object.values(FILLERS_DEFAULT).flat()), ...(c.backchannel || BACKCHANNELS_DEFAULT),
    ...(c.idleLines || []), ...(c.cutoffLines || []), ...Object.values(c.script || {}).flat()];
  return { texts: [...new Set(all.map(cleanLine).filter(Boolean))], opener: opener.length };
}
async function characterStatus(id) {
  const c = CHARACTERS[id], { texts, opener } = profileLines(c);
  const eff = (k) => (overrides[id] || {})[k] ?? profileValue(id, k);
  const files = await listRecordings(id);
  const recorded = texts.filter((t) => files.has(lineHash(['chatterbox', eff('voice'), eff('voiceSample') || '-', (+eff('expressiveness') || 0).toFixed(1), t].join('|')))).length;
  return { lines: texts.length, recorded, opener, recordable: c.voiceEngine === 'chatterbox' || recorded > 0 };
}
async function createCharacter(name) {
  const id = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'character';
  if (CHARACTERS[id]) throw new Error(`There's already a character called ${id}.`);
  const tr = await fetch('./characters/_template/character.md', { cache: 'no-store' });
  if (!tr.ok) throw new Error('The template (characters/_template/character.md) is missing.');
  const text = (await tr.text()).replace(/\bNAME\b/g, name);
  const r = await fetch(`./characters/${id}/character.md`, { method: 'PUT', body: text, headers: { 'Content-Type': 'text/markdown' } });
  if (r.status === 409) throw new Error(`characters\\${id} already exists.`);
  if (!r.ok) throw new Error(`Couldn't create it (HTTP ${r.status}). Start the app with Start Roleplay Room.bat.`);
  M.event('character.created', { id, name });
  await reloadCharacters();
  introSel.value = id; introSel.dispatchEvent(new Event('change'));
  note(`Created characters\\${id}\\character.md. Open it in Notepad, fill in each section, save, then press Reload characters.`);
  return id;
}
let library = null;
library = initLibrary({
  el: $('#library'), characters: CHARACTERS, errors: CHARACTER_ERRORS, engines: ENGINES,
  status: characterStatus, selected: () => settings.character,
  onPick: (id) => { introSel.value = id; introSel.dispatchEvent(new Event('change')); },
  onCreate: createCharacter, onReload: reloadCharacters,
});
library.render();

// Tuning: river display on/off, and re-recording the scripted lines.
document.getElementById('tuning').addEventListener('input', (e) => { if (e.target.name === 'showHud') renderHud(); });
document.getElementById('rerecord').addEventListener('click', async () => {
  const c = CHARACTERS[settings.character];
  if (!c) return;
  if (!confirm(`Delete all ${settings.name}'s recorded lines in characters/${c.id}/voice? They'll be recorded again with Chatterbox at the next Start.`)) return;
  const n = await deleteRecordings(c.id); recordings.clear();
  M.event('lines.cleared', { count: n });
  note(`Deleted ${n} recorded lines. They'll be recorded again at the next Start.`);
});
