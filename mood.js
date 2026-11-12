// Mood engine: a character's feelings as four numbers that persist across turns.
//   pleasure  -1..1   bitter <-> warm
//   stress     0..1   calm <-> panicked
//   dominance -1..1   pleading <-> assertive
//   trust   -100..100 distrust <-> relies on you
// Each turn the character judges what you did (a hidden #mood tag after its reply), the change is
// applied with inertia, and the values drift back toward the character's baseline.

export const AXES = ['pleasure', 'stress', 'dominance', 'trust'];
const RANGE = { pleasure: [-1, 1], stress: [0, 1], dominance: [-1, 1], trust: [-100, 100] };
export const ACTS = ['helped', 'reassured', 'neutral', 'stalled', 'confused', 'risky', 'harmful', 'mocked'];
export const FACES = ['neutral', 'panicked', 'relieved', 'suspicious', 'deadpan', 'happy', 'sad', 'angry'];
const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));

export function createMood(def) {
  const base = { pleasure: 0, stress: 0.3, dominance: 0, trust: 0, ...(def?.baseline || {}) };
  return {
    base, state: { ...base },
    resilience: def?.resilience ?? 0.3, // 0 = every event lands fully, 1 = unshakeable
    recovery: def?.recovery ?? 0.15,    // share of the gap back to baseline closed each turn
  };
}

export function resetMood(m) { m.state = { ...m.base }; }

// E_t = clamp(E_{t-1} + recovery * (E_base - E_{t-1}) + (1 - resilience) * delta)
export function applyDelta(m, delta = {}) {
  const before = { ...m.state };
  for (const a of AXES) {
    const d = Number(delta[a]) || 0;
    const v = m.state[a] + m.recovery * (m.base[a] - m.state[a]) + (1 - m.resilience) * d;
    m.state[a] = +clamp(v, RANGE[a]).toFixed(a === 'trust' ? 1 : 3);
  }
  return { before, after: { ...m.state } };
}

// Rules like "when stress > 0.75 and pleasure < -0.4: Sentences under 8 words."
export function parseRule(line) {
  const m = line.match(/^\s*when\s+(.+?)\s*:\s*(.+)$/i);
  if (!m) return { error: `doesn't start with "when ... :"` };
  const conds = [];
  for (const part of m[1].split(/\s+and\s+/i)) {
    const c = part.trim().match(/^(pleasure|stress|dominance|trust)\s*(<=|>=|<|>)\s*(-?\d+(?:\.\d+)?)$/i);
    if (!c) return { error: `can't read condition "${part.trim()}" (use e.g. stress > 0.7)` };
    conds.push({ axis: c[1].toLowerCase(), op: c[2], val: Number(c[3]) });
  }
  return { conds, text: m[2].trim() };
}

const test = (v, op, x) => (op === '>' ? v > x : op === '<' ? v < x : op === '>=' ? v >= x : v <= x);
export const activeRules = (m, rules = []) => rules.filter((r) => r.conds.every((c) => test(m.state[c.axis], c.op, c.val)));

// Plain-English summary so the model doesn't have to interpret raw numbers.
export function describe(s) {
  const w = [];
  w.push(s.stress > 0.8 ? 'at breaking point' : s.stress > 0.6 ? 'very stressed' : s.stress > 0.35 ? 'tense' : 'calm');
  w.push(s.pleasure < -0.5 ? 'miserable' : s.pleasure < -0.15 ? 'unhappy' : s.pleasure > 0.5 ? 'delighted' : s.pleasure > 0.15 ? 'pleased' : 'mixed');
  w.push(s.dominance < -0.5 ? 'helpless' : s.dominance < -0.15 ? 'unsure of yourself' : s.dominance > 0.5 ? 'in charge' : s.dominance > 0.15 ? 'assertive' : 'steady');
  const t = s.trust < -40 ? 'you distrust the stranger' : s.trust < -10 ? 'you are wary of the stranger' : s.trust > 40 ? 'you rely on the stranger' : s.trust > 10 ? 'you are starting to trust the stranger' : 'you are unsure about the stranger';
  return `${w.join(', ')}; ${t}`;
}

// Expression when the character didn't pick one: derived from the mood.
export function faceFromMood(s) {
  if (s.stress > 0.7 && s.pleasure < 0) return 'panicked';
  if (s.trust < -30) return 'suspicious';
  if (s.pleasure > 0.4) return s.stress < 0.4 ? 'happy' : 'relieved';
  if (s.pleasure < -0.4) return s.dominance > 0.2 ? 'angry' : 'sad';
  return 'neutral';
}

// Instruction added to the character's static prompt (static so the model can reuse its cache).
export const TAG_INSTRUCTIONS = `AFTER EVERY REPLY, on a new line, add one hidden tag judging what the stranger just did. It is never spoken. Exactly this shape:
#mood <act> p=<change> s=<change> d=<change> t=<change> face=<face>
- act: one of ${ACTS.join(', ')}
- p = pleasure change (-0.5 to 0.5), s = stress change (-0.5 to 0.5), d = dominance change (-0.5 to 0.5), t = trust change (-20 to 20)
- face: one of ${FACES.join(', ')}
Example: #mood risky p=-0.3 s=0.3 d=-0.1 t=-8 face=panicked`;

