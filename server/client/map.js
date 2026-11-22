// Episode map (11 Nov 2026): look a show up from its wco link, tick episodes, fill them, watch the squares.
// Server: GET /show, GET /series-search, POST /fill, GET /fill/jobs, POST /fill/jobs/:id/cancel|retry, GET /followed, POST /follow.
// Critique fixes (same day): swaps are named and confirmed, phones can scroll, roving tab stops per season,
// screen-reader state on every square, errors stay on screen, Sub mode never offers dub swaps, quiet seasons fold.
(() => {
  const $ = (id) => document.getElementById(id);
  const UI = window.wcoUI;
  const pad = (n) => String(n).padStart(2, '0');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (s) => (s ? new Date(s + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'not set');
  const audioName = (a) => (!a ? 'unknown' : a.split('/').map((x) => ({ eng: 'English', jpn: 'Japanese' }[x] || x)).join(' and '));
  const lang = () => $('lang').querySelector('[aria-pressed=true]').dataset.v;
  // In Sub mode a Japanese-audio file is what you want, so only missing episodes need work.
  const wanted = (e) => e.st === 'missing' || (e.st === 'undub' && lang() === 'dub');
  const actionable = (e) => !e.nowco && wanted(e);
  // Needs work, but wcostream cannot supply it: a state of its own, said on the square ("n/a"), in its label and in its tooltip.
  const offWco = (e) => !!e.nowco && wanted(e);
  // A file whose audio is not labelled may already be English: it is never part of "select all" or a season click,
  // and the overnight run leaves it alone, but it can be picked by hand to replace it with the dub.
  const isSwap = (e) => e.st === 'undub' || e.st === 'unknown';
  const pickable = (e) => actionable(e) || (e.st === 'unknown' && lang() === 'dub');
  const FILL_LABEL = { queued: 'queue', importing: 'import', done: 'done', premium: 'Sonarr', kept: 'check', failed: 'fail', cancelled: '' };
  const ACTIVE = ['queued', 'downloading', 'importing'];
  const STATE_WORDS = { dub: 'in library, English audio', undub: 'in library, another language only', unknown: 'in library, audio not labelled', missing: 'missing', future: 'not aired yet' };

  let show = null, eps = [], fills = new Map(), confirmSwap = false;
  const sel = new Set(), open = new Set();
  let anchor = null, drag = null, lastPointer = 'mouse';

  async function api(method, url, body) {
    const r = await window.wcoBusy(url, fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }));
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.message ? [].concat(data.message).join('; ') : `The server answered ${r.status}`);
    return data;
  }
  // The trail under the header: where you are, with the way back to Home.
  function setTrail(here) { $('trail').hidden = !here; $('trailhere').textContent = here || ''; }
  // A request that is held back behind an Undo (see UI.toast): sent later, or as the page is left (keepalive).
  const post = (url, body, keepalive) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), keepalive: !!keepalive })
    .then((r) => { if (!r.ok) throw new Error(`The server answered ${r.status}`); return r; });
  function status(msg, err) { const s = $('status'); s.hidden = !msg; s.textContent = msg || ''; s.classList.toggle('err', !!err); }
  const toast = UI.toast;

  // ---------- Views and history (15 Nov 2026) ----------
  // Home, a show, the Sonarr picker and search results are views of this one page. Opening a show or a search adds a
  // history entry, so the browser's Back returns to Home where you were on it and Forward opens the show again. Each
  // entry keeps its own scroll position (the browser's own restoring cannot be used: the view is swapped after it runs).
  let link = '', view = 'home';
  // A pasted episode link (18 Nov 2026): the episode to pick once wcostream has been read again for its show.
  let pickNext = null;
  const settled = new Set();                           // episodes whose square has played its settle, for the show on screen
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  try { history.scrollRestoration = 'manual'; } catch { /* an old browser: it keeps its own restoring */ }
  const keepScroll = () => { try { history.replaceState({ ...(history.state || {}), y: Math.round(scrollY) }, ''); } catch { /* not kept */ } };
  if ('onscrollend' in window) addEventListener('scrollend', keepScroll);
  else { let t; addEventListener('scroll', () => { clearTimeout(t); t = setTimeout(keepScroll, 150); }, { passive: true }); }
  const rowOf = (slug) => [...$('followedlist').children].find((el) => el.dataset.key === slug) || null;
  const withLang = (raw) => { try { const u = new URL(raw); u.searchParams.set('lang', lang()); return u.toString(); } catch { return raw; } };
  // Swap the view. From or to a row of the home list, the row's poster and title glide into the show's header and
  // back (a view transition), where the browser can do it and motion is allowed; otherwise the swap is instant.
  // The row is found by its show's slug, before and after the swap: the home list may have been redrawn in between.
  function glide(change, slug, after) {
    const marked = [];
    const mark = () => {
      const row = slug ? rowOf(slug) : null;
      for (const [sel, name] of [['.poster', 'vt-poster'], ['.fname', 'vt-title']]) { const el = row?.querySelector(sel); if (el) { el.style.viewTransitionName = name; marked.push(el); } }
    };
    const done = () => { for (const el of marked) el.style.viewTransitionName = ''; if (after) after(slug ? rowOf(slug) : null); };
    if (!document.startViewTransition || reduce.matches) { change(); done(); return; }
    mark();
    let t;
    try { t = document.startViewTransition(() => { change(); mark(); }); } catch { change(); done(); return; }
    t.ready.catch(() => undefined);                    // skipped (another transition is under way): the swap still happens
    t.finished.then(done, done);
  }
  function showHome() {
    view = 'home'; show = null; link = ''; pickNext = null; sel.clear(); fills = new Map();
    $('show').hidden = true; $('picker').hidden = true; $('found').hidden = true; $('run').hidden = true; $('bar').classList.remove('on');
    $('empty').hidden = false; status(''); setTrail(''); hideTip(); document.documentElement.style.setProperty('--sbarh', '0px');
    idleTitle = document.title = BASE_TITLE;
    renderHome();
  }
  function toHash(hash) {
    if (hash === '#queue') openQueue(true);
    else if (hash === '#attention' && !$('attention').hidden) $('attention').scrollIntoView({ block: 'start' });
    else if (hash === '#night') showNight();
    else if (hash === '#stage' && !$('stage').hidden) { stageAsk = true; renderStage(); $('stage').scrollIntoView({ block: 'center' }); $('stage').querySelector('button')?.focus({ preventScroll: true }); }
  }
  function goHome(o = {}) {
    if (view === 'home') {
      if (o.hash) toHash(o.hash); else if (o.pop) scrollTo(0, o.y || 0); else scrollTo({ top: 0, behavior: reduce.matches ? 'auto' : 'smooth' });
      return;
    }
    if (o.push !== false) { keepScroll(); history.pushState({ v: 'home' }, '', location.pathname + (o.hash || '')); }
    glide(() => { showHome(); if (o.hash) toHash(o.hash); else scrollTo(0, o.y || 0); }, show?.slug,
      (row) => { if (!o.hash) (row?.querySelector('a') || $('pagetitle')).focus({ preventScroll: true }); });
  }

  // ---------- Look-up and show picking ----------
  // o.extra: more for the server (&seriesId=, &absolute=). o.push false: no new history entry (a first load, Back or
  // Forward, the same show again). o.y: where to scroll to (0 for a newly opened show). o.key: the home row it opens from.
  async function openShow(to, o = {}) {
    to = String(to || '').trim();
    if (!to) return;
    const cold = $('empty').hidden && $('show').hidden && $('found').hidden && $('picker').hidden;   // nothing on screen yet: say what is happening
    if (cold) status('Looking it up in Sonarr…');
    let got;
    try { got = await api('GET', `/show?url=${encodeURIComponent(to)}${o.extra || ''}`); }
    catch (e) { status(`Could not look that up: ${e.message}`, true); return; }
    status('');
    // An episode's own link opens its show; the address and later look-ups use the show, not the episode.
    if (got.pick) { pickNext = got.pick; to = got.slug; }
    else if (got.slug !== show?.slug) pickNext = null;   // another show: forget it (picking its series in Sonarr keeps it)
    const url = '?url=' + encodeURIComponent(to);
    const same = view === 'show' && !!show?.series && got.series?.id === show.series.id;   // this show again (its numbering, a finished run): stay put
    if (o.push !== false && location.search !== url) { keepScroll(); history.pushState({ v: 'show', home: view === 'home' }, '', url); }
    else if (!o.pop && location.search !== url) history.replaceState({ ...(history.state || {}), v: 'show' }, '', url);
    const change = () => {
      show = got; link = to;
      if (show.series) UI.remember(show.slug, show.series.title);
      $('url').value = ''; $('sclear').hidden = true; $('skey').hidden = false;
      if (!same) { settled.clear(); $('map').classList.add('fresh'); setTimeout(() => $('map').classList.remove('fresh'), 900); }   // squares arrive once per show, not after each run
      if (show.language) setSeg('lang', show.language);
      $('empty').hidden = true; $('found').hidden = true;
      if (!show.series) {
        showPicker(show.candidates, show.candidates.length
          ? `More than one show in Sonarr could be "${show.slug}". Pick the right one; it is remembered for this link.`
          : `"${show.slug}" is not in Sonarr yet. Add the show in Sonarr first (http://${location.hostname}:8989/add/new), then look it up again, or search below if Sonarr has it under another name.`);
      } else {
        view = 'show';
        $('picker').hidden = true;
        setSeg('numbering', String(!!show.absolute));
        setSeasonPick();
        setFollow(!!show.follow);
        if (!same && !cold) $('show').hidden = false;   // the glide is the entrance; the rise is for a first load
        renderShow();
        poll();
      }
      if (!same) scrollTo(0, o.y || 0);
    };
    if (same || cold) change();                        // a first load has nothing to glide from
    else glide(change, view === 'home' ? o.key || got.slug : null, () => { if (!cold && got.series) $('title').focus({ preventScroll: true }); });
  }
  function showPicker(cands, hint) {
    view = 'picker';
    $('show').hidden = true; $('empty').hidden = true; $('picker').hidden = false;
    setTrail('Which show in Sonarr?');
    $('pickhint').textContent = hint;
    renderPicks(cands || []);
    $('search').value = ''; $('search').focus();
  }
  function renderPicks(list) {
    $('picks').innerHTML = list.length ? list.map((s) => `<li><button type="button" data-id="${s.id}">${esc(s.title)} <span>${esc(s.year)} · ${esc(s.path)}</span></button></li>`).join('')
      : '<li class="hint">Nothing in Sonarr matches. Search by another name.</li>';
  }
  $('picks').addEventListener('click', (ev) => { const b = ev.target.closest('button[data-id]'); if (b) openShow(link, { extra: '&seriesId=' + b.dataset.id, push: false }); });
  $('search').addEventListener('keydown', (ev) => { if (ev.key === 'ArrowDown') { ev.preventDefault(); $('picks').querySelector('button')?.focus(); } });
  $('picks').addEventListener('keydown', (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    const all = [...$('picks').querySelectorAll('button')], i = all.indexOf(b);
    if (ev.key === 'ArrowDown') { ev.preventDefault(); all[i + 1]?.focus(); }
    if (ev.key === 'ArrowUp') { ev.preventDefault(); (all[i - 1] || $('search')).focus(); }
  });
  let st;
  $('search').addEventListener('input', () => { clearTimeout(st); st = setTimeout(async () => renderPicks(await api('GET', '/series-search?q=' + encodeURIComponent($('search').value)).catch(() => [])), 250); });
  $('change').onclick = () => showPicker(show?.candidates, 'Pick the series these episodes belong to. It is remembered for this link.');
  // The header's search box is ui.js's (the jump panel). Here it opens a show, a search or the queue in place.
  UI.hooks.openShow = (slug, language) => { if (language) setSeg('lang', language); openShow(slug); };
  UI.hooks.link = (url) => openShow(url);
  UI.hooks.search = (words) => nameSearch(words);
  UI.hooks.queue = () => openQueue(true);
  UI.hooks.refresh = () => { lastQ = null; loadAttention(true); poll(); };
  UI.hooks.recount = () => $('recount').click();
  UI.hooks.stage = () => (view === 'home' ? toHash('#stage') : goHome({ hash: '#stage' }));
  // What the search box offers for the screen in view (18 Nov 2026): on a show's map, follow it or stop.
  UI.hooks.actions = () => {
    if (view !== 'show' || !show?.series) return [];
    const on = $('follow').getAttribute('aria-pressed') === 'true';
    return [{ icon: 'check', title: on ? 'Stop following this show' : 'Follow this show overnight', words: 'follow unfollow stop following this show overnight', run: () => $('follow').click() }];
  };

  // ---------- Motion: small, quick, and off when the system asks for less ----------
  // A panel that appears rises a few pixels; a progress bar slides from where it was instead of jumping.
  function reveal(el) { el.hidden = false; el.classList.remove('enter'); void el.offsetWidth; el.classList.add('enter'); }
  const lastWidth = new Map();
  function smooth(box, key) {
    const bar = box.querySelector('.prog i, .runbar i'); if (!bar) { lastWidth.delete(key); return; }
    const to = bar.style.width, from = lastWidth.get(key);
    if (from && from !== to) { bar.style.width = from; void bar.offsetWidth; bar.style.width = to; }
    lastWidth.set(key, to);
  }

  // ---------- Search wcostream by name: shows you do not have yet are found here ----------
  const sonarrAdd = (name) => `http://${location.hostname}:8989/add/new?term=${encodeURIComponent(name)}`;
  async function nameSearch(words, o = {}) {
    const q = String(words ?? $('url').value).trim(); if (!q) return;
    status('Searching wcostream. The first search can take a minute.');
    let found;
    try { found = await api('GET', '/library/search?q=' + encodeURIComponent(q)); }
    catch (e) { status(`Could not search wcostream: ${e.message}`, true); return; }
    status('');
    const url = '?find=' + encodeURIComponent(q);
    if (o.push !== false && location.search !== url) { keepScroll(); history.pushState({ v: 'found' }, '', url); }
    view = 'found'; link = '';
    $('show').hidden = true; $('picker').hidden = true; $('empty').hidden = true; reveal($('found'));
    $('run').hidden = true; show = null; sel.clear(); $('bar').classList.remove('on'); idleTitle = document.title = `Search: ${q} · wco-dl`;
    scrollTo(0, o.y || 0);
    $('foundhead').textContent = `On wcostream: "${q}"`;
    setTrail(`Search: ${q}`);
    $('foundhint').textContent = found.length ? 'Pick a show to see its episodes. One that is not in Sonarr has to be added there first, so its episodes have somewhere to go.'
      : 'Nothing on wcostream by that name (dubbed anime, cartoons and subbed anime were searched). Try fewer words.';
    $('foundlist').innerHTML = found.map((c) => `<li><button type="button" data-slug="${esc(c.slug)}" data-lang="${c.language}"${c.series ? '' : ' disabled'}>${esc(c.name)}
      <span>${c.language === 'sub' ? 'sub only' : 'dub'} · ${c.series ? `in Sonarr as ${esc(c.series.title)}${c.follow ? ' · following' : ''}` : 'not in Sonarr yet'}</span></button>` +
      (c.series ? '' : `<button class="btn" type="button" data-add="${esc(c.name)}" data-slug="${esc(c.slug)}" data-lang="${c.language}">${UI.icon('plus')}Add to Sonarr</button>
        <a class="linkbtn" href="${sonarrAdd(c.name.replace(/\b(English )?(Dubbed|Subbed)\b/gi, '').trim())}" target="_blank" rel="noopener">or add it by hand</a>
        <button class="linkbtn" type="button" data-slug="${esc(c.slug)}" data-lang="${c.language}">I have added it</button><span class="choices"></span>`) + '</li>').join('');
    if (found.some((c) => !c.series)) {
      const d = await api('GET', '/sonarr/defaults').catch(() => null);
      if (d) $('foundhint').textContent += ` "Add to Sonarr" puts a new show in ${d.rootFolderPath} with the quality profile "${d.qualityProfile}", the settings of the last animated show you added (${d.copiedFrom}).`;
    }
  }
  // One press: Sonarr looks the name up and adds the one show of that name; several of the same name come back to pick from.
  async function addToSonarr(b, tvdbId) {
    const li = b.closest('li'), add = li.querySelector('[data-add]'), box = li.querySelector('.choices');
    add.disabled = true;
    try {
      const r = await api('POST', '/sonarr/add', { name: add.dataset.add, slug: add.dataset.slug, tvdbId });
      if (r.added || r.already) {
        toast(r.added ? `Added to Sonarr: ${r.series.title} at ${r.series.path}` : `${r.series.title} is already in Sonarr`);
        setSeg('lang', add.dataset.lang);
        await openShow(add.dataset.slug, { extra: '&seriesId=' + r.series.id }); return;
      }
      box.innerHTML = r.choices.length ? '<span class="hint">Which one?</span>' + r.choices.map((c) =>
        `<button class="btn" type="button" data-tvdb="${c.tvdbId}"${c.inSonarr ? ' disabled' : ''}>${UI.icon('plus')}${esc(c.title)} (${c.year || 'year unknown'})${c.network ? ' · ' + esc(c.network) : ''}${c.inSonarr ? ' · in Sonarr' : ''}</button>`).join('')
        : '<span class="hint">Sonarr found no show by that name. Add it by hand under the name Sonarr knows.</span>';
    } catch (e) { status(`Could not add it to Sonarr: ${e.message}`, true); }
    add.disabled = false;
  }
  $('foundlist').addEventListener('click', (ev) => {
    const add = ev.target.closest('[data-add]'); if (add) { addToSonarr(add); return; }
    const tv = ev.target.closest('[data-tvdb]'); if (tv) { if (!tv.disabled) addToSonarr(tv, +tv.dataset.tvdb); return; }
    const b = ev.target.closest('[data-slug]'); if (!b || b.disabled) return;
    setSeg('lang', b.dataset.lang); openShow(b.dataset.slug);
  });

  // Which part of the Sonarr series this wcostream show is (21 Nov 2026): the whole series, or one season numbered
  // from 1 (wcostream's Horizons is Pokémon's season 20; Steel Ball Run is JoJo's season 6). Offered when Sonarr has
  // more than one season; with a season set the numbering is straight through, so its switch is hidden.
  // A second folder Sonarr does not track (22 Nov 2026): list its files with the episode each would be, import the chosen ones.
  $('split').addEventListener('click', async (ev) => {
    const box = $('splitfiles');
    if (ev.target.closest('#splitlook')) {
      box.hidden = false; box.textContent = 'Asking Sonarr which episode each file is…';
      try {
        const files = await api('GET', '/show/split?seriesId=' + show.series.id);
        const ok = files.filter((f) => f.ok);
        box.innerHTML = files.length ? files.map((f, i) => `<label><input type="checkbox" data-split="${i}"${f.ok ? ' checked' : ' disabled'}><span class="fn">${esc(f.name)}</span>` +
          `<span class="${f.ok ? '' : 'why'}">${f.ok ? '→ ' + f.episodes.map((e) => `${e.s}x${pad(e.e)} ${esc(e.t)}`).join(', ') : esc(f.why)}</span></label>`).join('') +
          (ok.length ? `<button class="btn" id="splitimport" type="button">${UI.icon('download')}Import the chosen files into Sonarr</button>` : '<span class="why">Nothing here can be imported.</span>')
          : 'No video files in it.';
        box._files = files;
      } catch (e) { box.textContent = `Could not read it: ${e.message}`; }
      return;
    }
    if (ev.target.closest('#splitimport')) {
      const files = box._files || [], paths = [...box.querySelectorAll('[data-split]:checked')].map((c) => files[+c.dataset.split].path);
      if (!paths.length) return;
      ev.target.closest('#splitimport').disabled = true; status(`Importing ${paths.length} file${paths.length === 1 ? '' : 's'} into Sonarr…`);
      try {
        const r = await api('POST', '/show/split/import', { seriesId: show.series.id, paths });
        status(''); toast(`Imported ${r.imported} of ${r.asked} into Sonarr: those episodes are no longer missing`);
        await openShow(link, { push: false });
      } catch (e) { status(`Could not import: ${e.message}`, true); }
    }
  });
  // No dialogue (22 Nov 2026): a show whose files are "undubbed" only because there is no speech is never swapped.
  $('noswap').addEventListener('change', async () => {
    try { await api('POST', '/links/no-swap', { slug: show.slug, noSwap: $('noswap').checked }); toast($('noswap').checked ? 'Never swapped: its files stay as they are' : 'Swapped to the dub again where one exists'); }
    catch (e) { $('noswap').checked = !$('noswap').checked; status(`Could not change it: ${e.message}`, true); }
  });

  function setSeasonPick() {
    $('noswaplabel').hidden = !show?.series;
    $('noswap').checked = !!show?.noSwap;
    const seasons = (show?.seasons || []).filter((n) => n > 0);
    $('seasonpick').hidden = !show?.series || (seasons.length < 2 && !show.season);
    $('numbering').hidden = !!show?.season;
    if ($('seasonpick').hidden) return;
    $('seasonsel').innerHTML = `<option value="">the whole series</option>` + seasons.map((n) => `<option value="${n}"${show.season === n ? ' selected' : ''}>Sonarr season ${n}</option>`).join('');
  }
  $('seasonsel').addEventListener('change', async () => {
    const v = $('seasonsel').value, season = v ? Number(v) : null;
    $('seasonsel').disabled = true;
    try {
      await api('POST', '/links/season', { slug: show.slug, season });
      toast(season ? `This wcostream show is now Sonarr season ${season}: its episode 1 is ${season}x01` : 'This wcostream show is the whole series again');
      await openShow(link, { push: false });
    } catch (e) { status(`Could not change it: ${e.message}`, true); }
    $('seasonsel').disabled = false;
  });

  function setSeg(id, v) { $(id).querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === v))); }
  $('lang').addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    setSeg('lang', b.dataset.v); link = withLang(link);
    if (show?.series) renderShow(true);
  });
  // Changing the numbering asks the server again, which clears the selection. It is not asked about first: it
  // happens, and Undo puts back the numbering and what was selected.
  const numberAs = (abs) => openShow(link, { extra: '&seriesId=' + show.series.id + '&absolute=' + abs, push: false });
  $('numbering').addEventListener('click', async (ev) => {
    const b = ev.target.closest('button'); if (!b || !show?.series || b.getAttribute('aria-pressed') === 'true') return;
    const was = String(!!show.absolute), ids = new Set(picked().map((e) => e.id)), id = show.series.id;
    await numberAs(b.dataset.v);
    if (!ids.size || show?.series?.id !== id) return;
    toast(`Numbering changed. ${ids.size} selected episode${ids.size === 1 ? ' was' : 's were'} cleared`, { key: 'numbering', undo: async () => {
      if (show?.series?.id !== id) return;
      await numberAs(was);
      for (const e of eps) if (ids.has(e.id) && e.el && selectable(e)) sel.add(e.i);
      render();
    } });
  });

  // Episodes wcostream does not list for this show (the server reads its show page; the first time can take a while).
  // They are dotted, left out of "select all" and not queued overnight: a download of them fails.
  // After a run for this show finishes the answer is asked for again (wcoStale): what needed work has changed. The old
  // note and dots stay up until the new answer is in, so nothing blinks.
  let wcoFor = '', wcoGone = new Set(), wcoTogether = {}, wcoStale = false, wcoPending = null;
  // o.fresh: read the show page again now rather than use the copy kept for six hours ("Check wcostream again").
  async function wcoNote(id, o = {}) {
    const key = `${id}|${show.slug}|${lang()}|${show.absolute}`;
    const pick = pickNext;
    if (wcoFor === key && !wcoStale && !pick && !o.fresh) return;
    if (wcoFor !== key) { wcoGone = new Set(); wcoTogether = {}; $('wconote').hidden = true; }
    wcoFor = key; wcoStale = false; pickNext = null;
    const fresh = !!(o.fresh || pick);
    if (fresh) status(pick ? `Reading wcostream again for episode ${pick.number}. This can take a minute.` : 'Reading wcostream again. This can take a minute.');
    try {
      const d = await (await fetch(`/show/wco?url=${encodeURIComponent(show.slug)}&seriesId=${id}&lang=${lang()}&absolute=${!!show.absolute}` +
        (fresh ? '&fresh=1' : '') + (pick ? '&pick=' + encodeURIComponent(pick.link) : ''))).json();
      if (wcoFor !== key) return;
      if (!d.checked) { if (fresh) status('wcostream could not be read just now. Try "Check wcostream again" in a minute.', true); return; }
      if (fresh) status('');
      wcoGone = new Set(d.unlisted); wcoTogether = d.together || {};
      eps.forEach((e) => { e.nowco = wcoGone.has(e.id); if (e.el) e.el.classList.toggle('nowco', e.nowco); });
      const n = d.unlisted.length, version = lang() === 'dub' ? 'English dub' : 'subbed';
      const parts = [];
      if (n) {
        const diff = d.different || 0, gone = n - diff;
        parts.push(`${n} episode${n === 1 ? '' : 's'} that need${n === 1 ? 's' : ''} work cannot be had from wcostream as ${version}: ` +
          [gone && `${gone} not listed${d.latest ? ` (it lists up to ${d.latest})` : ''}`, diff && `${diff} where its episode of that number is a different episode`].filter(Boolean).join(', ') +
          '. Dotted below, left out of "Select the gaps" and the overnight run.');
      }
      if (d.byTitle) parts.push(`${d.byTitle} ${d.byTitle === 1 ? 'is' : 'are'} found by title, because the site numbers this show differently from Sonarr.`);
      // The other way of numbering would supply more: offer the switch. Straight through is only offered when the
      // site has no season links, so a number can only mean one episode.
      const f = d.fit || {}, mine = show.absolute ? f.absolute : f.season, other = show.absolute ? f.season : f.absolute;
      const offer = other > mine + 2 && (show.absolute || f.flat);
      // What was read and when, with a way to read it again: a new episode can be posted within the six hours a
      // reading is kept, and until then the map counts it as not on wcostream.
      const read = `wcostream lists ${d.listed} episode${d.listed === 1 ? '' : 's'}${d.latest ? `, up to ${d.latest}` : ''}` +
        (d.readAt ? `; read ${ago(d.readAt)}` : '') + '.';
      $('wconote').innerHTML = parts.map(esc).join(' ') + (offer ? ` Numbered ${show.absolute ? 'by season' : 'straight through'}, wcostream would supply ${other} of the ${f.work} episodes that need work, not ${mine}. <button class="linkbtn" id="numswitch" type="button">Switch numbering</button>` : '') +
        ` <span class="wcoread">${esc(read)} <button class="linkbtn" id="wcoagain" type="button">Check wcostream again</button></span>`;
      $('wconote').hidden = false;
      $('numswitch')?.addEventListener('click', () => $('numbering').querySelector(`[data-v="${!show.absolute}"]`).click());
      $('wcoagain').addEventListener('click', () => { if (show?.series) wcoNote(show.series.id, { fresh: true }); });
      render();
      if (pick) pickFromLink(pick, d.picked || []);
    } catch { /* the check is optional */ }
  }

  // The pasted episode, picked on the map and brought into view; or a line saying why it was not.
  function pickFromLink(p, ids) {
    const name = `Episode ${p.season ? p.season + 'x' + pad(p.number) : p.number}`;
    const mine = eps.filter((e) => ids.includes(e.id));
    const can = mine.filter((e) => e.el && selectable(e));
    if (can.length) {
      can.forEach((e) => sel.add(e.i)); render();
      can[0].el.scrollIntoView({ block: 'center', behavior: reduce.matches ? 'auto' : 'smooth' });
      status(`${name} from the link is picked${can.length > 1 ? ` (with ${can.length - 1} more: it comes in one file)` : ''}. Download is at the bottom.`);
    } else if (mine.length) {
      const e = mine[0];
      status(fills.get(e.id) && ACTIVE.includes(fills.get(e.id).state) ? `${name} is already queued.`
        : e.st === 'future' ? `Sonarr says ${name} has not aired yet. Refresh the series in Sonarr, then open the link again.`
        : `${name} is already here (${STATE_WORDS[e.st]}).`);
      e.el?.scrollIntoView({ block: 'center', behavior: reduce.matches ? 'auto' : 'smooth' });
    } else {
      status(`wcostream lists ${name}, but it could not be matched to an episode in Sonarr with certainty. Pick it on the map yourself.`, true);
    }
  }
  const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };

  // The next English dub episodes of this show, from the dub calendar (AnimeSchedule.net). Asked once per show.
  let dubFor;
  async function dubNote(id) {
    if (dubFor === id) return;
    dubFor = id; $('dubnote').hidden = true;
    try {
      const rows = await (await fetch('/dub-calendar/series/' + id)).json();
      if (dubFor !== id || !Array.isArray(rows) || !rows.length) return;
      const day = (d) => new Date(d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      $('dubnote').innerHTML = 'English dub: ' + rows.map((r) => `episode ${r.episode} ${r.estimate ? 'about ' : ''}${day(r.date)}`).join(', ') +
        (rows[0].match === 'loose' ? ' (matched by name without its season: check it is this show)' : '') +
        '. <a href="/calendar.html">Dub calendar</a>';
      $('dubnote').hidden = false;
    } catch { /* the note is optional */ }
  }

  // ---------- Map ----------
  function renderShow(keepSelection) {
    $('empty').hidden = true; if ($('show').hidden) reveal($('show'));
    $('title').textContent = show.series.title;
    if ($('showposter').dataset.id !== String(show.series.id)) { $('showposter').dataset.id = show.series.id; $('showposter').innerHTML = UI.poster(show.series.id, show.series.title, 'l'); }
    setTrail(show.series.title);
    $('path').textContent = show.series.path;
    const split = show.split || [];
    $('split').hidden = !split.length;
    $('split').innerHTML = split.length ? `This show also has a folder Sonarr does not track: <code>${esc(split.join(', '))}</code>. Episodes in it count as missing here, so they would be downloaded again. ` +
      `<button class="linkbtn" id="splitlook" type="button">See the files in it</button><div class="splitfiles" id="splitfiles" hidden></div>` : '';
    dubNote(show.series.id);
    // Download waits for this answer (20 seconds at most), so nothing is picked that wcostream does not list.
    const asked = wcoPending = Promise.race([wcoNote(show.series.id), new Promise((r) => setTimeout(r, 20000))])
      .finally(() => { if (wcoPending === asked) wcoPending = null; });
    eps = show.episodes.map((e, i) => ({ ...e, i, nowco: wcoGone.has(e.id) }));
    if (!keepSelection) sel.clear();
    const count = (s) => eps.filter((e) => e.st === s).length;
    $('tally').innerHTML = `<span><b>${count('dub')}</b> in English</span><span><b>${count('undub')}</b> not in English</span>${count('unknown') ? `<span><b>${count('unknown')}</b> audio not labelled</span>` : ''}<span><b>${count('missing')}</b> missing</span>` +
      (count('future') ? `<span><b>${count('future')}</b> not aired</span>` : '');
    const map = $('map'); map.innerHTML = '';
    if (!eps.length) { map.innerHTML = '<p class="empty">Sonarr has no episodes for this show yet.</p>'; render(); return; }
    for (const s of [...new Set(eps.map((e) => e.s))]) {
      const list = eps.filter((e) => e.s === s), work = list.filter(actionable);
      const row = document.createElement('div'); row.className = 'season'; row.dataset.s = s;
      const lab = document.createElement('button'); lab.className = 'slabel'; lab.type = 'button'; lab.dataset.s = s;
      lab.innerHTML = `<b>Season ${s}</b><span></span>`;
      lab.onclick = () => {
        const w = eps.filter((e) => e.s === s && actionable(e) && selectable(e));
        if (!w.length) { toggleFold(s); return; }
        const all = w.every((e) => sel.has(e.i)); w.forEach((e) => (all ? sel.delete(e.i) : sel.add(e.i))); render();
      };
      const cells = document.createElement('div'); cells.className = 'cells'; cells.dataset.s = s;
      cells.setAttribute('role', 'group'); cells.setAttribute('aria-label', 'Season ' + s);
      // A season that needs nothing folds to one line, so long shows stay readable.
      const folded = !work.length && !open.has(s);
      if (folded) {
        cells.classList.add('folded');
        cells.innerHTML = `<span class="fold">${list.length} episodes, ${list.every((e) => e.st === 'dub') ? 'all in English' : 'nothing to do'}</span><button type="button" class="btn btn-quiet fold-btn">${UI.icon('chev')}Show squares</button>`;
        cells.querySelector('.fold-btn').onclick = () => toggleFold(s);
      } else {
        list.forEach((e, k) => {
          const c = document.createElement('button'); c.type = 'button'; c.dataset.i = e.i; c.tabIndex = k === 0 ? 0 : -1; c.style.setProperty('--i', Math.min(k, 40));
          c.setAttribute('role', 'checkbox');
          e.el = c; cells.appendChild(c);
        });
      }
      row.append(lab, cells); map.appendChild(row);
    }
    render();
  }
  // ---------- Season bar (15 Nov 2026): on a show with more than one season, a bar that stays under the header ----------
  // The show's title and a chip per season with how many of its episodes need work. A chip scrolls to its season; the
  // chip of the season being read is marked (aria-current) as the page scrolls. It scrolls sideways inside itself
  // when the chips do not fit, so it is always one line.
  let lastSbar = '', pinned = null;
  for (const type of ['wheel', 'touchmove', 'keydown']) addEventListener(type, () => { pinned = null; }, { passive: true });
  function drawSbar() {
    const seasons = show?.series ? [...new Set(eps.map((e) => e.s))] : [];
    $('sbar').hidden = seasons.length < 2;
    if ($('sbar').hidden) { lastSbar = ''; document.documentElement.style.setProperty('--sbarh', '0px'); return; }
    $('sbartitle').textContent = show.series.title;
    const html = seasons.map((s) => {
      const n = eps.filter((e) => e.s === s && actionable(e)).length, name = s === 0 ? 'Specials' : 'Season ' + s;
      return `<button class="chip" type="button" data-s="${s}" aria-label="${name}, ${n ? n + ' need work' : 'nothing to do'}">${s === 0 ? 'Specials' : 'S' + s}${n ? ` <span class="count">${n}</span>` : ''}</button>`;
    }).join('');
    if (html !== lastSbar) { lastSbar = html; $('chips').innerHTML = html; }
    document.documentElement.style.setProperty('--sbarh', $('sbar').offsetHeight + 'px');
    markSeason();
  }
  function markSeason() {
    if ($('sbar').hidden) return;
    const line = $('sbar').getBoundingClientRect().bottom + 24;
    let cur = null;
    for (const row of $('map').querySelectorAll('.season')) { if (cur === null || row.getBoundingClientRect().top <= line) cur = row.dataset.s; }
    if (pinned !== null) cur = pinned;                 // a season near the end cannot reach the top: the chip pressed still counts
    for (const c of $('chips').children) {
      const on = c.dataset.s === cur;
      if (on === (c.getAttribute('aria-current') === 'true')) continue;
      if (on) {
        c.setAttribute('aria-current', 'true');
        const box = $('chips'), l = c.offsetLeft - box.offsetLeft;   // keep the marked chip in sight inside the bar, without moving the page
        if (l < box.scrollLeft) box.scrollLeft = l - 8; else if (l + c.offsetWidth > box.scrollLeft + box.clientWidth) box.scrollLeft = l + c.offsetWidth - box.clientWidth + 8;
      } else c.removeAttribute('aria-current');
    }
  }
  addEventListener('scroll', markSeason, { passive: true });
  addEventListener('resize', () => { if (!$('sbar').hidden) document.documentElement.style.setProperty('--sbarh', $('sbar').offsetHeight + 'px'); });
  $('chips').addEventListener('click', (ev) => {
    const c = ev.target.closest('.chip'); if (!c) return;
    const row = $('map').querySelector(`.season[data-s="${c.dataset.s}"]`); if (!row) return;
    pinned = c.dataset.s;
    row.scrollIntoView({ block: 'start', behavior: reduce.matches ? 'auto' : 'smooth' });
    markSeason();
    row.querySelector('.slabel')?.focus({ preventScroll: true });   // the keyboard carries on from that season
  });
  function toggleFold(s) { open.has(s) ? open.delete(s) : open.add(s); renderShow(true); }

  const selectable = (e) => pickable(e) && !(fills.get(e.id) && ACTIVE.includes(fills.get(e.id).state));
  function cellLook(e) {
    if (!e.el) return;
    const f = fills.get(e.id), live = f && f.state !== 'cancelled';
    const was = e.fs; e.fs = live ? f.state : '';
    // The moment an episode lands its square settles, once: the class stays through later redraws (so the animation is
    // not started again) and is taken off when it ends; a square drawn already done never plays it.
    if (e.fs === 'done' && was && was !== 'done' && !settled.has(e.id)) {
      settled.add(e.id); e.settle = true;
      e.el.addEventListener('animationend', () => { e.settle = false; e.el.classList.remove('settle'); }, { once: true });
    }
    e.el.className = 'cell ' + e.st + (e.nowco ? ' nowco' : '') + (live ? ' f-' + f.state : '') + (e.settle ? ' settle' : '');
    const au = live ? (f.state === 'downloading' ? `${f.progress ?? 0}%` : FILL_LABEL[f.state]) : offWco(e) ? 'n/a' : e.st === 'dub' ? 'EN' : e.st === 'undub' ? 'JP' : e.st === 'unknown' ? '?' : '';
    e.el.innerHTML = `<span class="n">${show.absolute && e.abs ? e.abs : e.e}</span>${au ? `<span class="au${au.length > 5 ? ' long' : ''}">${au}</span>` : ''}`;
    e.el.style.setProperty('--p', (live && f.state === 'downloading' ? f.progress ?? 0 : live && f.state === 'importing' ? 100 : 0) + '%');
    selectable(e) ? e.el.removeAttribute('aria-disabled') : e.el.setAttribute('aria-disabled', 'true');
    e.el.setAttribute('aria-checked', sel.has(e.i) ? 'true' : 'false');
    const runWords = live ? `, this run: ${f.state === 'downloading' ? `downloading ${f.progress ?? 0}%` : f.message || f.state}` : '';
    e.el.setAttribute('aria-label', `${e.s}x${pad(e.e)} ${e.t}, ${STATE_WORDS[e.st]}${offWco(e) ? ', not on wcostream' : ''}${runWords}`);
  }

  function render() {
    for (const e of eps) { if (!selectable(e)) sel.delete(e.i); cellLook(e); }
    const p = picked(), sw = p.filter(isSwap).length, mi = p.filter((e) => e.st === 'missing').length;
    $('bar').classList.toggle('on', p.length > 0);
    // The button says the result ("Download 5 episodes"); the line beside it says what happens to them afterwards.
    $('sum').innerHTML = `<b>${p.length} selected</b> <span>· ${[sw && sw + ' swap to dub', sw && mi && mi + ' to download', 'imported into Sonarr when done'].filter(Boolean).join(' · ')}</span>` +
      (sw ? `<span class="warn">Swapped files go to Sonarr's recycle bin, kept 7 days</span>` : '');
    confirmSwap = false;
    $('golabel').textContent = sw ? `Swap ${sw} to dub${mi ? ` · download ${mi}` : ''}` : `Download ${mi} episode${mi === 1 ? '' : 's'}`;
    drawSbar();
    const gaps = eps.filter((e) => e.el && actionable(e) && selectable(e)).length;
    $('all').hidden = !gaps;
    $('alllabel').textContent = `Select the ${gaps} gap${gaps === 1 ? '' : 's'}`;
    $('go').classList.remove('confirm');
    document.querySelectorAll('.slabel').forEach((l) => {
      const s = +l.dataset.s, all = eps.filter((e) => e.s === s), work = all.filter(actionable), n = work.filter((e) => sel.has(e.i)).length;
      l.querySelector('span').textContent = !work.length ? (open.has(s) ? 'hide squares' : 'nothing to do') : n ? `${n} of ${work.length} selected` : `${work.length} need work`;
    });
  }
  const picked = () => [...sel].sort((a, b) => a - b).map((i) => eps[i]);
  function setRange(a, b, on) { const [x, y] = a < b ? [a, b] : [b, a]; for (let i = x; i <= y; i++) if (eps[i].el && selectable(eps[i])) on ? sel.add(i) : sel.delete(i); }
  function toggle(e, shift) {
    if (shift && anchor !== null) setRange(anchor, e.i, true);
    else { sel.has(e.i) ? sel.delete(e.i) : sel.add(e.i); anchor = e.i; }
    render();
  }

  // Pointer: drag-select with a mouse or pen; a finger taps to toggle and swipes to scroll.
  const map = $('map');
  map.addEventListener('pointerdown', (ev) => {
    lastPointer = ev.pointerType;
    const c = ev.target.closest('.cell'); if (!c || ev.pointerType === 'touch') return;
    const e = eps[+c.dataset.i]; if (!selectable(e)) return;
    ev.preventDefault(); c.focus({ preventScroll: true });
    if (ev.shiftKey && anchor !== null) { toggle(e, true); return; }
    drag = { on: !sel.has(e.i) }; drag.on ? sel.add(e.i) : sel.delete(e.i); anchor = e.i; render();
  });
  map.addEventListener('click', (ev) => {
    if (lastPointer !== 'touch') return;
    const c = ev.target.closest('.cell'); if (!c) return; const e = eps[+c.dataset.i];
    showTip(c); if (selectable(e)) toggle(e, false);
  });
  map.addEventListener('pointerover', (ev) => {
    const c = ev.target.closest('.cell'); if (!c || ev.pointerType === 'touch') return; showTip(c);
    if (drag && ev.buttons) { const e = eps[+c.dataset.i]; if (selectable(e)) { drag.on ? sel.add(e.i) : sel.delete(e.i); render(); } }
  });
  map.addEventListener('pointerout', (ev) => { if (!ev.relatedTarget?.closest?.('.cell')) hideTip(); });
  window.addEventListener('pointerup', () => (drag = null));

  // Keyboard: one tab stop per season; arrows follow the real grid; Home/End; Space or Enter toggles.
  map.addEventListener('keydown', (ev) => {
    const c = ev.target.closest('.cell'); if (!c) return;
    const grid = c.parentElement, cells = [...grid.querySelectorAll('.cell')], k = cells.indexOf(c);
    const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').length || 1;
    const to = { ArrowRight: k + 1, ArrowLeft: k - 1, ArrowDown: k + cols, ArrowUp: k - cols, Home: 0, End: cells.length - 1 }[ev.key];
    if (to !== undefined) {
      ev.preventDefault(); const next = cells[Math.max(0, Math.min(cells.length - 1, to))];
      c.tabIndex = -1; next.tabIndex = 0; next.focus();
      const e = eps[+next.dataset.i]; if (ev.shiftKey && selectable(e)) { setRange(anchor ?? +c.dataset.i, e.i, true); render(); }
      return;
    }
    const e = eps[+c.dataset.i];
    if ((ev.key === ' ' || ev.key === 'Enter') && selectable(e)) { ev.preventDefault(); toggle(e, ev.shiftKey); }
  });
  map.addEventListener('focusin', (ev) => {
    const c = ev.target.closest('.cell'); if (!c) return;
    c.parentElement.querySelectorAll('.cell').forEach((x) => (x.tabIndex = x === c ? 0 : -1));
    showTip(c);
  });
  map.addEventListener('focusout', hideTip);

  const tip = $('tip');
  function showTip(c) {
    const e = eps[+c.dataset.i], f = fills.get(e.id);
    const run = f ? { queued: f.message || 'Waiting in this run', downloading: `Downloading, ${f.progress ?? 0}%`, importing: 'Importing into Sonarr', done: f.message || 'Done',
      premium: f.message, kept: f.message, failed: f.message, cancelled: 'Cancelled' }[f.state] : '';
    const act = f && (f.state === 'failed' || f.state === 'kept') ? "Open the queue for the downloader's own log" : run ? '' : e.st === 'unknown' ? (lang() === 'sub' ? '' : sel.has(e.i) ? 'Selected: your file will be replaced by the English dub'
      : 'The file does not say what language its audio is, so it may already be English. Click only if you know it is not')
      : e.st === 'undub' ? (lang() === 'sub' ? 'Sub mode: Japanese audio is what you asked for'
      : sel.has(e.i) ? 'Selected: your file will be replaced by the English dub' : 'Click to swap it for the English dub')
      : e.st === 'missing' ? (sel.has(e.i) ? 'Selected: will be downloaded' : 'Click to download it') : '';
    const mates = (wcoTogether[e.id] || []).filter((id) => id !== e.id).map((id) => eps.find((x) => x.id === id)).filter(Boolean).map((x) => `${x.s}x${pad(x.e)}`);
    const note = e.nowco && e.st !== 'future' && !run ? 'Not on wcostream: it does not list this episode, or its episode of this number is a different one'
      : mates.length && actionable(e) ? `${act ? act + '. ' : ''}On wcostream this comes in one file with ${mates.join(' and ')}` : act;
    tip.innerHTML = `<div class="k">${e.s}x${pad(e.e)}${e.abs ? ` · #${e.abs}` : ''}</div><div class="t">${esc(e.t)}</div><dl>
      <dt>Aired</dt><dd>${fmtDate(e.a)}</dd><dt>Status</dt><dd>${STATE_WORDS[e.st].replace(/^./, (x) => x.toUpperCase())}${offWco(e) ? ', not on wcostream' : ''}</dd>
      ${e.f ? `<dt>Audio</dt><dd>${esc(audioName(e.au))}</dd><dt>Quality</dt><dd>${esc(e.q)}</dd><dt>File</dt><dd>${esc(e.f)}</dd>` : ''}
      ${run ? `<dt>This run</dt><dd>${esc(run)}</dd>` : ''}</dl>${note ? `<div class="act">${note}</div>` : ''}`;
    const r = c.getBoundingClientRect(), w = 300;
    const x = Math.max(12, Math.min(innerWidth - w - 12, r.left + r.width / 2 - w / 2));
    tip.classList.add('on'); tip.removeAttribute('aria-hidden'); const h = tip.offsetHeight; let y = r.top - h - 8; if (y < 12) y = r.bottom + 8;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  }
  function hideTip() { tip.classList.remove('on'); tip.setAttribute('aria-hidden', 'true'); }   // role=tooltip with nothing to say is hidden from readers

  // ---------- Actions ----------
  function ranges(list) {
    const out = []; let start = null, prev = null;
    const push = () => start && out.push(start === prev ? `${start.s}x${start.e}` : `${start.s}x${start.e}-${prev.s}x${prev.e}`);
    for (const e of list) { if (prev && e.s === prev.s && e.e === prev.e + 1) { prev = e; continue; } push(); start = prev = e; }
    push(); return out.join(',');
  }
  $('go').onclick = async () => {
    // Picked before wcostream's list arrived (18 Nov 2026: 23 such episodes failed in one run): wait for it, and leave
    // out what it does not list, saying so, rather than send episodes the server will refuse.
    const asked = picked();
    if (wcoPending) { $('go').disabled = true; await wcoPending; $('go').disabled = false; }
    asked.forEach((e) => { if (e.nowco) sel.delete(e.i); });
    const off = asked.filter((e) => !sel.has(e.i)).length;
    if (off) {
      render();
      status(`${off} of the episodes picked ${off === 1 ? 'is' : 'are'} not on wcostream, so ${off === 1 ? 'it was' : 'they were'} left out.` +
        (picked().length ? ' Press Download again for the rest.' : ' Nothing else was picked.'));
      return;
    }
    const p = picked(); if (!p.length || !show) return;
    const sw = p.filter(isSwap).length;
    if (sw && !confirmSwap) {   // replacing files: one more deliberate click
      confirmSwap = true; $('go').classList.add('confirm');
      $('golabel').textContent = `Confirm: replace ${sw} file${sw > 1 ? 's' : ''} with the dub`;
      return;
    }
    $('go').disabled = true;
    try {
      const j = await api('POST', '/fill', { seriesId: show.series.id, slug: show.slug, language: lang(), quality: $('q').value, absolute: !!show.absolute, episodeIds: p.map((e) => e.id) });
      sel.clear(); status(''); toast(`${j.episodes.length} episode${j.episodes.length > 1 ? 's' : ''} queued`); await poll();
    } catch (e) { status(`Could not start the run: ${e.message}`, true); render(); }
    $('go').disabled = false;
  };
  $('all').onclick = () => { const work = eps.filter((e) => e.el && actionable(e) && selectable(e)); const all = work.every((e) => sel.has(e.i)); work.forEach((e) => (all ? sel.delete(e.i) : sel.add(e.i))); render(); };
  $('clear').onclick = () => { sel.clear(); render(); };
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !['INPUT', 'SELECT'].includes(document.activeElement?.tagName)) { sel.clear(); render(); } });

  // ---------- Runs: one poller feeds the squares, the run strip, the queue panel and the home screen ----------
  // A show can have several runs at once (a second batch started while the first still downloads), so the squares
  // and the strip read all of its live runs together; with none live they show the newest run that did anything.
  const STATE_TEXT = { queued: 'waiting', downloading: 'downloading', importing: 'importing', done: 'done', premium: 'premium, sent to Sonarr',
    kept: 'to check', failed: 'failed', cancelled: 'cancelled' };
  const BASE_TITLE = document.title;
  let idleTitle = BASE_TITLE;
  // The tab while a run is going: "3 of 5 · 55% · Show" and a dot on its icon, so it can be watched from another tab.
  // On a show's page the title is that show's own run (set where its strip is drawn); elsewhere it is whatever is
  // downloading. Both go back to the plain title and icon when nothing is.
  function tabState() {
    const working = allRuns.flatMap((j) => j.episodes.map((e) => ({ e, j }))).find((x) => isWorking(x.e));
    UI.busyTab(!!working);
    if (show?.series) return;
    if (!working) { document.title = idleTitle; return; }
    const list = working.j.episodes.filter((e) => e.state !== 'cancelled');
    document.title = `${list.indexOf(working.e) + 1} of ${list.length} · ${working.e.state === 'importing' ? 'importing' : (working.e.progress ?? 0) + '%'} · ${working.j.title}`;
  }
  const isLive = (j) => j.episodes.some((e) => ACTIVE.includes(e.state));
  const isWorking = (e) => e.state === 'downloading' || e.state === 'importing';
  const when = (s) => new Date(s).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const prog = (p, label, text) => `<div class="prog" role="progressbar" aria-label="${esc(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p}"${text ? ` aria-valuetext="${esc(text)}"` : ''}><i style="width:${p}%"></i></div>`;
  let allRuns = [], queueErr = '', pollT = null, pollSeq = 0;
  let qstate = { paused: false }, attention = [], attnAt = 0, attnAt0 = false, stage = null, stageAsk = false, lastRun = null, nightAt0 = false;
  async function loadAttention(force) {
    if (!force && Date.now() - attnAt < 60000) return;   // it asks Sonarr, so not on every poll
    attnAt = Date.now();
    [attention, stage, lastRun] = await Promise.all([api('GET', '/attention').catch(() => attention), api('GET', '/fill/staging').catch(() => stage),
      api('GET', '/fill/last-run').catch(() => lastRun)]);
    UI.setCounts({ attention: attnShown().length });
    renderHome();
    if (location.hash === '#attention' && !attnAt0) { attnAt0 = true; $('attention').scrollIntoView({ block: 'start' }); }
    if (location.hash === '#night' && !nightAt0) { nightAt0 = true; showNight(); }
    if (location.hash === '#stage' && !nightAt0) { nightAt0 = true; toHash('#stage'); }
  }

  function scope() {
    const mine = show?.series ? allRuns.filter((j) => j.seriesId === show.series.id) : [];
    const live = mine.filter(isLive);
    if (live.length) return live;
    const last = mine.find((j) => j.episodes.some((e) => e.state !== 'cancelled'));
    return last ? [last] : [];
  }
  const showActive = () => scope().some(isLive);

  async function poll() {
    const my = ++pollSeq; clearTimeout(pollT);
    const wasActive = showActive();
    try { [allRuns, qstate] = await Promise.all([api('GET', '/fill/jobs'), api('GET', '/fill/state')]); queueErr = ''; } catch (e) { queueErr = e.message; }
    if (my !== pollSeq) return;                       // a newer poll took over
    const pauseLabel = qstate.paused ? 'Resume' : 'Pause';   // drawn only when it changes, so a press is never lost to a redraw
    if ($('pausebtn').dataset.l !== pauseLabel) { $('pausebtn').dataset.l = pauseLabel; $('pausebtn').innerHTML = UI.icon(qstate.paused ? 'play' : 'pause') + pauseLabel; }
    $('pausebtn').setAttribute('aria-pressed', String(!!qstate.paused));
    UI.setPaused(qstate.paused);
    renderLinkCheck();
    loadAttention();
    applyRuns(); renderQueue(); renderHome();
    if (wasActive && !showActive() && !queueErr) {
      const f = [...fills.values()], n = (s) => f.filter((e) => e.state === s).length;
      toast(['Finished:', n('done') && `${n('done')} done`, n('premium') && `${n('premium')} sent to Sonarr`, n('kept') && `${n('kept')} to check`, n('failed') && `${n('failed')} failed`].filter(Boolean).join(' '));
      wcoStale = true;                                // the wcostream note counts what needs work: ask again
      await new Promise((r) => setTimeout(r, 320));   // the last square finishes settling before the map is drawn afresh
      if (my !== pollSeq) return;
      await openShow(link, { push: false }); return;  // fresh library state; opening it polls again
    }
    pollT = setTimeout(poll, showActive() ? 1500 : allRuns.some(isLive) ? 3000 : 15000);
  }

  function applyRuns() {
    const runs = scope();
    // Per episode: the run working on it wins, then the newest one that was not cancelled. Runs come newest first.
    fills = new Map();
    for (const j of runs) for (const e of j.episodes) {
      const had = fills.get(e.id);
      if (!had || (ACTIVE.includes(e.state) && !ACTIVE.includes(had.state)) || (had.state === 'cancelled' && e.state !== 'cancelled')) fills.set(e.id, e);
    }
    if (show?.series && !$('show').hidden) render();
    const f = [...fills.values()].filter((e) => e.state !== 'cancelled');
    tabState();
    if (!show?.series || !f.length) { $('run').hidden = true; if (show?.series) document.title = `${show.series.title} · wco-dl`; return; }
    const n = (s) => f.filter((e) => e.state === s).length;
    const active = f.some((e) => ACTIVE.includes(e.state)), cur = f.find(isWorking);
    const settled = f.length - n('queued') - n('downloading') - n('importing');
    // The bar is the run and the episode at once (15 Nov 2026): one segment per episode in the order they run, full when
    // settled (the error tone for failed or kept, grey for one handed to Sonarr), filled to its percentage while in hand.
    // Past 30 episodes the segments would be slivers, so it is one bar again: (settled + the part in hand) / all.
    const part = cur ? (cur.state === 'importing' ? 100 : cur.progress ?? 0) : 0;
    const whole = Math.round(((settled + part / 100) / f.length) * 100);
    const order = [...runs].reverse().flatMap((j) => j.episodes).filter((e) => fills.get(e.id) === e && e.state !== 'cancelled');
    const say = cur ? `Episode ${order.indexOf(cur) + 1} of ${f.length}, ${cur.state === 'importing' ? 'importing' : part + '%'}` : `${settled} of ${f.length} finished`;
    const runbar = f.length > 30 ? prog(whole, "This show's run", say)
      : `<div class="runbar" role="progressbar" aria-label="This show's run" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${whole}" aria-valuetext="${esc(say)}">` +
        order.map((e) => (e === cur ? `<span><i style="width:${part}%"></i></span>`
          : `<span${e.state === 'done' ? ' class="ok"' : e.state === 'failed' || e.state === 'kept' ? ' class="bad"' : e.state === 'premium' ? ' class="off"' : ''}></span>`)).join('') + '</div>';
    const busyUntil = f.filter((e) => e.state === 'queued' && e.notBefore && new Date(e.notBefore) > new Date()).map((e) => e.notBefore).sort()[0];
    const head = cur ? (cur.state === 'importing' ? 'Importing' : 'Downloading')
      : !active ? 'Last run'
      : runs.filter(isLive).every((j) => j.auto) ? 'Waiting for tonight'
      : busyUntil && n('queued') === f.filter((e) => e.state === 'queued' && e.notBefore).length ? 'Waiting on wcostream' : 'Waiting its turn';
    const detail = cur ? `<span class="code">${cur.s}x${pad(cur.e)}</span> ${esc(cur.title)}${cur.state === 'downloading' ? ` · ${cur.progress ?? 0}%` : ''}`
      : !active ? when(runs[0].createdAt)
      : head === 'Waiting for tonight' ? 'overnight runs go between ' + window.wcoNight()
      : head === 'Waiting on wcostream' ? `its servers were busy; next try at ${new Date(busyUntil).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
      : 'another show is downloading first';
    const bits = [`${settled} of ${f.length} finished`, n('queued') && `${n('queued')} waiting`, n('premium') && `${n('premium')} sent to Sonarr`,
      n('kept') && `${n('kept')} to check`, n('failed') && `${n('failed')} failed`].filter(Boolean).join(' · ');
    const retryable = !active && (n('kept') || n('failed'));
    $('run').hidden = false;
    $('run').classList.toggle('bad', !!(n('kept') || n('failed')));
    $('run').innerHTML = `<div class="runrow"><b>${head}</b><span class="what">${detail}</span><span class="grow"></span><span class="meta">${bits}</span>` +
      `<button class="linkbtn" id="runqueue" type="button">Details and logs</button>` +
      (active ? `<button class="btn" id="cancel" type="button">${UI.icon('x')}Cancel</button>` : '') +
      (retryable ? `<button class="btn" id="retry" type="button" title="Tries them again; a partial download resumes">${UI.icon('retry')}Retry ${n('kept') + n('failed')}</button>` : '') + '</div>' +
      (active ? runbar : '');
    smooth($('run'), 'run' + (cur ? cur.id : ''));   // a new episode starts its segment from empty, it does not slide back from the last one's
    $('cancel')?.addEventListener('click', () => runAction('cancel', runs.filter(isLive)));
    $('retry')?.addEventListener('click', () => runAction('retry', runs));
    $('runqueue')?.addEventListener('click', () => openQueue(true));
    document.title = cur ? `${order.indexOf(cur) + 1} of ${f.length} · ${cur.state === 'importing' ? 'importing' : (cur.progress ?? 0) + '%'} · ${show.series.title}`
      : (active ? `${n('queued')} waiting · ` : '') + `${show.series.title} · wco-dl`;
  }
  async function runAction(kind, runs) {
    try { for (const j of runs) await api('POST', `/fill/jobs/${j.id}/${kind}`, {}); }
    catch (e) { status(`Could not ${kind} the run: ${e.message}`, true); }
    poll();
  }

  // What the downloader is doing right now, in one line: used at the top of the queue and on the home screen.
  function nowLine(extra = '') {
    const flat = allRuns.flatMap((j) => j.episodes.map((e) => ({ e, j })));
    const cur = flat.find((x) => isWorking(x.e)), waiting = flat.filter((x) => x.e.state === 'queued');
    const shows = new Set(waiting.map((x) => x.j.seriesId)).size;
    const wait = waiting.length ? `${waiting.length} waiting${shows > 1 ? ` across ${shows} shows` : ''}` : 'nothing waiting';
    // Under the free-space limit (17 Nov 2026) nothing starts, so say why, even with nothing waiting: a Browse download would be refused too.
    const d = qstate.disk;
    if (d && d.low && !cur) return `<div class="runrow stop"><b>Stopped: disk nearly full</b><span class="what">${esc(String(d.freeGb))} GB free where downloads go, under the ${esc(String(d.minGb))} GB limit. ${waiting.length ? wait + '; nothing' : 'Nothing'} starts until there is room, checked every ten minutes</span><span class="grow"></span>${extra}</div>`;
    // wcostream unreadable (18 Nov 2026): Byparr down, a challenge it cannot pass, or a new page layout.
    const w = qstate.wco;
    if (w && !w.ok && !cur) return `<div class="runrow stop"><b>wcostream can't be read</b><span class="what">${esc((w.why || '').replace(/^./, (c) => c.toUpperCase()))}${w.since ? ' (since ' + when(w.since) + ')' : ''}. Downloads wait and start again by themselves once it reads (checked every ten minutes); no episode counts as missing from wcostream meanwhile</span><span class="grow"></span>${extra}</div>`;
    if (!cur && !waiting.length) return '';
    if (qstate.paused && !cur) return `<div class="runrow"><b>Paused</b><span class="what">${wait}; nothing starts until you press Resume in the queue</span><span class="grow"></span>${extra}</div>`;
    if (cur) {
      const p = cur.e.state === 'importing' ? 100 : cur.e.progress ?? 0;
      return `<div class="runrow"><b>${cur.e.state === 'importing' ? 'Importing' : 'Downloading'}</b><span class="what">${esc(cur.j.title)} <span class="code">${cur.e.s}x${pad(cur.e.e)}</span> ${esc(cur.e.title)}</span>` +
        `<span class="grow"></span><span class="meta">${cur.e.state === 'importing' ? '' : p + '% · '}${wait}${qstate.paused ? ' · paused after this one' : ''}</span>${extra}</div>${prog(p, 'Current episode')}`;
    }
    const night = waiting.every((x) => x.j.auto);
    return `<div class="runrow"><b>${night ? 'Waiting for tonight' : 'Starting'}</b><span class="what">${wait}${night ? '; overnight runs go between ' + window.wcoNight() : ''}</span><span class="grow"></span>${extra}</div>`;
  }

  // ---------- Queue panel: what is running, what waits (in the order it will run), then finished runs ----------
  const qopen = new Set(); let lastQ = null;
  function renderQueue() {
    const active = allRuns.reduce((a, j) => a + j.episodes.filter((e) => ACTIVE.includes(e.state)).length, 0);
    UI.setCounts({ queue: active });
    if ($('queue').hidden) return;
    const now = nowLine();
    $('queuenow').hidden = !now; if ($('queuenow').dataset.h !== now) { $('queuenow').dataset.h = now; $('queuenow').innerHTML = now; smooth($('queuenow'), 'queue'); }
    const open = new Set([...document.querySelectorAll('.qeps pre')].map((p) => p.dataset.key));
    // The server works through runs oldest first, so waiting runs are listed in that order; finished ones newest first.
    const rank = (j) => (j.episodes.some(isWorking) ? 0 : isLive(j) ? 1 : 2);
    const runs = allRuns.map((j, i) => ({ j, i, r: rank(j) })).sort((a, b) => a.r - b.r || (a.r === 1 ? b.i - a.i : a.i - b.i)).slice(0, 20).map((x) => x.j);
    const html = queueErr && !allRuns.length ? `<p class="status err">Could not read the queue: ${esc(queueErr)}</p>` : runs.length ? runs.map((j) => {
      const n = (st) => j.episodes.filter((e) => e.state === st).length;
      const live = isLive(j), all = qopen.has(j.id);
      const bits = Object.keys(STATE_TEXT).filter((st) => n(st)).map((st) => `${n(st)} ${STATE_TEXT[st]}`).join(' · ');
      const rows = j.episodes.filter((e) => e.state !== 'cancelled' && (all || e.state !== 'done'));
      const hidden = j.episodes.filter((e) => e.state !== 'cancelled').length - rows.length;
      return `<article class="qrun" data-id="${j.id}"><header>${UI.poster(j.seriesId, j.title)}<b>${esc(j.title)}</b>${j.auto ? '<span class="tag">overnight</span>' : ''}
        <span class="meta">${when(j.createdAt)} · ${j.language || 'default'} · ${bits}</span>
        <span class="grow"></span>${live && !j.episodes.some(isWorking) ? `<button class="btn" data-act="next" type="button" title="${j.auto ? 'Start this overnight run now, ahead of everything waiting' : 'Move this run to the head of the queue'}">${UI.icon('next')}${j.auto ? 'Run now' : 'Run next'}</button>` : ''}
        ${live ? `<button class="btn btn-quiet" data-act="cancel" type="button">${UI.icon('x')}Cancel</button>` : ''}
        ${!live && (n('failed') || n('kept') || n('cancelled')) ? `<button class="btn" data-act="retry" type="button" title="Tries them again; a partial download resumes">${UI.icon('retry')}Retry ${n('failed') + n('kept') + n('cancelled')}</button>` : ''}
        <a class="linkbtn" href="/map.html?url=${encodeURIComponent(j.slug)}">Open map</a></header>
        <ul class="qeps">${rows.map((e) => {
          const key = j.id + ':' + e.id, bad = e.state === 'failed' || e.state === 'kept';
          const st = e.state === 'downloading' ? `${e.progress ?? 0}%` : STATE_TEXT[e.state];
          return `<li><span class="code">${e.s}x${pad(e.e)}</span><span>${esc(e.title)}${e.mode === 'swap' ? ' <span class="tag">swap</span>' : ''}
            ${e.message ? `<span class="msg">${esc(e.message)}</span>` : ''}</span>
            <span class="st ${bad ? 'bad' : e.state === 'done' ? 'ok' : ACTIVE.includes(e.state) ? 'live' : ''}">${esc(st)}
            ${bad || e.state === 'premium' ? ` · <button class="linkbtn" data-log="${key}" type="button">Log</button>` : ''}</span>
            ${open.has(key) ? `<pre data-key="${key}">Loading…</pre>` : ''}</li>`;
        }).join('')}${hidden || qopen.has(j.id) ? `<li class="hint"><span></span><span><button class="linkbtn" data-toggle="${j.id}" type="button">${hidden ? `Show the ${hidden} done` : 'Hide the ones done'}</button></span><span></span></li>` : ''}
        ${n('cancelled') ? `<li class="hint"><span></span><span>${n('cancelled')} cancelled${j.episodes.some((e) => /earlier run/.test(e.message || '')) ? ' (already queued in an earlier run)' : ''}</span><span></span></li>` : ''}</ul></article>`;
    }).join('') : '<p class="hint">No runs yet. Pick episodes on a show\'s map and they appear here.</p>';
    if (html === lastQ) return;                        // unchanged: leave the list alone so focus and open logs stay put
    lastQ = html; $('queuelist').innerHTML = html;
    for (const k of open) loadLog(k);
  }
  async function loadLog(key) {
    const [jid, eid] = key.split(':');
    const li = $('queuelist').querySelector(`[data-log="${key}"]`)?.closest('li'); if (!li) return;
    let pre = li.querySelector('pre');
    if (!pre) { pre = document.createElement('pre'); pre.dataset.key = key; li.appendChild(pre); }
    try { const r = await fetch(`/fill/jobs/${jid}/log/${eid}`); pre.textContent = await r.text(); } catch (e) { pre.textContent = 'Could not read the log: ' + e.message; }
  }
  $('queuelist').addEventListener('click', async (ev) => {
    const log = ev.target.closest('[data-log]');
    if (log) { const li = log.closest('li'), pre = li.querySelector('pre'); if (pre) pre.remove(); else loadLog(log.dataset.log); return; }
    const tog = ev.target.closest('[data-toggle]');
    if (tog) { const id = tog.dataset.toggle; qopen.has(id) ? qopen.delete(id) : qopen.add(id); renderQueue(); return; }
    const act = ev.target.closest('[data-act]'); if (!act) return;
    const id = act.closest('.qrun').dataset.id;
    try { await api('POST', `/fill/jobs/${id}/${act.dataset.act}`, {}); }
    catch (e) { status(`Could not ${act.dataset.act} that run: ${e.message}`, true); }
    poll();
  });
  function openQueue(on) {
    if (on) reveal($('queue')); else $('queue').hidden = true;
    $('queuebtn').setAttribute('aria-expanded', String(on));
    if (on) { lastQ = null; renderQueue(); poll(); $('queue').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  }
  $('queuebtn').onclick = () => openQueue($('queue').hidden);
  $('queueclose').onclick = () => { openQueue(false); $('queuebtn').focus(); };
  $('pausebtn').onclick = async () => {
    try { qstate = await api('POST', '/fill/pause', { paused: !qstate.paused }); toast(qstate.paused ? 'Paused: the episode in hand finishes, nothing new starts' : 'Resumed'); }
    catch (e) { status(`Could not ${qstate.paused ? 'resume' : 'pause'} the queue: ${e.message}`, true); }
    lastQ = null; poll();
  };

  // ---------- Follow, and the home screen that lists what is followed ----------
  function setFollow(on) {
    $('follow').setAttribute('aria-pressed', String(on));   // the label follows in CSS: "Following overnight" when pressed
  }
  $('follow').onclick = async () => {
    if (!show?.series) return;
    const on = $('follow').getAttribute('aria-pressed') !== 'true';
    if (!on) { unfollow({ slug: show.slug, seriesId: show.series.id, title: show.series.title, language: lang() }); return; }
    UI.unhold('unfollow:' + show.slug);                // following again by hand within the six seconds: the unfollow is dropped
    gone.delete(show.slug);
    try {
      await api('POST', '/follow', { slug: show.slug, seriesId: show.series.id, follow: on, language: lang(), absolute: !!show.absolute });
      setFollow(on); show.follow = on;
      toast(`Following: gaps${lang() === 'dub' ? ' and dub swaps' : ''} fill between ${window.wcoNight()}`);
      loadFollowed();
    } catch (e) { status(`Could not change following: ${e.message}`, true); }
  };
  // Unfollow acts on screen at once (the row goes, the switch turns off) and offers Undo. The request is held back
  // until the toast leaves, so Undo has nothing to take back on the server; the numbering it had is not touched.
  const gone = new Set();                              // slugs unfollowed on screen, their request not sent yet
  function unfollow(x) {
    const name = x.title || x.slug, mine = () => show?.series && show.slug === x.slug;
    const next = rowOf(x.slug)?.nextElementSibling || rowOf(x.slug)?.previousElementSibling;
    const hadFocus = rowOf(x.slug)?.contains(document.activeElement);
    gone.add(x.slug);
    if (mine()) { setFollow(false); show.follow = false; }
    renderHome();
    if (hadFocus) (next?.querySelector('a') || $('pagetitle')).focus({ preventScroll: true });   // the pressed button went with its row
    toast(`Unfollowed ${name}`, { key: 'unfollow:' + x.slug,
      commit: async (keepalive) => {
        try { await post('/follow', { slug: x.slug, seriesId: x.seriesId, follow: false, language: x.language === 'sub' ? 'sub' : 'dub' }, keepalive); }
        catch (e) { status(`Could not unfollow ${name}: ${e.message}`, true); if (mine()) { setFollow(true); show.follow = true; } }
        followed = followed.filter((f) => f.slug !== x.slug || !gone.has(x.slug));
        await loadFollowed(); gone.delete(x.slug); renderHome();
      },
      undo: () => {
        gone.delete(x.slug);
        if (mine()) { setFollow(true); show.follow = true; }
        renderHome();
        rowOf(x.slug)?.querySelector('[data-unfollow]')?.focus({ preventScroll: true });
      } });
  }
  $('followedlist').addEventListener('click', async (ev) => {
    const h = ev.target.closest('[data-handoff]');
    if (h) {
      const x = followed.find((f) => f.slug === h.closest('li').dataset.key); if (!x) return;
      h.disabled = true;
      try { const r = await api('POST', '/followed/hand-off', { slug: x.slug }); toast(`${x.title || x.slug}: ${r.monitored} episode${r.monitored === 1 ? '' : 's'} handed to Sonarr${r.searched ? ', searched for now' : ', for Sonarr to find'}; no longer followed`); await loadFollowed(); }
      catch (e) { h.disabled = false; status(`Could not hand it to Sonarr: ${e.message}`, true); }
      return;
    }
    const b = ev.target.closest('[data-unfollow]'); if (!b) return;
    const x = followed.find((f) => f.slug === b.closest('li').dataset.key);
    if (x) unfollow(x);
  });
  // The list answers at once from what the server last knew. While it asks Sonarr again behind that answer it says so
  // in a header (X-Followed-Refreshing: 1): then the list is asked for again every 2 seconds, for 45 seconds at most,
  // and redrawn only if something changed; a row whose counts changed fades briefly.
  let followed = [], followedLoaded = false, refreshT = null, refreshUntil = 0, homeY = 0, fkindSet = false;
  async function loadFollowed() {
    clearTimeout(refreshT);
    let list, refreshing = false;
    try {
      const r = await fetch('/followed');
      if (!r.ok) throw new Error(String(r.status));
      refreshing = r.headers.get('X-Followed-Refreshing') === '1';
      list = await r.json();
    } catch { list = followed; }
    if (refreshing && !refreshUntil) refreshUntil = Date.now() + 45000;
    const again = refreshing && Date.now() < refreshUntil;
    if (!again) refreshUntil = 0;
    $('fupdating').hidden = !again;
    const was = new Map(followed.map((x) => [x.slug, x])), first = !followedLoaded;
    const same = !first && JSON.stringify(list) === JSON.stringify(followed);
    followed = list; followedLoaded = true;
    UI.setFollowed(list);
    if (!same) {
      renderHome();
      if (first && homeY && view === 'home') scrollTo(0, homeY);
      if (!first) for (const x of list) {
        const o = was.get(x.slug);
        if (o && (o.missing !== x.missing || o.undub !== x.undub)) flash(x.slug);
      }
    }
    if (again) refreshT = setTimeout(loadFollowed, 2000);
  }
  function flash(slug) {
    const li = [...$('followedlist').children].find((el) => el.dataset.key === slug); if (!li) return;
    li.classList.add('changed');
    li.addEventListener('animationend', () => li.classList.remove('changed'), { once: true });
  }
  function renderHome() {
    if ($('empty').hidden) return;
    const now = nowLine('<button class="linkbtn" id="nowqueue" type="button">Open the queue</button>');
    $('now').hidden = !now;
    if ($('now').dataset.h !== now) { $('now').dataset.h = now; $('now').innerHTML = now; smooth($('now'), 'home'); $('nowqueue')?.addEventListener('click', () => openQueue(true)); }
    const act = new Map();                             // seriesId -> what the queue is doing for that show
    for (const j of allRuns) for (const e of j.episodes) if (ACTIVE.includes(e.state)) {
      const a = act.get(j.seriesId) || { n: 0, cur: null }; a.n++; if (isWorking(e)) a.cur = e; act.set(j.seriesId, a);
    }
    renderAttention(); renderLinks(); renderStage(); renderNight(); renderSwitch();
    if (!followedLoaded) return;                       // the still grey rows stay until the first answer
    $('followedlist').removeAttribute('aria-busy');
    const f = $('ffilter').value.trim().toLowerCase(), name = (x) => x.title || x.slug;
    const needs = (x) => x.missing > 0 || x.undub > 0;
    const counted = followed.map((x) => x.countedAt).filter(Boolean).sort()[0];
    $('fcounted').textContent = ' · ' + (counted ? `counted ${when(counted)}` : 'not counted yet, so dub swaps are not shown');
    // The list opens on what needs work: Incomplete, or All when nothing is incomplete. After that the choice is yours.
    const here = followed.filter((x) => !gone.has(x.slug)), lacking = here.filter(needs).length;
    if (!fkindSet) { fkindSet = true; setSeg('fkind', lacking ? 'incomplete' : 'all'); }
    const incomplete = $('fkind').querySelector('[aria-pressed=true]').dataset.v === 'incomplete';
    $('fincomplete').textContent = String(lacking); $('fall').textContent = String(here.length);
    const list = followed.filter((x) => !gone.has(x.slug) && (!f || name(x).toLowerCase().includes(f)) && (!incomplete || needs(x))).sort((a, b) => name(a).localeCompare(name(b), 'en', { sensitivity: 'base' }));
    $('fhead').hidden = !followed.length;
    $('fcount').textContent = here.length ? String(here.length) : '';
    $('fnone').textContent = !followed.length ? 'Paste a show link above to see its episodes. Shows you follow are listed here.'
      : !list.length ? (f ? `No followed show matches "${$('ffilter').value.trim()}".` : 'Every followed show has all its aired episodes, in the audio you follow it in.') : '';
    $('fnone').hidden = !$('fnone').textContent;
    UI.patchList($('followedlist'), list.map((x) => {
      const a = act.get(x.seriesId);
      const marks = (x.language === 'sub' ? '<span class="tag">sub</span>' : '') +
        (x.switchTo ? `<span class="tag" title="Numbered ${x.switchTo === 'absolute' ? 'straight through' : 'by season'}, wcostream would supply more of this show's missing episodes. Open the show to switch.">check numbering</span>` : '') +
        (x.resting ? `<span class="tag" title="wcostream's video server refuses this show: its missing episodes went to Sonarr, and it is tried again after the rest">videos refused, resting to ${new Date(x.resting).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>` : '') +
        (x.linkWrong ? `<span class="tag gapmark" title="The overnight run leaves it out: ${esc(x.linkWrong)}">wrong link?</span>` : '') +
        (!x.linkWrong && needs(x) && x.onWco === 0 ? `<span class="tag" title="Last time wcostream was read it listed none of this show's missing episodes. Sonarr gets them as they become due; wcostream is read again every few days.">none on wcostream</span>`
          : !x.linkWrong && needs(x) && x.onWco > 0 && x.onWco < (x.missing || 0) + (x.undub || 0) ? `<span class="tag" title="Last time wcostream was read it listed ${x.onWco} of the episodes this show needs">${x.onWco} on wcostream</span>`
          : x.unlisted > 0 ? `<span class="tag" title="Last night's plan found ${x.unlisted} episode${x.unlisted === 1 ? '' : 's'} that wcostream does not list, so they were not queued">${x.unlisted} not on wcostream</span>` : '') +
        ((x.split || []).length ? `<span class="tag" title="Also in a folder Sonarr does not track: ${esc(x.split.join(', '))}. Some of the missing episodes may be there.">split</span>` : '');
      const lacks = needs(x) ? `<span class="gapmark">${[x.missing > 0 && x.missing + ' missing', x.undub > 0 && x.undub + ' to dub'].filter(Boolean).join(' · ')}</span>`
        : `<span>${x.countedAt ? 'Complete' : 'Not counted yet'}</span>`;
      return { key: x.slug, html: `<li><a class="frow" href="/map.html?url=${encodeURIComponent(x.slug)}" title="${esc(name(x))}">${UI.poster(x.seriesId, name(x))}` +
        `<span class="ft"><b class="fname">${esc(name(x))}</b><span class="fmeta">${lacks}${marks}</span></span></a>` +
        (a ? `<span class="live">${a.cur ? (a.cur.state === 'downloading' ? (a.cur.progress ?? 0) + '%' : 'importing') : a.n + ' queued'}</span>` : '') +
        (!x.linkWrong && needs(x) && x.onWco === 0 ? `<button class="btn btn-quiet" data-handoff type="button" aria-label="Hand ${esc(name(x))} to Sonarr" title="wcostream has none of its missing episodes: Sonarr monitors and searches for them, and it is no longer followed">Hand to Sonarr</button>` : '') +
        `<button class="btn btn-quiet danger" data-unfollow type="button" aria-label="Unfollow ${esc(name(x))}">${UI.icon('x')}Unfollow</button></li>` };
    }));
  }
  // Needs you, by show (15 Nov 2026): one row per show with what went wrong in a line, one Retry for all of its
  // episodes that can be retried, and its episodes behind a disclosure with their own Retry, Log and Dismiss. The first
  // ten shows are listed, the rest behind "Show all". The counts in the heading and the header stay episode counts.
  // The premium label says all the server's message does, so a premium episode shows the label alone.
  const ATTN = { failed: 'Failed', kept: 'Downloaded, not imported', premium: 'Premium-only: Sonarr is searching' };
  const ATTN_SHORT = { failed: 'failed', kept: 'not imported', premium: 'premium only' };
  const canRetry = (a) => a.state === 'failed' || a.state === 'kept';
  const aopen = new Set(), alog = new Map(); let aall = false;
  function attnGroups() {
    const by = new Map();
    for (const a of attnShown()) { const k = 'g' + (a.seriesId || a.slug); if (!by.has(k)) by.set(k, { key: k, show: a.show, slug: a.slug, seriesId: a.seriesId, eps: [] }); by.get(k).eps.push(a); }
    for (const g of by.values()) g.eps.sort((x, y) => x.s - y.s || x.e - y.e);
    return [...by.values()];
  }
  function renderAttention() {
    const groups = attnGroups(), n = groups.reduce((t, g) => t + g.eps.length, 0);
    $('attention').hidden = !n;
    $('attnhead').textContent = n ? String(n) : '';
    const rows = (aall ? groups : groups.slice(0, 10)).map((g) => {
      const count = (st) => g.eps.filter((a) => a.state === st).length, states = Object.keys(ATTN_SHORT).filter(count);
      const what = states.length === 1 ? ATTN_SHORT[states[0]] : states.map((st) => `${count(st)} ${ATTN_SHORT[st]}`).join(', ');
      const again = g.eps.filter(canRetry).length, open = aopen.has(g.key), id = 'aeps-' + g.key;
      return { key: g.key, html: `<li><div class="ahead">${UI.poster(g.seriesId, g.show)}<span class="ft"><b>${esc(g.show)}</b><span class="msg">${g.eps.length} episode${g.eps.length === 1 ? '' : 's'} · ${what}</span></span>
        <span class="acts">${again ? `<button class="btn" data-g="retry" type="button" aria-label="Retry ${again} episode${again === 1 ? '' : 's'} of ${esc(g.show)}">${UI.icon('retry')}Retry ${again}</button>` : ''}
        <a class="linkbtn" href="/map.html?url=${encodeURIComponent(g.slug)}">Open map</a>
        <button class="linkbtn more" data-g="open" type="button" aria-expanded="${open}" aria-controls="${id}" aria-label="Episodes of ${esc(g.show)}">Episodes</button></span></div>` +
        (open ? `<ul class="aeps" id="${id}">${g.eps.map((a) => {
          const key = akey(a);
          return `<li data-job="${a.jobId}" data-ep="${a.id}"><span class="code">${a.s}x${pad(a.e)}</span><span class="what">${esc(a.title)}${a.mode === 'swap' ? ' <span class="tag">swap</span>' : ''}
            <span class="msg">${esc(ATTN[a.state])}${a.message && a.state !== 'premium' ? ': ' + esc(a.message) : ''} · ${when(a.at)}${a.auto ? ' · overnight' : ''}</span></span>
            <span class="acts">${canRetry(a) ? `<button class="btn" data-a="retry" type="button">${UI.icon('retry')}Retry</button>` : ''}<button class="linkbtn" data-a="log" type="button" aria-expanded="${alog.has(key)}">Log</button>
            <button class="linkbtn danger" data-a="dismiss" type="button">Dismiss</button></span>
            ${alog.has(key) ? `<pre data-key="${key}">${esc(alog.get(key))}</pre>` : ''}</li>`;
        }).join('')}${g.eps.length > 1 ? `<li class="aend"><button class="linkbtn danger" data-g="dismiss" type="button">Dismiss all ${g.eps.length}</button></li>` : ''}</ul>` : '') + '</li>' };
    });
    if (!aall && groups.length > 10) rows.push({ key: 'more', html: `<li class="amore"><button class="linkbtn" data-more type="button">Show all ${groups.length} shows</button></li>` });
    UI.patchList($('attnlist'), rows);
  }
  // Old downloads in staging: kept or failed episodes leave their file there. Deleting cannot be undone, so it asks twice.
  function renderStage() {
    const o = stage?.old, n = o?.folders ?? 0;
    if (!n) { $('stage').hidden = true; stageAsk = false; return; }
    const what = `${n} download${n === 1 ? '' : 's'}`, size = (o.bytes / 1024 ** 3).toFixed(1) + ' GB';
    const html = stageAsk
      ? `<span>Delete ${what} (${size})? They cannot be brought back, only downloaded again.</span><button class="btn danger" data-s="yes" type="button">Delete ${n}</button><button class="linkbtn" data-s="no" type="button">Keep them</button>`
      : `<span>Staging holds ${what} untouched for ${stage.days} days and never imported (${size}).</span><button class="btn btn-quiet" data-s="ask" type="button">${UI.icon('x')}Delete them…</button>`;
    $('stage').hidden = false;
    if ($('stage').dataset.h !== html) { $('stage').dataset.h = html; $('stage').innerHTML = html; }
  }
  // Linked to the wrong show (18 Nov 2026): the nightly link check found a followed show whose list on wcostream looks
  // like another show. Find the right one (a wcostream search for the Sonarr title), say the link is right, or unfollow.
  function renderLinks() {
    const bad = followed.filter((x) => x.linkWrong);
    $('wronglinks').hidden = !bad.length;
    $('wlcount').textContent = bad.length || '';
    UI.patchList($('wllist'), bad.map((x) => ({ key: x.slug, html: `<li data-key="${esc(x.slug)}"><div class="ahead">${UI.poster(x.seriesId, x.title)}<span class="ft"><b>${esc(x.title)}</b>` +
      `<span class="msg">Linked to <code>${esc(x.slug)}</code>: ${esc(x.linkWrong)}</span></span>` +
      `<span class="acts"><button class="btn" data-wl="find" type="button">${UI.icon('search')}Find it on wcostream</button>` +
      `<button class="linkbtn" data-wl="ok" type="button">The link is right</button>` +
      `<button class="linkbtn danger" data-wl="unfollow" type="button" aria-label="Unfollow ${esc(x.title)}">Unfollow</button></span></div></li>` })));
  }
  $('wllist').addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-wl]'); if (!b) return;
    const x = followed.find((f) => f.slug === b.closest('li').dataset.key); if (!x) return;
    if (b.dataset.wl === 'find') { nameSearch(x.title); return; }
    if (b.dataset.wl === 'unfollow') { unfollow(x); return; }
    b.disabled = true;
    try { await api('POST', '/links/ok', { slug: x.slug }); x.linkWrong = undefined; toast(`${x.title}: the link stays, and is not checked again`); renderHome(); }
    catch (e) { status(`Could not keep the link: ${e.message}`, true); b.disabled = false; }
  });

  // Why episodes failed, as the server names them (19 Nov 2026).
  const KIND_WORDS = { blocked: 'blocked (wcostream could not be read)', refused: 'refused by the video server', 'no-player': 'with no video player (premium or removed)', unlisted: 'not listed on wcostream',
    misnamed: 'named as another episode', 'not-dub': 'not a dub', unplayable: 'would not play or too short', stalled: 'stalled', other: 'other' };
  const KIND_SHORT = { blocked: 'blocked', refused: 'refused', 'no-player': 'no player', unlisted: 'not listed', misnamed: 'misnamed', 'not-dub': 'not a dub', unplayable: 'would not play', stalled: 'stalled', other: 'other' };

  // "Check every link" (19 Nov 2026): while it runs the followed list's heading says how far it has got; when it ends
  // the list is asked for again, so a show linked to another show appears under "Linked to the wrong show?".
  // The other numbering would supply more (22 Nov 2026): one press switches every such followed show.
  function renderSwitch() {
    const sw = followed.filter((x) => x.switchTo);
    $('fswitch').hidden = !sw.length;
    if (sw.length) $('fswitch').innerHTML = ` · ${sw.length} would get more with the other numbering <button class="linkbtn" id="doswitch" type="button">Switch ${sw.length === 1 ? 'it' : 'them'}</button>`;
  }
  $('fswitch').addEventListener('click', async (ev) => {
    if (!ev.target.closest('#doswitch')) return;
    const sw = followed.filter((x) => x.switchTo); let n = 0;
    for (const x of sw) { try { await api('GET', `/show?url=${encodeURIComponent(x.slug)}&absolute=${x.switchTo === 'absolute'}`); n++; } catch { /* left as it was */ } }
    toast(`Switched the numbering of ${n} show${n === 1 ? '' : 's'}`); await loadFollowed();
  });
  let linksWere = false;
  function renderLinkCheck() {
    const l = qstate.links;
    $('flinks').hidden = !l;
    if (l) $('flinks').textContent = ` · checking links on wcostream: ${l.done} of ${l.total}${l.wrong ? `, ${l.wrong} look wrong` : ''}`;
    if (linksWere && !l) loadFollowed();
    linksWere = !!l;
  }
  UI.hooks.linksStarted = () => { linksWere = true; poll(); };

  // Last night (18 Nov 2026): what the automatic runs did, as the phone message said it, with a link to each show.
  // Shown for a day and a half after the runs finished; the phone message links here (#night) and opens it.
  function renderNight() {
    const r = lastRun;
    if (!r?.at || Date.now() - new Date(r.at).getTime() > 36 * 3600000) { $('night').hidden = true; return; }
    const t = r.tally, n = (k, word) => (t[k] ? `${t[k]} ${word}` : '');
    const said = [n('filled', 'filled'), n('swapped', 'swapped to dub'), n('premium', 'handed to Sonarr'), n('kept', 'to check'), n('failed', 'failed')].filter(Boolean);
    const hm = (s) => new Date(s).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const today = new Date(r.at).toDateString() === new Date().toDateString();
    const head = r.kind === 'now' ? 'Fill now' : today ? 'Last night' : 'Overnight, ' + new Date(r.at).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    const extra = r.shows.length + r.notes.length + Object.keys(r.reasons || {}).length + (r.waiting || 0);
    const sum = `<b>${esc(head)}</b><span class="meta">${hm(r.from)} to ${hm(r.at)}</span><span class="what">${said.length ? esc(said.join(', ')) : 'Nothing new came in'}</span>` +
      (extra ? `<span class="more">${r.shows.length ? `${r.shows.length} show${r.shows.length === 1 ? '' : 's'}` : 'Details'}${UI.icon('chev')}</span>` : '');
    const top = (why) => Object.entries(why || {}).sort((a, b) => b[1] - a[1])[0]?.[0];
    const word = (x) => [x.filled && `${x.filled} filled`, x.swapped && `${x.swapped} swapped`, x.premium && `${x.premium} to Sonarr`, x.kept && `${x.kept} to check`,
      x.failed && `<span class="gapmark">${x.failed} failed${top(x.why) ? ` (${esc(KIND_SHORT[top(x.why)] || top(x.why))})` : ''}</span>`].filter(Boolean).join(' · ');
    const why = Object.entries(r.reasons || {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${KIND_WORDS[k] || k}`);
    const body = (r.shows.length ? `<ul class="flist">${r.shows.map((x) => `<li><a class="frow" href="/map.html?url=${encodeURIComponent(x.slug)}">${UI.poster(x.seriesId, x.title)}` +
      `<span class="ft"><span class="fname">${esc(x.title)}</span><span class="fmeta">${word(x)}</span></span></a></li>`).join('')}</ul>` : '') +
      (why.length || r.waiting ? `<p class="why">${why.length ? `Why: ${esc(why.join(', '))}.` : ''}${r.waiting ? ` ${r.waiting} wait for the next night (parked after the video server refused them).` : ''}</p>` : '') +
      (r.notes.length ? `<ul class="notes">${r.notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '');
    $('night').hidden = false;
    $('nightsum').tabIndex = extra ? 0 : -1;
    if ($('night').dataset.h !== sum + body) { $('night').dataset.h = sum + body; $('nightsum').innerHTML = sum; $('nightbody').innerHTML = body; }
  }
  $('nightsum').addEventListener('click', (ev) => { if ($('nightsum').tabIndex < 0) ev.preventDefault(); });   // nothing to open
  function showNight() {
    if ($('night').hidden) return;
    $('night').open = true;
    $('night').scrollIntoView({ block: 'start', behavior: reduce.matches ? 'auto' : 'smooth' });
  }

  $('stage').addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-s]'); if (!b) return;
    if (b.dataset.s !== 'yes') { stageAsk = b.dataset.s === 'ask'; renderStage(); $('stage').querySelector('button')?.focus(); return; }
    b.disabled = true;
    try {
      const r = await api('POST', '/fill/staging/clear', {});
      toast(`Deleted ${r.folders} old download${r.folders === 1 ? '' : 's'}, ${(r.bytes / 1024 ** 3).toFixed(1)} GB`);
    } catch (e) { status(`Could not delete the old downloads: ${e.message}`, true); }
    stageAsk = false;
    await loadAttention(true);
    if ($('stage').hidden) $('pagetitle').focus({ preventScroll: true });
  });
  async function attnLog(key) {
    const [jid, eid] = key.split(':');
    alog.set(key, 'Loading…'); renderAttention();
    let text;
    try { const r = await fetch(`/fill/jobs/${jid}/log/${eid}`); text = await r.text(); } catch (e) { text = 'Could not read the log: ' + e.message; }
    if (alog.has(key)) { alog.set(key, text); renderAttention(); }
  }
  // Dismiss acts on screen at once and offers Undo; there is no un-dismiss on the server, so the requests are held
  // back until the toast leaves. Rows dismissed one after another share one toast, and one Undo brings them all back.
  const dismissed = new Set(); let batch = [];
  const akey = (a) => a.jobId + ':' + a.id;
  const attnShown = () => attention.filter((a) => !dismissed.has(akey(a)));
  function showAttention() { UI.setCounts({ attention: attnShown().length }); renderHome(); }
  function dismiss(rows) {
    for (const a of rows) { dismissed.add(akey(a)); batch.push(a); }
    const mine = batch;
    showAttention();
    toast(`Dismissed ${mine.length} episode${mine.length === 1 ? '' : 's'}`, { key: 'dismiss',
      commit: async (keepalive) => {
        if (batch === mine) batch = [];
        const sent = await Promise.allSettled(mine.map((a) => post(`/fill/jobs/${a.jobId}/dismiss/${a.id}`, {}, keepalive)));
        if (sent.some((r) => r.status === 'rejected')) status('Could not dismiss every episode: the ones still here were not dismissed.', true);
        await loadAttention(true);
        for (const a of mine) dismissed.delete(akey(a));
        showAttention();
      },
      undo: () => { if (batch === mine) batch = []; for (const a of mine) dismissed.delete(akey(a)); showAttention(); } });
  }
  // A row that goes takes the focus with it: put it on the nearest thing left in the list, or the page's heading.
  const keepFocus = (had) => { if (had && !$('attnlist').contains(document.activeElement)) ($('attnlist').querySelector('a,button') || $('pagetitle')).focus({ preventScroll: true }); };
  $('attnlist').addEventListener('click', async (ev) => {
    if (ev.target.closest('[data-more]')) {
      aall = true; renderAttention();
      $('attnlist').children[10]?.querySelector('a,button')?.focus({ preventScroll: true });
      return;
    }
    const gb = ev.target.closest('[data-g]');
    if (gb) {
      const g = attnGroups().find((x) => x.key === gb.closest('#attnlist > li').dataset.key); if (!g) return;
      if (gb.dataset.g === 'open') { if (aopen.has(g.key)) aopen.delete(g.key); else aopen.add(g.key); renderAttention(); return; }
      if (gb.dataset.g === 'dismiss') { dismiss(g.eps); keepFocus(true); return; }
      const rows = g.eps.filter(canRetry); let n = 0;
      gb.disabled = true;
      for (const a of rows) { try { await api('POST', `/fill/jobs/${a.jobId}/retry/${a.id}`, {}); n++; } catch { /* it stays in the list */ } }
      toast(n === rows.length ? `Queued ${n} episode${n === 1 ? '' : 's'} of ${g.show} again: partial downloads resume` : `Queued ${n} of ${rows.length} again; the rest could not be queued`);
      await loadAttention(true); keepFocus(true); poll();
      return;
    }
    const b = ev.target.closest('[data-a]'); if (!b) return;
    const li = b.closest('li'), jid = li.dataset.job, eid = li.dataset.ep, key = jid + ':' + eid;
    if (b.dataset.a === 'log') { if (alog.has(key)) { alog.delete(key); renderAttention(); } else attnLog(key); return; }
    if (b.dataset.a === 'dismiss') { const a = attention.find((x) => x.jobId === jid && String(x.id) === eid); if (a) { dismiss([a]); keepFocus(true); } return; }
    try {
      await api('POST', `/fill/jobs/${jid}/retry/${eid}`, {});
      toast('Queued again: it resumes a partial download');
    } catch (e) { status(`Could not retry that episode: ${e.message}`, true); }
    await loadAttention(true); keepFocus(true); poll();
  });
  $('recount').onclick = async () => {
    $('recount').disabled = true; toast('Counting every followed show in Sonarr. This takes a minute.');
    try { const r = await api('POST', '/followed/recount', {}); toast(`Counted ${r.counted} shows`); await loadFollowed(); }
    catch (e) { status(`Could not recount: ${e.message}`, true); }
    $('recount').disabled = false;
  };
  $('ffilter').addEventListener('input', renderHome);
  $('fkind').addEventListener('click', (ev) => { const b = ev.target.closest('button'); if (b) { fkindSet = true; setSeg('fkind', b.dataset.v); renderHome(); } });
  $('ffilter').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') $('followedlist').querySelector('a')?.click(); });

  // On a phone the key to the squares and the numbering switch live inside the how-to, so the squares start sooner (15 Nov 2026).
  const phone = matchMedia('(max-width:720px)');
  function place() {
    if (phone.matches) $('help').querySelector('summary').after($('legend'), $('numbering'));
    else { $('tools').prepend($('legend')); $('controls').prepend($('numbering')); }
  }
  phone.addEventListener('change', place); place();

  // The how-to stays folded once read; the choice is remembered on this device.
  try { $('help').open = localStorage.getItem('wco-help') === 'open'; } catch { /* private window: stay folded */ }
  $('help').addEventListener('toggle', () => { try { localStorage.setItem('wco-help', $('help').open ? 'open' : 'closed'); } catch { /* not remembered */ } });

  // A link can name a show (?url=) or carry words to search for (?find=, what the header's search box sends from the other pages).
  // Links to this page are followed here, without loading it again: a show opens out of its row, Home goes back.
  document.addEventListener('click', (ev) => {
    if (ev.defaultPrevented || ev.button || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    const a = ev.target.closest?.('a[href]'); if (!a || a.target === '_blank') return;
    const u = new URL(a.href);
    if (u.origin !== location.origin || u.pathname !== location.pathname) return;
    ev.preventDefault();
    const slug = u.searchParams.get('url');
    if (slug) { if (a.closest('#queue')) openQueue(false); openShow(slug, { key: a.closest('#followedlist li')?.dataset.key }); }
    else if (a.id === 'trailhome' && history.state?.home) history.back();   // back to Home where you were on it
    else goHome({ hash: u.hash });
  });
  addEventListener('popstate', (ev) => {
    const p = new URLSearchParams(location.search), y = ev.state?.y || 0;
    if (p.get('url')) openShow(p.get('url'), { push: false, pop: true, y });
    else if (p.get('find')) nameSearch(p.get('find'), { push: false, y });
    else goHome({ push: false, pop: true, y, hash: location.hash });
  });

  // A link can name a show (?url=) or carry words to search for (?find=, what the header's search box sends from the other pages).
  // Coming back to this page with Back, or reloading it, returns to where it was scrolled once its content is drawn.
  const params = new URLSearchParams(location.search), q = params.get('url'), find = (params.get('find') || '').trim();
  const navType = performance.getEntriesByType?.('navigation')[0]?.type;
  const y0 = navType === 'back_forward' || navType === 'reload' ? history.state?.y || 0 : 0;
  if (q || find) $('empty').hidden = true;
  document.documentElement.classList.remove('deep');
  if (location.hash === '#queue') openQueue(true);
  homeY = q || find ? 0 : y0;
  loadFollowed();
  if (q) openShow(q, { push: false, y: y0 });
  else if (find && UI.isLink(find)) openShow(find, { push: false, y: y0 });
  else if (find) { $('url').value = find; $('sclear').hidden = false; $('skey').hidden = true; nameSearch(find, { push: false, y: y0 }); poll(); }
  else poll();
})();
