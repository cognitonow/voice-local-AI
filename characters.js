import { parseRule, AXES } from './mood.js';
import { ENGINES, engineEvents } from './engines.js';

// Characters are Markdown files in ./characters/. This module finds them, parses them and
// turns each one into the shape the app uses. See the Character Files Spec for the format.

export const CHARACTERS = {};      // id -> character (valid ones only)
export const CHARACTER_ERRORS = {}; // id -> reason, for files that can't be used

// Added to every character's instructions so each file only holds what is unique to it.
const SPEAKING_STYLE = `HOW YOU SPEAK (always):
- You are speaking out loud. Reply in one to three short spoken sentences.
- Write ONLY the words you say aloud. Never describe actions or gestures, never write anything in [brackets], (parentheses) or *asterisks*: a line like [grabs the bag] is wrong.
- Only mention things that are really in the scene; never invent objects or people.
- No lists, markdown or emojis.
- Never use assistant phrases such as "as an AI", "I'm here to help" or "great question".
- Stay in character no matter what the other person says.`;

const FIELDS = {
  // file field     -> [app field, type]
  name: ['name', 'text'],
  label: ['label', 'text'],
  voice: ['voice', 'text'],
  speed: ['speed', 'number'],
  temperature: ['temperature', 'number'],
  max_reply: ['maxTokens', 'number'],
  listening_cue: ['nodStyle', 'cue'],
  pause_ms: ['silenceMs', 'number'],
  filler_ms: ['fillerMs', 'number'],
  interject_after_ms: ['backchannelAfterMs', 'number'],
  interject_every_ms: ['backchannelEveryMs', 'number'],
  idle_after_ms: ['idleAfterMs', 'number'],
  idle_every_ms: ['idleEveryMs', 'number'],
  listen_for: ['listenFor', 'text'],
  voice_engine: ['voiceEngine', 'engine'],
  expressiveness: ['expressiveness', 'number'],
  voice_sample: ['voiceSample', 'text'],
  puzzle: ['puzzle', 'text'],
};
const SECTIONS = ['scene', 'goal', 'opener', 'personality', 'situation rules', 'never',
  'interjections', 'fillers', 'idle lines', 'cut off', 'knowledge', 'mood', 'mood rules', 'script'];