// Parse "#mood risky p=-0.3 s=+0.2 d=0 t=-8 face=panicked" (forgiving about order and spacing).
export function parseTag(text) {
  const m = String(text).match(/#mood\b([^\n]*)/i);
  if (!m) return null;
  const body = m[1];
  const act = (body.match(/\b([a-z]+)\b/i)?.[1] || '').toLowerCase();
  const num = (k) => { const x = body.match(new RegExp(`\\b${k}\\s*=\\s*([+-]?\\d*\\.?\\d+)`, 'i')); return x ? Number(x[1]) : 0; };
  const face = (body.match(/\bface\s*=\s*([a-z]+)/i)?.[1] || '').toLowerCase();
  return {
    act: ACTS.includes(act) ? act : 'neutral',
    delta: {
      pleasure: clamp(num('p'), [-0.5, 0.5]), stress: clamp(num('s'), [-0.5, 0.5]),
      dominance: clamp(num('d'), [-0.5, 0.5]), trust: clamp(num('t'), [-20, 20]),
    },
    face: FACES.includes(face) ? face : null,
  };
}

// Streaming filter: lets spoken text through, captures a "#mood ..." line wherever it appears
// (normally at the end, sometimes first), even when "#mood" is split across chunks.
export function createTagFilter() {
  let held = '', inTag = false, tag = '';
  return {
    push(chunk) {
      let out = '';
      held += chunk;
      while (held) {
        if (inTag) {
          const nl = held.indexOf('\n');
          if (nl < 0) { tag += held; held = ''; break; }
          tag += held.slice(0, nl); held = held.slice(nl + 1); inTag = false; continue;
        }
        const i = held.search(/#mood\b/i);
        if (i >= 0) { out += held.slice(0, i); held = held.slice(i); inTag = true; continue; }
        const h = held.lastIndexOf('#');
        if (h >= 0 && held.length - h < 6) { out += held.slice(0, h); held = held.slice(h); break; } // maybe "#mo..."
        out += held; held = '';
      }
      return out;
    },
    flush() { const out = inTag ? '' : held; if (inTag) tag += held; held = ''; return out; },
    get tag() { return tag ? '#mood' + tag.replace(/^#mood/i, '') : ''; },
  };
}

// ---- Fallback appraisal when the model leaves out the #mood tag (small models often do).
// The character's own reply shows how it took your move, so we compare it with example reactions
// using the knowledge-base reader model (sentence embeddings). No extra delay, works with any model.
export const ACT_EXAMPLES = {
  harmful: ['No! What have you done? That is a disaster!', 'You will get us killed, are you insane?', 'Oh no, no, no, that is terrible!', 'You lunatic, it is ruined!'],
  risky: ['Wait, are you sure about that? That sounds dangerous.', 'I do not like this, it could go badly wrong.', 'Careful, careful, that might not work!'],
  helped: ['Oh thank god, that worked! Thank you!', 'Yes! That is right, well done!', 'Phew, it is safe, thank you so much.'],
  reassured: ['Okay... okay, I feel a little better now.', 'Alright, I trust you, let us keep going.', 'You are right, I can do this.'],
  stalled: ['Hurry up, please, we do not have time!', 'Why are you just standing there? Do something!', 'Please, say something, anything!'],
  mocked: ['Are you laughing at me? This is not funny!', 'Do not make jokes, this is serious!', 'How can you joke at a time like this?'],
  confused: ['What? I do not understand what you mean.', 'Huh? What are you talking about?', 'I am sorry, what did you say?'],
  neutral: ['Right. So what do we do next?', 'Okay, tell me the next step.', 'Fine, go on then.'],
};
export const ACT_EFFECT = {
  harmful:   { delta: { pleasure: -0.35, stress: 0.35, dominance: -0.1, trust: -12 }, face: 'panicked' },
  risky:     { delta: { pleasure: -0.15, stress: 0.2, dominance: 0, trust: -5 }, face: 'suspicious' },
  helped:    { delta: { pleasure: 0.3, stress: -0.25, dominance: 0.05, trust: 10 }, face: 'relieved' },
  reassured: { delta: { pleasure: 0.2, stress: -0.2, dominance: 0.05, trust: 6 }, face: 'relieved' },
  stalled:   { delta: { pleasure: -0.1, stress: 0.15, dominance: -0.05, trust: -3 }, face: 'angry' },
  mocked:    { delta: { pleasure: -0.3, stress: 0.1, dominance: 0.15, trust: -15 }, face: 'angry' },
  confused:  { delta: { pleasure: -0.05, stress: 0.1, dominance: -0.05, trust: -2 }, face: 'suspicious' },
  neutral:   { delta: { pleasure: 0, stress: 0, dominance: 0, trust: 0 }, face: null },
};
let exampleVecs = null;
export async function appraiseFromReply(reply, embedFn) {
  if (!reply || !reply.trim()) return null;
  if (!exampleVecs) {
    const acts = Object.keys(ACT_EXAMPLES), all = acts.flatMap((a) => ACT_EXAMPLES[a].map((t) => [a, t]));
    const vecs = await embedFn(all.map(([, t]) => t));
    exampleVecs = all.map(([a], i) => [a, vecs[i]]);
  }
  const [v] = await embedFn([reply]);
  const best = {};
  for (const [a, e] of exampleVecs) { let d = 0; for (let i = 0; i < v.length; i++) d += v[i] * e[i]; best[a] = Math.max(best[a] ?? -1, d); }
  const ranked = Object.entries(best).sort((x, y) => y[1] - x[1]);
  const [act, score] = ranked[0];
  if (score < 0.3) return { act: 'neutral', score: +score.toFixed(3), ...ACT_EFFECT.neutral };
  // Scale the effect by how clearly the reply matches (0.3 -> half strength, 0.6+ -> full).
  const k = Math.min(1, 0.5 + (score - 0.3) / 0.6);
  const d = ACT_EFFECT[act].delta;
  return { act, score: +score.toFixed(3), face: ACT_EFFECT[act].face,
    delta: { pleasure: d.pleasure * k, stress: d.stress * k, dominance: d.dominance * k, trust: d.trust * k } };
}
