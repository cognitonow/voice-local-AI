import * as M from './metrics.js';

const PART_COLORS = {
  'End-of-turn wait': '#6c7a80', Transcription: '#8fd6c6', Knowledge: '#5fa8d3', Thinking: '#b7a8e6', Voice: '#f0b45a',
};
const TIPS = {
  'End-of-turn wait': 'Lower "End-of-turn pause" in Tuning. Too low and it may cut you off mid-sentence.',
  Transcription: 'Speak in shorter turns, or close other GPU-heavy tabs.',
  Knowledge: 'Lower "Knowledge sections" in Tuning, or remove large documents.',
  Thinking: 'Try the Fastest model, lower "Knowledge sections", or keep "Start speaking at first comma" on.',
  Voice: 'Try "Voice engine: processor" in Tuning so the voice stops competing with the thinking model for the GPU.',
};
const fmtS = (ms) => (ms == null ? '-' : `${(ms / 1000).toFixed(1)} s`);
const fmtMs = (ms) => (ms == null ? '-' : `${Math.round(ms)} ms`);
const avg = (xs) => { const v = xs.filter((x) => x != null && !Number.isNaN(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function initPanel({ settings, saveSettings, defaults, device, getMicLevel, getThreshold, getHearing, turnsStarted, characters, applyCharacter, getMood = () => null, onResetCharacter = () => {}, overrideCount = () => 0 }) {
  const $ = (s) => document.querySelector(s);
  const panel = $('#panel');
  const toggle = $('#stats-open');
  let tab = 'live';

  const setOpen = (open) => {
    panel.hidden = !open;
    document.body.dataset.panel = open ? 'open' : 'closed';
    toggle.setAttribute('aria-pressed', String(open));
    if (open) { renderAll(); meter(); }
  };
  toggle.addEventListener('click', () => setOpen(panel.hidden));
  $('#panel-close').addEventListener('click', () => setOpen(false));

  for (const b of panel.querySelectorAll('[role="tab"]')) {
    b.addEventListener('click', () => {
      tab = b.dataset.tab;
      if (tab === 'tuning') show();
      panel.querySelectorAll('[role="tab"]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
      panel.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== tab; });
      if (tab === 'live') { renderLive(); meter(); }
      if (tab === 'log') renderLog();
    });
  }

  // ------------------------------------------------------------ charts
  Chart.defaults.color = '#9fb4b1';
  Chart.defaults.borderColor = 'rgba(223,232,229,0.1)';
  Chart.defaults.font.family = getComputedStyle(document.documentElement).fontFamily;
  const waitChart = new Chart($('#c-wait'), {
    type: 'bar',
    data: { labels: [], datasets: Object.entries(PART_COLORS).map(([label, c]) => ({ label, data: [], backgroundColor: c, borderRadius: 2 })) },
    options: {
      animation: false, maintainAspectRatio: false,
      scales: { x: { stacked: true }, y: { stacked: true, title: { display: true, text: 'seconds' } } },
      plugins: { legend: { labels: { boxWidth: 10, font: { size: 11 } } }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.raw.toFixed(2)} s` } } },
    },
  });
  const speedChart = new Chart($('#c-speed'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { label: 'Thinking (tokens/s)', data: [], borderColor: '#b7a8e6', backgroundColor: '#b7a8e6', yAxisID: 'y', tension: 0.25 },
        { label: 'Voice (x real time)', data: [], borderColor: '#f0b45a', backgroundColor: '#f0b45a', yAxisID: 'y1', tension: 0.25 },
      ],
    },
    options: {
      animation: false, maintainAspectRatio: false,
      scales: {
        y: { position: 'left', title: { display: true, text: 'tokens/s' }, beginAtZero: true },
        y1: { position: 'right', title: { display: true, text: 'x real time' }, beginAtZero: true, grid: { drawOnChartArea: false } },
      },
      plugins: { legend: { labels: { boxWidth: 10, font: { size: 11 } } } },
    },
  });

  // ------------------------------------------------------------ live
  function renderLive() {
    const done = M.turns.filter((t) => !t.empty && t.text);
    const last = done[done.length - 1];
    const d = last ? M.derive(last) : null;
    const all = done.map((t) => ({ t, d: M.derive(t) }));
    const tiles = [
      ['First sound', fmtS(d?.firstSoundMs), fmtS(avg(all.map((x) => x.d.firstSoundMs))), 'From when you stop talking to the first sound back (filler or answer).'],
      ['First answer', fmtS(d?.firstAnswerMs), fmtS(avg(all.map((x) => x.d.firstAnswerMs))), 'From when you stop talking to the first words of the real answer.'],
      ['Transcription', fmtMs(last?.sttMs), fmtMs(avg(done.map((t) => t.sttMs))), 'Time to turn your speech into text.'],
      ['Thinking starts', fmtMs(last?.llmTtftMs), fmtMs(avg(done.map((t) => t.llmTtftMs))), 'Time until the model produces its first word (reading the prompt).'],
      ['Thinking speed', last?.decodeTps ? `${last.decodeTps} tok/s` : '-', avg(done.map((t) => t.decodeTps)) ? `${avg(done.map((t) => t.decodeTps)).toFixed(1)} tok/s` : '-', 'How fast the model writes. Speech needs roughly 4 tokens/s to keep up.'],
      ['Voice speed', d?.voiceSpeed ? `${d.voiceSpeed.toFixed(1)}x` : '-', avg(all.map((x) => x.d.voiceSpeed)) ? `${avg(all.map((x) => x.d.voiceSpeed)).toFixed(1)}x` : '-', 'Seconds of speech made per second of work. Below 1x causes gaps.'],
      ['Gaps in speech', fmtMs(last?.underrunMs), fmtMs(avg(done.map((t) => t.underrunMs))), 'Silence between sentences while waiting for the next one.'],
      ['Interruptions', String(M.turns.filter((t) => t.interrupted).length), null, 'Times you talked over it or pressed Stop.', `in ${done.length} turns`],
      ...(getMood() ? [['Mood now', device.face || 'neutral', null, 'The character\'s current feelings (from its ## Mood section).',
        `stress ${getMood().stress.toFixed(2)}, trust ${Math.round(getMood().trust)}`]] : []),
    ];
    $('#kpis').innerHTML = tiles.map(([k, v, a, help, sub]) => `<div class="kpi" title="${esc(help)}"><span>${k}</span><strong>${v}</strong><small>${sub || `avg ${a}`}</small></div>`).join('');

    if (d) {
      const [worst, ms] = Object.entries(d.parts).sort((a, b) => b[1] - a[1])[0];
      $('#bottleneck').innerHTML = `<strong>Biggest delay last turn: ${worst} (${fmtS(ms)}).</strong> ${esc(TIPS[worst])}`;
    } else {
      $('#bottleneck').textContent = 'Talk to the avatar and the numbers will appear here.';
    }

    const recent = done.slice(-20);
    waitChart.data.labels = recent.map((t) => `#${t.n}`);
    waitChart.data.datasets.forEach((ds) => { ds.data = recent.map((t) => (M.derive(t).parts[ds.label] || 0) / 1000); });
    waitChart.update();
    speedChart.data.labels = recent.map((t) => `#${t.n}`);
    speedChart.data.datasets[0].data = recent.map((t) => t.decodeTps ?? null);
    speedChart.data.datasets[1].data = recent.map((t) => M.derive(t).voiceSpeed ?? null);
    speedChart.update();

    // Mood over the scene: point 0 = start of the first turn, then after each turn.
    const withMood = M.turns.filter((t) => t.mood);
    moodTurns = withMood.length ? [{ mood: withMood[0].moodBefore, act: null }, ...withMood] : [];
    moodChart.data.labels = moodTurns.map((_, i) => (i === 0 ? 'start' : `#${withMood[i - 1].n}`));
    const series = (k, f = 1) => moodTurns.map((t) => (t.mood ? +(t.mood[k] / f).toFixed(3) : null));
    moodChart.data.datasets[0].data = series('stress');
    moodChart.data.datasets[1].data = series('pleasure');
    moodChart.data.datasets[2].data = series('dominance');
    moodChart.data.datasets[3].data = series('trust', 100);
    moodChart.update();
    $('#mood-wrap').hidden = !getMood();

    $('#device').innerHTML = [['Thinking model', device.model], ['Transcription', device.transcription], ['Voice', device.voice], ['Graphics', device.gpu]]
      .map(([k, v]) => `<dt>${k}</dt><dd>${esc(v || 'not loaded yet')}</dd>`).join('');
  }

  let meterOn = false;
  function meter() {
    if (meterOn) return;
    meterOn = true;
    const bar = $('#mic-bar'), mark = $('#mic-mark'), readout = $('#mic-readout');
    const scale = (v) => `${Math.min(100, Math.sqrt(v / 0.15) * 100)}%`;
    const step = () => {
      if (panel.hidden || tab !== 'live') { meterOn = false; return; }
      const lvl = getMicLevel(), thr = getThreshold(false);
      bar.style.width = scale(lvl);
      bar.classList.toggle('hot', lvl >= thr);
      mark.style.left = scale(thr);
      const turns = turnsStarted();
      readout.textContent = getHearing() ? 'Hearing you now' : lvl >= thr ? 'Above the line' : 'Below the line (quiet)';
      const diag = $('#mic-diag');
      if (turns === 0) {
        diag.hidden = false;
        diag.textContent = lvl >= thr
          ? "Your voice crosses the line, but no turn has finished. If thinking never starts, lower the end-of-turn pause in Tuning, or there may be steady background noise keeping it from hearing you stop."
          : "Your voice isn't crossing the line, so no turn ever starts. Switch Mic mode to Manual in Tuning and raise sensitivity until speaking fills past the line and silence stays left of it.";
      } else diag.hidden = true;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  const moodChart = new Chart($('#c-mood'), {
    type: 'line',
    data: { labels: [], datasets: [
      { label: 'Stress', data: [], borderColor: '#e07a5f', backgroundColor: '#e07a5f', tension: 0.25 },
      { label: 'Pleasure', data: [], borderColor: '#8fd6c6', backgroundColor: '#8fd6c6', tension: 0.25 },
      { label: 'Dominance', data: [], borderColor: '#b7a8e6', backgroundColor: '#b7a8e6', tension: 0.25 },
      { label: 'Trust (/100)', data: [], borderColor: '#f0b45a', backgroundColor: '#f0b45a', tension: 0.25 },
    ] },
    options: {
      animation: false, maintainAspectRatio: false,
      scales: { y: { min: -1, max: 1 } },
      plugins: { legend: { labels: { boxWidth: 10, font: { size: 11 } } },
        tooltip: { callbacks: { afterTitle: (items) => { const t = moodTurns[items[0].dataIndex]; return t?.act ? `judged: ${t.act}, face: ${t.face}` : (t ? 'start' : ''); } } } },
    },
  });
  let moodTurns = [];

  // ------------------------------------------------------------ transcript
  function turnHTML(t) {
    const d = M.derive(t);
    const said = t.text ? `"${esc(t.text)}"` : '<em>transcribing...</em>';
    const kb = t.kbHits?.length ? `<p class="meta">Knowledge used: ${t.kbHits.map((h) => `${esc(h.source)} (${h.score})`).join(', ')}</p>` : '';
    const filler = t.filler ? `<p class="filler">Filler at ${fmtS(t.fillerAtMs + t.endWaitMs)}: "${esc(t.filler)}"</p>` : '';
    const sents = t.sentences.map((s) => `<span class="${s.played ? '' : 'cut'}" title="${s.computeMs ? `voice ${s.computeMs} ms for ${s.audioMs} ms of audio` : 'not spoken'}">${esc(s.text)}</span>`).join(' ');
    const reply = t.empty ? '<p class="meta">Nothing recognisable was said.</p>'
      : `<p><b>${esc(settings.name || 'Avatar')}</b> ${sents || (t.text ? '<em>thinking...</em>' : '')}${t.interrupted ? ` <span class="tag">interrupted (${esc(t.interruptReason)})</span>` : ''}</p>`;
    const f2 = (v) => (v == null ? '?' : (+v).toFixed(2));
    const scriptLine = t.scripted ? `<p class="mood">Move: <strong>${esc(t.scripted.replace(/_/g, ' '))}</strong>${t.sentences[0]?.engine ? ` (${esc(t.sentences[0].engine)})` : ''}<br>${esc(t.banks || '')}</p>` : '';
    const moodLine = t.mood ? `<p class="mood">Judged <strong>${esc(t.act || 'no tag')}</strong>${t.appraisedBy === 'reply' ? ' (from her reply; the model gave no tag)' : t.appraisedBy === 'script' ? ' (scripted)' : ''}, face ${esc(t.face)}: stress ${f2(t.moodBefore?.stress)}&rarr;${f2(t.mood.stress)}, pleasure ${f2(t.moodBefore?.pleasure)}&rarr;${f2(t.mood.pleasure)}, trust ${Math.round(t.moodBefore?.trust ?? 0)}&rarr;${Math.round(t.mood.trust)}${t.rules?.length ? `<br>Rules in force: ${t.rules.map(esc).join(' / ')}` : ''}</p>` : '';
    const nums = [
      `speech ${fmtS(t.userSpeechMs)}`, `transcribed ${fmtMs(t.sttMs)}`,
      d.firstAnswerMs != null ? `first answer ${fmtS(d.firstAnswerMs)}` : null,
      t.tokens != null ? `${t.tokens} tokens${t.decodeTps ? ` at ${t.decodeTps} tok/s` : ''}` : null,
      t.underrunMs ? `gaps ${fmtMs(t.underrunMs)}` : null,
      t.totalMs != null ? `total ${fmtS(t.totalMs)}` : null,
    ].filter(Boolean).join(', ');
    return `<li id="t-${t.n}"><header><b>#${t.n}</b> <time>${new Date(t.at).toLocaleTimeString()}</time></header>
      <p><b>You</b> ${said}</p>${kb}${filler}${reply}${scriptLine}${moodLine}<p class="meta">${nums}</p></li>`;
  }
  function renderTurn(t) {
    const list = $('#transcript');
    const el = document.getElementById(`t-${t.n}`);
    const html = turnHTML(t);
    if (el) el.outerHTML = html; else list.insertAdjacentHTML('beforeend', html);
    if (tab === 'transcript') list.lastElementChild?.scrollIntoView({ block: 'end' });
  }

  // ------------------------------------------------------------ log
  const logEl = $('#log');
  const filterEl = $('#log-filter');
  const passes = (e) => {
    const f = filterEl.value;
    if (f === 'problems') return /interrupt|fail|error|gap|ignored|empty/.test(e.type);
    if (f === 'pipeline') return !/^state$|^vad\./.test(e.type);
    return true;
  };
  const line = (e) => {
    const { t, at, type, ...rest } = e;
    const div = document.createElement('div');
    div.className = `ev ${/interrupt|fail|error/.test(type) ? 'bad' : /gap|filler/.test(type) ? 'warn' : ''}`;
    div.textContent = `${(t / 1000).toFixed(3).padStart(9)}s  ${type.padEnd(16)} ${Object.keys(rest).length ? JSON.stringify(rest) : ''}`;
    return div;
  };
  function renderLog() {
    logEl.replaceChildren(...M.log.filter(passes).slice(-600).map(line));
    logEl.scrollTop = logEl.scrollHeight;
  }
  filterEl.addEventListener('change', renderLog);

  // ------------------------------------------------------------ updates
  let liveQueued = false;
  M.on((kind, item) => {
    if (kind === 'clear') { $('#transcript').innerHTML = ''; renderAll(); return; }
    if (kind === 'turn') {
      renderTurn(item);
      if (!panel.hidden && tab === 'live' && !liveQueued) { liveQueued = true; requestAnimationFrame(() => { liveQueued = false; renderLive(); }); }
    }
    if (kind === 'log' && !panel.hidden && tab === 'log' && passes(item)) {
      const stick = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 20;
      logEl.appendChild(line(item));
      while (logEl.childElementCount > 800) logEl.firstElementChild.remove();
      if (stick) logEl.scrollTop = logEl.scrollHeight;
    }
  });
  function renderAll() { renderLive(); if (tab === 'log') renderLog(); }

  // ------------------------------------------------------------ tuning
  const form = $('#tuning');
  const fields = ['silenceMs', 'fillerMs', 'bargeLevel', 'maxTokens', 'kbTopK', 'micSensitivity'];
  const updateScope = () => {
    const n = overrideCount();
    $('#tuning-scope').innerHTML = `Timing and voice settings here are for <b>${esc(settings.name)}</b> only` +
      (n ? `: <b>${n}</b> changed from ${settings.character === 'custom' ? 'the defaults' : 'the character file'}. "Reset to defaults" puts them back.` : ', and match ' + (settings.character === 'custom' ? 'the defaults.' : 'the character file.')) +
      ' Microphone and display settings apply to every character.';
  };
  const show = () => {
    updateScope();
    const f = form.elements;
    for (const k of fields) { f[k].value = settings[k] < 0 ? f[k].value : settings[k]; }
    f.backchannel.checked = settings.backchannel;
    f.idleNudge.checked = settings.idleNudge;
    f.micMode.value = settings.micMode;
    f.micSensitivity.disabled = settings.micMode !== 'manual';
    form.querySelector('[data-out="micSensitivity"]').textContent = settings.micMode === 'manual' ? `${settings.micSensitivity}` : 'auto';
    f.useFiller.checked = settings.fillerMs >= 0;
    f.fillerMs.disabled = settings.fillerMs < 0;
    f.micWhileTalking.value = settings.micHold ? 'wait' : 'interrupt';
    f.bargeLevel.disabled = settings.micHold;
    f.earlyChunk.checked = settings.earlyChunk;
    f.emotionSpeed.checked = settings.emotionSpeed;
    f.showHud.checked = settings.showHud;
    f.vad.value = settings.vad || 'silero';
    f.voiceDevice.value = settings.voiceDevice || 'gpu';
    f.expressiveness.value = settings.expressiveness;
    form.querySelector('[data-out="expressiveness"]').textContent = Number(settings.expressiveness).toFixed(1);
    form.querySelector('[data-out="silenceMs"]').textContent = `${settings.silenceMs} ms`;
    form.querySelector('[data-out="fillerMs"]').textContent = settings.fillerMs < 0 ? 'off' : `${settings.fillerMs} ms`;
    form.querySelector('[data-out="bargeLevel"]').textContent = `${Number(settings.bargeLevel).toFixed(1)}x`;
    form.querySelector('[data-out="maxTokens"]').textContent = `${settings.maxTokens} tokens`;
    form.querySelector('[data-out="kbTopK"]').textContent = String(settings.kbTopK);
  };
  form.addEventListener('change', () => setTimeout(updateScope, 0));
  form.addEventListener('input', (e) => {
    const f = form.elements;
    settings.backchannel = f.backchannel.checked;
    settings.idleNudge = f.idleNudge.checked;
    settings.micMode = f.micMode.value;
    settings.micSensitivity = Number(f.micSensitivity.value);
    settings.silenceMs = Number(f.silenceMs.value);
    settings.fillerMs = f.useFiller.checked ? Number(f.fillerMs.value) : -1;
    settings.micHold = f.micWhileTalking.value === 'wait';
    settings.bargeIn = !settings.micHold;
    settings.bargeLevel = Number(f.bargeLevel.value);
    settings.maxTokens = Number(f.maxTokens.value);
    settings.kbTopK = Number(f.kbTopK.value);
    settings.earlyChunk = f.earlyChunk.checked;
    settings.emotionSpeed = f.emotionSpeed.checked;
    settings.showHud = f.showHud.checked;
    settings.vad = f.vad.value;
    settings.voiceDevice = f.voiceDevice.value;
    settings.expressiveness = Number(f.expressiveness.value);
    saveSettings();
    show();
    if (e.type === 'input') M.event('tuning', { field: e.target.name, value: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  });
  $('#tuning-defaults').addEventListener('click', () => {
    for (const k of ['bargeIn', 'bargeLevel', 'kbTopK', 'micMode', 'micSensitivity', 'micHold', 'backchannel', 'idleNudge', 'emotionSpeed', 'showHud']) settings[k] = defaults[k];
    onResetCharacter(); // this character's timings and voice back to its file
    saveSettings(); show();
    M.event('tuning.reset');
  });
  show();

  // ------------------------------------------------------------ export
  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  $('#export-json').addEventListener('click', () => M.download(`roleplay-room-${stamp()}.json`, M.toJSON({ settings, device }), 'application/json'));
  $('#export-csv').addEventListener('click', () => M.download(`roleplay-room-turns-${stamp()}.csv`, M.toCSV(), 'text/csv'));
  $('#clear-stats').addEventListener('click', () => M.clear());

  renderLive();
}