// Ask the local server for the files in a folder. Works with Start Roleplay Room.bat (JSON)
// and falls back to a plain HTML directory page (e.g. python -m http.server).
async function listFolder(path) {
  const r = await fetch(path, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${path} returned ${r.status}`);
  const text = await r.text();
  try { const j = JSON.parse(text); return { files: j.files || [], dirs: j.dirs || [] }; }
  catch { return { files: [...text.matchAll(/href="([^"?#/]+\.[a-z0-9]+)"/gi)].map((m) => decodeURIComponent(m[1])), dirs: [] }; }
}
const listOrEmpty = (p) => listFolder(p).catch(() => ({ files: [], dirs: [] }));

export function parseCharacter(id, src, log = () => {}) {
  src = src.replace(/\r\n?/g, '\n');
  const out = { id, warnings: [] };
  const warn = (msg) => { out.warnings.push(msg); log(msg); };

  // Settings block between the first two --- lines.
  const fm = src.match(/^\s*---\n([\s\S]*?)\n---\n?/);
  let body = src;
  if (fm) {
    body = src.slice(fm[0].length);
    for (const line of fm[1].split('\n')) {
      const m = line.match(/^\s*([A-Za-z_]+)\s*:\s*(.*?)\s*$/);
      if (!m) { if (line.trim()) warn(`ignored settings line: "${line.trim()}"`); continue; }
      const [, key, raw] = m;
      const val = raw.replace(/^["']|["']$/g, '');
      const def = FIELDS[key.toLowerCase()];
      if (!def) { warn(`unknown setting "${key}" ignored`); continue; }
      const [field, type] = def;
      if (type === 'number') {
        const n = Number(val);
        if (val === '' || Number.isNaN(n)) { warn(`"${key}: ${val}" is not a number, using the default`); continue; }
        out[field] = n;
      } else if (type === 'engine') {
        if (!['kokoro', 'chatterbox'].includes(val)) { warn(`voice_engine must be kokoro or chatterbox, using kokoro`); continue; }
        out[field] = val;
      } else if (type === 'cue') {
        if (!['nod', 'shake'].includes(val)) { warn(`listening_cue must be nod or shake, using nod`); continue; }
        out[field] = val;
      } else out[field] = val;
    }
  } else warn('no settings block (--- lines) found');

  // ## sections.
  const sections = {};
  let current = null;
  for (const line of body.split('\n')) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      const name = h[1].toLowerCase();
      if (SECTIONS.includes(name)) { current = name; sections[name] = []; }
      else { current = null; warn(`unknown section "## ${h[1]}" ignored`); }
      continue;
    }
    if (current) sections[current].push(line);
  }
  const text = (k) => (sections[k] || []).join('\n').trim();
  const bullets = (k) => (sections[k] || [])
    .map((l) => l.match(/^\s*[-*]\s+(.*\S)\s*$/)?.[1]).filter(Boolean);

  out.greeting = text('opener');
  const personality = text('personality');
  const rules = bullets('situation rules');
  const never = bullets('never');

  if (sections.scene) {
    const lines = text('scene').split('\n').map((l) => l.trim()).filter(Boolean);
    out.scene = { title: lines[0] || out.name || id, setup: lines.slice(1).join(' '), goal: text('goal') };
  }
  out.backchannel = bullets('interjections');
  out.fillerLines = bullets('fillers');
  out.idleLines = bullets('idle lines');
  out.cutoffLines = bullets('cut off');
  if (!out.cutoffLines.length) delete out.cutoffLines;
  out.knowledge = text('knowledge');
  if (!out.backchannel.length) delete out.backchannel;
  if (!out.fillerLines.length) delete out.fillerLines;
  if (!out.idleLines.length) delete out.idleLines;

  const listen = (out.listenFor || '').split(',').map((w) => w.trim()).filter(Boolean);
  const listening = `WHAT YOU HEAR:
- The other person's words come from speech recognition and can be misheard, especially names.
- If something sounds odd, assume they meant the closest thing that makes sense in the scene, and carry on.${listen.length ? `
- Words that often get misheard here: ${listen.join(', ')}. Anything that sounds like one of them means that word.` : ''}`;
  // ## Mood: baseline feelings + how they change.  ## Mood rules: "when stress > 0.75: ..." lines.
  if (sections.mood) {
    const mood = { baseline: {}, resilience: 0.3, recovery: 0.15 };
    for (const line of sections.mood) {
      const kv = line.match(/^\s*[-*]?\s*([a-z]+)\s*:\s*(-?\d+(?:\.\d+)?)\s*$/i);
      if (!kv) { if (line.trim()) warn(`## Mood: can't read "${line.trim()}" (use e.g. stress: 0.8)`); continue; }
      const k = kv[1].toLowerCase(), v = Number(kv[2]);
      if (AXES.includes(k)) mood.baseline[k] = v;
      else if (k === 'resilience' || k === 'recovery') mood[k] = Math.min(1, Math.max(0, v));
      else warn(`## Mood: unknown "${k}" (use pleasure, stress, dominance, trust, resilience, recovery)`);
    }
    out.mood = mood;
    out.moodRules = [];
    for (const b of bullets('mood rules')) {
      const r = parseRule(b);
      if (r.error) warn(`## Mood rules: "${b}" ${r.error}`); else out.moodRules.push(r);
    }
  }

  // ## Script: "### event" headings, each followed by one or more lines (bullets) to say.
  if (out.puzzle && !ENGINES[out.puzzle]) { warn(`unknown puzzle "${out.puzzle}" (known: ${Object.keys(ENGINES).join(', ')})`); delete out.puzzle; }
  if (sections.script) {
    const known = engineEvents(out.puzzle);
    out.script = {};
    let ev = null;
    for (const line of sections.script) {
      const h = line.match(/^###\s+(\S+)\s*$/);
      if (h) { ev = h[1].toLowerCase(); if (!known.includes(ev)) warn(`## Script: unknown event "${ev}"${out.puzzle ? '' : ' (no puzzle: set, so nothing will trigger it)'}`); out.script[ev] = []; continue; }
      const b = line.match(/^\s*[-*]\s+(.*\S)\s*$/);
      if (b && ev) out.script[ev].push(b[1]);
    }
    const missing = known.filter((e) => !out.script[e]?.length);
    if (missing.length) warn(`## Script: no lines for ${missing.join(', ')} (the thinking model will improvise those)`);
  }

  out.sectionsFound = Object.keys(sections);
  out.prompt = [
    personality,
    rules.length ? `THE SITUATION:\n${rules.map((r) => `- ${r}`).join('\n')}` : '',
    never.length ? `NEVER:\n${never.map((r) => `- ${r}`).join('\n')}` : '',
    listening,
    SPEAKING_STYLE,
    out.mood || out.puzzle ? `Each message from the stranger may start with a [STATE] note: how you feel right now and where things stand. Let it shape what you say. Never read it out, repeat it or mention it. Only ever write the words you say out loud.` : '',
  ].filter(Boolean).join('\n\n');

  // Required pieces.
  const missing = [];
  if (!out.name) missing.push('name');
  if (!out.greeting) missing.push('## Opener');
  if (!personality) missing.push('## Personality');
  if (missing.length) out.error = `missing ${missing.join(', ')}`;
  out.label = out.label || out.name || id;
  out.promptWords = out.prompt.split(/\s+/).length;
  return out;
}

