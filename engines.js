// Scene engines: optional logic a character's scene runs on (set with `puzzle: <id>` in its file).
// Every engine has the same shape, so the app never needs to know which one it's talking to:
//   events            names a character's ## Script can give lines for
//   effects[event]    { act, delta, face } mood change for that event
//   create()          a fresh scene state
//   handle(text, s)   null if what was said isn't for the engine, else { event, state, detail }
//   describe(s)       plain-English state for the thinking model
//   hud(s)            HTML for the on-screen scene panel (or '' for none)
//   done(s)           true once the scene is finished (stops idle prompts)
import * as River from './river.js';

const river = {
  id: 'river-crossing',
  name: 'River crossing',
  events: River.EVENTS,
  effects: River.EFFECT,
  create: () => River.createRiver(),
  handle(text, s) {
    const mv = River.parseMove(text, s);
    if (!mv) return null;
    const r = River.applyMove(s, mv);
    return { event: r.event, state: r.river, detail: mv };
  },
  describe: River.describe,
  done: (s) => !!s.solved,
  hud(s) {
    const label = { fox: 'Fox', duck: 'Doris', grain: 'Grain' };
    const on = (b) => River.ITEMS.filter((it) => s.items[it] === b).map((it) => label[it]);
    const bank = (b, name) => `<div class="bank${s.boat === b ? ' boat' : ''}"><span>${name}${s.boat === b ? ' &middot; boat' : ''}</span><b>${on(b).join(', ') || '&ndash;'}</b></div>`;
    return bank('near', 'This side') + '<div class="water" aria-hidden="true"></div>' + bank('far', 'Far side') + (s.solved ? '<p>All safely across</p>' : '');
  },
};

export const ENGINES = { [river.id]: river };
export const engineEvents = (id) => ENGINES[id]?.events || [];
