// Per-turn measurements and an event log, kept in memory and exportable.
export const turns = [];
export const log = [];
const listeners = new Set();
const T0 = performance.now();

export const on = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = (kind, item) => listeners.forEach((fn) => fn(kind, item));

export function event(type, data = {}) {
  const e = { ...data, t: Math.round(performance.now() - T0), at: new Date().toISOString(), type };
  log.push(e);
  if (log.length > 5000) log.shift();
  emit('log', e);
  return e;
}

export function newTurn(fields) {
  const t = { n: turns.length + 1, at: new Date().toISOString(), sentences: [], interrupted: false, underrunMs: 0, ...fields };
  turns.push(t);
  emit('turn', t);
  return t;
}

export const update = (t) => emit('turn', t);

export function clear() {
  turns.length = 0;
  log.length = 0;
  emit('clear');
}

// Derived numbers used by the panel and exports.
export function derive(t) {
  const firstSentence = t.sentences[0];
  const voiceMs = firstSentence?.computeMs ?? null;
  const thinkMs = t.firstSentenceMs ?? null; // LLM start -> first speakable sentence
  const heardFirst = [t.fillerAtMs, t.firstAudioMs].filter((x) => x != null);
  const spoken = t.sentences.filter((s) => s.computeMs);
  const audio = spoken.reduce((a, s) => a + s.audioMs, 0), compute = spoken.reduce((a, s) => a + s.computeMs, 0);
  return {
    firstSoundMs: heardFirst.length ? Math.min(...heardFirst) + (t.endWaitMs || 0) : null,
    firstAnswerMs: t.firstAudioMs != null ? t.firstAudioMs + (t.endWaitMs || 0) : null,
    parts: {
      'End-of-turn wait': t.endWaitMs ?? 0,
      Transcription: t.sttMs ?? 0,
      Knowledge: t.kbMs ?? 0,
      Thinking: thinkMs ?? 0,
      Voice: voiceMs ?? 0,
    },
    voiceSpeed: compute ? audio / compute : null,
  };
}

const CSV_COLS = ['n', 'at', 'text', 'reply', 'model', 'voiceDevice', 'userSpeechMs', 'audioSec', 'endWaitMs', 'sttMs', 'kbMs', 'kbHitCount',
  'llmTtftMs', 'firstSentenceMs', 'tokens', 'prefillTokens', 'prefillTps', 'decodeTps', 'genMs', 'filler', 'fillerAtMs',
  'firstAudioMs', 'firstSoundMs', 'firstAnswerMs', 'voiceSpeed', 'underrunMs', 'interrupted', 'interruptedAtMs', 'totalMs',
  'act', 'face', 'stress', 'pleasure', 'dominance', 'trust', 'rules'];

export function toCSV() {
  const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const rows = turns.map((t) => {
    const d = derive(t);
    const row = { ...t, ...(t.mood || {}), rules: t.rules?.join(' / '), kbHitCount: t.kbHits?.length ?? 0, firstSoundMs: d.firstSoundMs, firstAnswerMs: d.firstAnswerMs, voiceSpeed: d.voiceSpeed?.toFixed(2) };
    return CSV_COLS.map((c) => esc(row[c])).join(',');
  });
  return [CSV_COLS.join(','), ...rows].join('\n');
}

export function toJSON(extra = {}) {
  return JSON.stringify({ exportedAt: new Date().toISOString(), ...extra, turns, log }, null, 2);
}

export function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