// Load every characters/*.md. Returns a summary; logs each file through `log(event, data)`.

// A character is either a folder  characters/<id>/character.md  (+ voice/, knowledge/, avatar.vrm)
// or, the older way, a single file  characters/<id>.md  (+ optional characters/<id>/ for knowledge).
// Names starting with _ (like _template) are skipped.
export async function loadCharacters(log = () => {}) {
  for (const k of Object.keys(CHARACTERS)) delete CHARACTERS[k];
  for (const k of Object.keys(CHARACTER_ERRORS)) delete CHARACTER_ERRORS[k];
  const base = `${location.origin}/characters/`;
  let top;
  try { top = await listFolder(base); }
  catch (e) { return { loaded: 0, failed: 0, error: `${e.message}. Start the app with Start Roleplay Room.bat` }; }
  const skip = (n) => /^[_.]/.test(n);
  const profiles = new Map(); // id -> { layout, url }
  for (const d of top.dirs.filter((d) => !skip(d))) {
    const inside = await listOrEmpty(`${base}${encodeURIComponent(d)}/`);
    if (inside.files.some((f) => f.toLowerCase() === 'character.md')) profiles.set(d.toLowerCase(), { layout: 'folder', dir: d, inside });
  }
  for (const f of top.files.filter((f) => /\.md$/i.test(f) && !skip(f))) {
    const id = f.replace(/\.md$/i, '').toLowerCase();
    if (profiles.has(id)) { log('character.warn', { file: f, msg: `ignored: characters/${id}/character.md is used instead` }); continue; }
    profiles.set(id, { layout: 'file', file: f });
  }

  for (const [id, p] of [...profiles.entries()].sort()) {
    const file = p.layout === 'folder' ? `${p.dir}/character.md` : p.file;
    try {
      const r = await fetch(base + file.split('/').map(encodeURIComponent).join('/'), { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const c = parseCharacter(id, await r.text(), (msg) => log('character.warn', { file, msg }));
      c.file = file; c.layout = p.layout; c.dir = `characters/${p.layout === 'folder' ? p.dir : id}/`;
      // Knowledge: <id>/knowledge/*.md|txt, plus loose .md/.txt files in <id>/ (older layout).
      const folder = p.inside || await listOrEmpty(`${base}${encodeURIComponent(id)}/`);
      const sources = [
        ...folder.files.filter((f) => /\.(md|txt)$/i.test(f) && f.toLowerCase() !== 'character.md').map((f) => f),
        ...(folder.dirs.includes('knowledge') ? (await listOrEmpty(`${base}${encodeURIComponent(id)}/knowledge/`)).files.filter((f) => /\.(md|txt)$/i.test(f)).map((f) => `knowledge/${f}`) : []),
      ];
      c.knowledgeFiles = [];
      for (const f of sources) {
        const kr = await fetch(`${base}${encodeURIComponent(id)}/${f.split('/').map(encodeURIComponent).join('/')}`, { cache: 'no-store' });
        if (kr.ok) c.knowledgeFiles.push({ name: f, text: await kr.text() });
      }
      c.hasAvatar = folder.files.some((f) => f.toLowerCase() === 'avatar.vrm');
      if (c.error) {
        CHARACTER_ERRORS[id] = c.error;
        log('character.load.fail', { file, reason: c.error });
      } else {
        CHARACTERS[id] = c;
        log('character.load', { file, name: c.name, layout: c.layout, warnings: c.warnings.length, puzzle: c.puzzle || null, avatar: c.hasAvatar,
          lines: { interjections: c.backchannel?.length || 0, fillers: c.fillerLines?.length || 0, idle: c.idleLines?.length || 0, script: Object.values(c.script || {}).flat().length },
          knowledge: (c.knowledge ? 1 : 0) + c.knowledgeFiles.length });
      }
    } catch (e) {
      CHARACTER_ERRORS[id] = e.message;
      log('character.load.fail', { file, reason: e.message });
    }
  }
  return { loaded: Object.keys(CHARACTERS).length, failed: Object.keys(CHARACTER_ERRORS).length };
}
