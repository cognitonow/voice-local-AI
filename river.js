// The fox / duck / grain river crossing, tracked by the app so the rules are never got wrong.
// Banks: 'near' (where everything starts) and 'far'. The character rides in the boat every trip,
// so whichever bank the boat leaves has nobody watching it.

export const ITEMS = ['fox', 'duck', 'grain'];
export const NAMES = { fox: 'the fox', duck: 'Doris', grain: 'the grain' };

// Script events a character file can give lines for (## Script > ### event).
export const EVENTS = [
  'across_duck', 'across_fox', 'across_grain', 'across_alone',
  'back_duck', 'back_fox', 'back_grain', 'back_alone',
  'deadly_fox_duck', 'deadly_duck_grain', 'not_here', 'too_many', 'win',
];

// What each event does to the character's mood (same scale as a #mood tag).
export const EFFECT = {
  across_duck: { act: 'helped', delta: { pleasure: 0.25, stress: -0.2, dominance: 0.05, trust: 8 }, face: 'relieved' },
  across_fox: { act: 'helped', delta: { pleasure: 0.2, stress: -0.15, dominance: 0.05, trust: 7 }, face: 'relieved' },
  across_grain: { act: 'helped', delta: { pleasure: 0.2, stress: -0.15, dominance: 0.05, trust: 7 }, face: 'relieved' },
  across_alone: { act: 'stalled', delta: { pleasure: -0.1, stress: 0.1, dominance: 0, trust: -3 }, face: 'suspicious' },
  back_duck: { act: 'risky', delta: { pleasure: -0.1, stress: 0.1, dominance: -0.05, trust: -2 }, face: 'suspicious' },
  back_fox: { act: 'risky', delta: { pleasure: -0.1, stress: 0.1, dominance: 0, trust: -3 }, face: 'suspicious' },
  back_grain: { act: 'risky', delta: { pleasure: -0.1, stress: 0.1, dominance: 0, trust: -3 }, face: 'suspicious' },
  back_alone: { act: 'reassured', delta: { pleasure: 0.05, stress: -0.05, dominance: 0, trust: 2 }, face: 'neutral' },
  deadly_fox_duck: { act: 'harmful', delta: { pleasure: -0.45, stress: 0.45, dominance: -0.1, trust: -15 }, face: 'panicked' },
  deadly_duck_grain: { act: 'harmful', delta: { pleasure: -0.35, stress: 0.35, dominance: -0.05, trust: -12 }, face: 'angry' },
  not_here: { act: 'confused', delta: { pleasure: -0.05, stress: 0.1, dominance: 0.05, trust: -3 }, face: 'suspicious' },
  too_many: { act: 'confused', delta: { pleasure: -0.05, stress: 0.1, dominance: 0.05, trust: -2 }, face: 'suspicious' },
  win: { act: 'helped', delta: { pleasure: 0.5, stress: -0.5, dominance: 0.2, trust: 20 }, face: 'happy' },
};

// Words people (and Whisper) use for each thing. Includes common mishearings of "Doris".
const WORDS = {
  fox: ['fox', "fox's", 'foxy', 'fax', 'fuchs', 'fogs', 'folks', 'box'],
  duck: ['duck', 'ducks', 'ducky', 'duckie', 'doris', "doris's", 'dorris', 'dolores', 'dollars', 'taurus', 'doras', 'dock', 'deck', 'tuck', 'tag', 'dug'],
  grain: ['grain', 'grains', 'sack', 'seed', 'seeds', 'wheat', 'corn', 'bag'],
};
const ALONE = /\b(alone|nothing|empty|by (my|your)self|just (me|you)|on (my|your) own|nobody|no one|empty[- ]handed)\b/;
const MOVE = /\b(take|taking|took|bring|bringing|carry|carrying|row|rowing|move|moving|put|load|ferry|send|grab|cross|crossing|go|going|come|coming|head|return|returning|over|across|back)\b/;
const QUESTION = /\b(should|what if|which|why|how|would|could|is it (safe|ok|okay)|do you think)\b/;
const LEAVE = /\b(leave|leaving|keep|keeping|stays?|staying|not|without|except)\s+(the\s+|my\s+|your\s+)?([a-z']+)/g;

export function createRiver() { return { items: { fox: 'near', duck: 'near', grain: 'near' }, boat: 'near', moves: 0, solved: false }; }
const other = (b) => (b === 'near' ? 'far' : 'near');
const itemOf = (w) => ITEMS.find((it) => WORDS[it].includes(w));

// Decide whether an utterance is a move. Returns null (not a move: let the model answer) or
// { kind: 'move', cargo: 'fox'|'duck'|'grain'|null } / { kind: 'not_here', cargo } / { kind: 'too_many', cargo: [...] }.
export function parseMove(text, river) {
  const t = ' ' + String(text).toLowerCase().replace(/[^a-z' -]/g, ' ').replace(/\s+/g, ' ') + ' ';
  if (river.solved || QUESTION.test(t) || !MOVE.test(t)) return null;
  const excluded = new Set();
  for (const m of t.matchAll(LEAVE)) { const it = itemOf(m[3]); if (it) excluded.add(it); }
  const mentioned = [...new Set(t.split(' ').map(itemOf).filter(Boolean))].filter((it) => !excluded.has(it));
  if (mentioned.length > 1) return { kind: 'too_many', cargo: mentioned };
  if (mentioned.length === 1) {
    const cargo = mentioned[0];
    return river.items[cargo] === river.boat ? { kind: 'move', cargo } : { kind: 'not_here', cargo };
  }
  // No item: "go back alone", "row back", "come back" all mean an empty trip.
  if (ALONE.test(t) || /\b(go|row|come|head|return|going|rowing|coming) (back|over|across)\b/.test(t)) return { kind: 'move', cargo: null };
  return null;
}

// Apply a parsed move. Returns { event, river } (river is the new state; a deadly move resets it).
export function applyMove(river, mv) {
  if (mv.kind !== 'move') return { event: mv.kind, river };
  const from = river.boat, to = other(from);
  const next = { ...river, items: { ...river.items }, boat: to, moves: river.moves + 1 };
  if (mv.cargo) next.items[mv.cargo] = to;
  const left = ITEMS.filter((it) => next.items[it] === from); // unattended bank
  if (left.includes('fox') && left.includes('duck')) return { event: 'deadly_fox_duck', river: createRiver(), lost: next };
  if (left.includes('duck') && left.includes('grain')) return { event: 'deadly_duck_grain', river: createRiver(), lost: next };
  if (ITEMS.every((it) => next.items[it] === 'far')) return { event: 'win', river: { ...next, solved: true } };
  return { event: `${to === 'far' ? 'across' : 'back'}_${mv.cargo || 'alone'}`, river: next };
}

export function describe(river) {
  const on = (b) => ITEMS.filter((it) => river.items[it] === b).map((it) => NAMES[it]);
  const list = (a) => (a.length ? a.join(' and ') : 'nothing');
  return `This side of the river: ${list(on('near'))}. Far side: ${list(on('far'))}. The boat (with you in it) is on ${river.boat === 'near' ? 'this' : 'the far'} side.${river.solved ? ' All three are safely across: it is over.' : ''}`;
}
