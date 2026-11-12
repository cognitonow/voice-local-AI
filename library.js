// Character library on the start screen: one card per character with its status, a profile check,
// and creating a new character from the template. app.js supplies the data and actions.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const SECTION_HELP = {
  scene: 'Scene card text', goal: 'Goal on the scene card', opener: 'First words', personality: 'Who they are',
  'situation rules': 'What they know and how they react', never: 'Hard limits', interjections: 'While you talk',
  fillers: 'While thinking', 'idle lines': 'When you go quiet', 'cut off': 'When you talk over them',
  knowledge: 'Background facts', mood: 'Feelings', 'mood rules': 'Behaviour by mood', script: 'Scripted reactions',
};

export function initLibrary({ el, characters, errors, engines, status, selected, onPick, onCreate, onReload }) {
  const dlg = document.getElementById('profile-dialog');
  const newDlg = document.getElementById('new-char-dialog');
  let current = selected();

  async function render() {
    current = selected();
    const ids = Object.keys(characters).sort((a, b) => characters[a].name.localeCompare(characters[b].name));
    const cards = [];
    for (const id of ids) {
      const c = characters[id], st = await status(id);
      const badges = [];
      if (c.puzzle) badges.push(`<span class="badge">${esc(engines[c.puzzle]?.name || c.puzzle)}</span>`);
      if (c.mood) badges.push('<span class="badge">Mood</span>');
      if (st.recordable) badges.push(st.recorded >= st.lines
        ? `<span class="badge ok">Voice recorded</span>`
        : `<span class="badge warn" title="Recorded at the next Start with Chatterbox">${st.recorded ? `${st.recorded} of ${st.lines} recorded` : 'Not recorded yet'}</span>`);
      if (c.hasAvatar) badges.push('<span class="badge">Own 3D model</span>');
      if (c.warnings.length) badges.push(`<span class="badge warn">${c.warnings.length} warning${c.warnings.length > 1 ? 's' : ''}</span>`);
      const setup = typeof c.scene === 'string' ? c.scene : (c.scene?.setup || '');
      const scene = setup.split(/(?<=[.!?])\s/).slice(0, 2).join(' ');
      cards.push(`<div class="card${id === current ? ' on' : ''}" data-id="${esc(id)}" role="button" tabindex="0" aria-pressed="${id === current}">
        <b>${esc(c.name)}</b><span class="sub">${esc(c.label.replace(/^[^—-]*[—-]\s*/, '') || '')}</span>
        ${scene ? `<p>${esc(scene)}</p>` : ''}
        <div class="badges">${badges.join('')}</div>
        <button type="button" class="details" data-details="${esc(id)}">Details</button></div>`);
    }
    for (const [id, why] of Object.entries(errors)) {
      cards.push(`<div class="card broken" aria-disabled="true"><b>${esc(id)}</b><span class="sub">Can't be used</span><p>${esc(why)}</p></div>`);
    }
    cards.push(`<div class="card${current === 'custom' ? ' on' : ''}" data-id="custom" role="button" tabindex="0"><b>Custom</b><span class="sub">Write your own in Character</span><p>A plain conversation partner you describe yourself.</p></div>`);
    cards.push(`<div class="card add" data-new role="button" tabindex="0"><b>+ New character</b><span class="sub">Starts a folder from the template</span></div>`);
    el.innerHTML = `<div class="lib-head"><span>${ids.length} character${ids.length === 1 ? '' : 's'}</span><button type="button" data-reload>Reload characters</button></div><div class="cards">${cards.join('')}</div>`;
  }

  el.addEventListener('click', async (e) => {
    const det = e.target.closest('[data-details]');
    if (det) { e.stopPropagation(); return showDetails(det.dataset.details); }
    if (e.target.closest('[data-reload]')) { e.target.disabled = true; e.target.textContent = 'Reloading...'; await onReload(); return render(); }
    if (e.target.closest('[data-new]')) { newDlg.querySelector('input').value = ''; newDlg.querySelector('.msg').textContent = ''; return newDlg.showModal(); }
    const card = e.target.closest('.card[data-id]');
    if (card) { onPick(card.dataset.id); render(); }
  });
  el.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.card')) { e.preventDefault(); e.target.click(); } });

  async function showDetails(id) {
    const c = characters[id], st = await status(id);
    const all = Object.keys(SECTION_HELP);
    const rows = all.map((s) => `<tr><td>${c.sectionsFound.includes(s) ? '&#10003;' : '<span class="dim">&ndash;</span>'}</td><td>## ${esc(s[0].toUpperCase() + s.slice(1))}</td><td class="dim">${SECTION_HELP[s]}</td></tr>`).join('');
    const counts = [['Opener sentences', st.opener], ['Interjections', c.backchannel?.length || 0], ['Fillers', c.fillerLines?.length || 0], ['Idle lines', c.idleLines?.length || 0],
      ['Cut-off lines', c.cutoffLines?.length || 0], ['Script lines', Object.values(c.script || {}).flat().length], ['Knowledge files', c.knowledgeFiles.length]];
    dlg.querySelector('.body').innerHTML = `
      <h2>${esc(c.name)}</h2><p class="dim">${esc(c.file.includes('/') ? `characters\\${c.file.replace(/\//g, '\\')}` : `characters\\${c.file}`)}</p>
      <div class="facts">
        <div><span>Scene engine</span><b>${c.puzzle ? esc(engines[c.puzzle]?.name || c.puzzle) : 'None (thinking model only)'}</b></div>
        <div><span>Voice</span><b>${esc(c.voice || 'default')}${c.voiceEngine === 'chatterbox' ? ' + recorded lines' : ''}</b></div>
        <div><span>Recordings</span><b>${st.recorded} of ${st.lines} lines</b></div>
        <div><span>3D model</span><b>${c.hasAvatar ? 'Own (avatar.vrm)' : 'Built-in figure'}</b></div>
      </div>
      <h3>Lines</h3><div class="facts">${counts.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('')}</div>
      <h3>Sections</h3><table>${rows}</table>
      <h3>Warnings</h3>${c.warnings.length ? `<ul>${c.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : '<p class="dim">None.</p>'}`;
    dlg.showModal();
  }

  newDlg.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (e.submitter?.value === 'cancel') return newDlg.close();
    const name = newDlg.querySelector('input').value.trim();
    const msg = newDlg.querySelector('.msg');
    if (!name) { msg.textContent = 'Give the character a name.'; return; }
    msg.textContent = 'Creating...';
    try { const id = await onCreate(name); newDlg.close(); await render(); showDetails(id); }
    catch (err) { msg.textContent = err.message; }
  });

  return { render };
}
