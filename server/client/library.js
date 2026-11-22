// Library gaps (11 Nov 2026): every animated Sonarr series with missing episodes, across all root folders, with its
// wco link or the wcostream shows of the same name. Server: GET /library/gaps, GET /library/search, POST /links.
(() => {
  const $ = (id) => document.getElementById(id);
  const UI = window.wcoUI;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // The screen opens on the rows that need a decision from you (several wcostream shows could be the one: pick it),
  // when there are any; "All" and the other states are one press away.
  // "Can't fill" (23 Nov 2026): linked shows with gaps that wcostream cannot supply, by reason, each with its fix.
  const KINDS = [['maybe', 'Needs a decision'], ['stuck', 'Can’t fill'], ['all', 'All'], ['following', 'Following'], ['linked', 'Linked, not followed'], ['ready', 'Ready to follow'], ['none', 'No match']];
  const kindOf = (r) => (r.state === 'exact' ? 'ready' : r.state);
  const stuck = (r) => !!r.slug && r.gaps > 0 && (!!r.linkWrong || !!r.resting || (r.onWco === 0 && !!r.gap));
  const inKind = (r, k) => k === 'all' || (k === 'stuck' ? stuck(r) : kindOf(r) === k);
  // The order the reasons are listed in: the ones a press fixes first.
  const REASONS = [['wrong', 'Linked to another show'], ['empty', 'Link lists nothing'], ['seasons', 'Seasons not on the page'], ['packaged', 'Not episodes on wcostream'],
    ['different', 'Other episodes under these numbers'], ['stops', 'wcostream stops early'], ['resting', 'Videos refused, resting'], ['unlisted', 'Not listed']];
  const reasonOf = (r) => (r.linkWrong ? 'wrong' : r.resting ? 'resting' : r.gap?.why || 'unlisted');
  let rows = [], drive = 'all', kind = 'all';

  async function api(method, url, body) {
    const r = await window.wcoBusy(url, fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }));
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.message ? [].concat(data.message).join('; ') : `The server answered ${r.status}`);
    return data;
  }
  function status(msg, err) { const s = $('status'); s.hidden = !msg; s.textContent = msg || ''; s.classList.toggle('err', !!err); }
  const toast = UI.toast;

  function seg(id, options, current) {
    $(id).innerHTML = options.map(([v, label, n]) => `<button type="button" data-v="${esc(v)}" aria-pressed="${v === current}">${esc(label)}${n !== undefined ? ` <span class="count">${n}</span>` : ''}</button>`).join('');
  }

  function render() {
    const inDrive = rows.filter((r) => drive === 'all' || r.root === drive);
    const drives = [...new Set(rows.map((r) => r.root))];
    seg('drive', [['all', 'All folders'], ...drives.map((d) => [d, d])], drive);
    seg('kind', KINDS.map(([v, label]) => [v, label, inDrive.filter((r) => inKind(r, v)).length]), kind);
    const f = $('filter').value.trim().toLowerCase();
    const list = inDrive.filter((r) => inKind(r, kind) && (!f || r.title.toLowerCase().includes(f)));
    const sum = (a, k) => a.reduce((n, r) => n + r[k], 0);
    const n = (k) => rows.filter((r) => kindOf(r) === k);
    $('tally').innerHTML = `<span><b>${rows.length}</b> series with work</span><span><b>${sum(rows, 'gaps').toLocaleString('en-GB')}</b> episodes missing</span>` +
      `<span><b>${n('following').length}</b> following</span><span><b>${n('linked').length}</b> linked, not followed</span><span><b>${n('ready').length}</b> ready to follow</span><span><b>${n('maybe').length}</b> need a decision</span><span><b>${n('none').length}</b> no match</span>`;
    const withWco = linkedRows();
    $('followlinked').hidden = !withWco.length;
    $('followlinkedlabel').textContent = `Follow the ${withWco.length} linked with episodes on wcostream`;
    const ready = readyRows();
    $('followall').hidden = !ready.length;
    $('followlabel').textContent = `Follow the ${ready.length} ready to follow${ready.length !== n('ready').length ? ' in this folder or filter' : ''}`;
    if (kind === 'stuck') {
      $('rows').innerHTML = list.length ? REASONS.map(([key, label]) => {
        const g = list.filter((r) => reasonOf(r) === key);
        return g.length ? `<h2 class="group">${esc(label)}<span class="hint">${g.length} series · ${sum(g, 'gaps').toLocaleString('en-GB')} episode${sum(g, 'gaps') === 1 ? '' : 's'} missing</span></h2><ul class="lib">${g.map(row).join('')}</ul>` : '';
      }).join('') : '<p class="empty">Every linked show with gaps has some of them on wcostream.</p>';
      return;
    }
    $('rows').innerHTML = list.length ? [...new Set(list.map((r) => r.root))].map((root) => {
      const g = list.filter((r) => r.root === root);
      return `<h2 class="group"><code>${esc(root)}</code><span class="hint">${g.length} series · ${sum(g, 'gaps').toLocaleString('en-GB')} episodes missing</span></h2><ul class="lib">${g.map(row).join('')}</ul>`;
    }).join('') : '<p class="empty">Nothing here matches.</p>';
  }

  // What "Follow the n ready to follow" acts on: the ready rows of the folder and name filter in use, whichever state tab is open.
  function readyRows() {
    const f = $('filter').value.trim().toLowerCase();
    return rows.filter((r) => (drive === 'all' || r.root === drive) && kindOf(r) === 'ready' && (!f || r.title.toLowerCase().includes(f)));
  }

  // Linked, not followed, and counted to have episodes on wcostream (22 Nov 2026: 257 linked shows held 3,874 gaps).
  function linkedRows() {
    const f = $('filter').value.trim().toLowerCase();
    return rows.filter((r) => (drive === 'all' || r.root === drive) && r.state === 'linked' && r.onWco > 0 && (!f || r.title.toLowerCase().includes(f)));
  }

  function row(r) {
    const map = (slug) => `<a class="linkbtn" href="/map.html?url=${encodeURIComponent(slug)}">Open map</a>`;
    const find = `<button class="linkbtn" data-find type="button">${r.state === 'none' ? 'Search wcostream' : 'Search for another'}</button>`;
    let match, acts;
    if (r.state === 'following' && kind === 'stuck') { match = fixes(r); acts = map(r.slug); }
    else if (r.state === 'following') { match = `<span class="tag ok">Following</span><span>${esc(r.slug)} · ${r.language}</span>${gapTag(r)}`; acts = map(r.slug); }
    else if (r.state === 'linked' && kind === 'stuck') { match = fixes(r); acts = `<button class="btn" data-follow type="button">${UI.icon('check')}Follow</button>${map(r.slug)}`; }
    else if (r.state === 'linked') { match = `<span>Linked: ${esc(r.slug)}</span>${r.onWco === undefined ? '' : r.onWco ? `<span class="tag">${r.onWco} on wcostream</span>` : gapTag(r)}`; acts = `<button class="btn" data-follow type="button">${UI.icon('check')}Follow</button>${map(r.slug)}`; }
    else if (r.state === 'exact') {
      const c = r.candidates[0];
      match = `<span>${esc(c.name)}</span>${c.language === 'sub' ? '<span class="tag">sub only</span>' : ''}${find}`;
      acts = `<button class="btn" data-follow type="button">${UI.icon('check')}Follow</button>${map(c.slug)}`;
    } else if (r.state === 'maybe') {
      match = `<select aria-label="wcostream show for ${esc(r.title)}"><option value="">Pick the wcostream show</option>${r.candidates.map((c, i) =>
        `<option value="${i}">${esc(c.name)}${c.language === 'sub' ? ' (sub only)' : ''}</option>`).join('')}</select>${find}`;
      acts = `<button class="btn" data-follow type="button">${UI.icon('check')}Follow</button>`;
    } else { match = `<span>No wcostream show by this name</span>${find}`; acts = ''; }
    return `<li data-id="${r.id}">${UI.poster(r.id, r.title)}<div class="name"><b title="${esc(r.title)}">${esc(r.title)}${r.year ? ` (${r.year})` : ''}</b><span title="${esc(r.path)}">${esc(r.path)}</span></div>` +
      `<div class="gaps">${[r.gaps > 0 && r.gaps + ' missing', r.undub > 0 && r.undub + ' to dub'].filter(Boolean).join(' · ')} <span>of ${r.total}</span>` +
      `${(r.split || []).length ? ` <span class="tag" title="Also in a folder Sonarr does not track: ${esc(r.split.join(', '))}. Some of the missing episodes may be there.">split</span>` : ''}</div><div class="match">${match}</div><div class="acts">${acts}</div></li>`;
  }

  // The reason tag for a linked row with none of its gaps on wcostream.
  function gapTag(r) {
    if (r.onWco !== 0 || r.linkWrong) return '';
    const g = UI.gapWords(r.gap) || UI.gapWords({ why: 'unlisted', left: r.gaps });
    return `<span class="tag" title="${esc(g.why)}">${esc(g.tag)}</span>`;
  }

  // What can be done about a show wcostream cannot fill: the reason in words, then one button per fix.
  function fixes(r) {
    const why = reasonOf(r), g = UI.gapWords(r.gap);
    const cap = (t) => t.replace(/^./, (c) => c.toUpperCase());
    const text = why === 'wrong' ? `The link ${r.slug} looks like another show: ${r.linkWrong}.` : why === 'resting'
      ? `wcostream's video server refuses this show; its missing episodes went to Sonarr. Tried again after ${new Date(r.resting).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}.`
      : g ? g.why.replace(/ from Library gaps/g, ' here').replace(/Relink it here/, 'Relink it below') : '';
    const out = [`<span class="fixwhy">${esc(text)}</span>`];
    const alts = r.candidates || [];
    if (why === 'wrong' || why === 'empty') {
      out.push(...alts.map((c) => `<button class="btn" data-relink="${esc(c.slug)}" data-lang="${c.language}" type="button" title="Follow ${esc(r.title)} from ${esc(c.name)} instead of ${esc(r.slug)}">${UI.icon('check')}Relink to ${esc(c.name)}${c.language === 'sub' ? ' (sub only)' : ''}</button>`));
      out.push(`<button class="linkbtn" data-find type="button">Search for another</button>`);
    }
    const missingSeasons = (r.gap?.seasons || []).filter((n) => !(r.notDubbed || []).includes(n));
    if (missingSeasons.length && why !== 'wrong') {
      const first = missingSeasons[0];
      out.push(...alts.map((c) => `<button class="btn" data-page="${esc(c.slug)}" data-season="${first}" type="button" title="Fetch Sonarr season ${first} of ${esc(r.title)} from ${esc(c.name)}">${UI.icon('plus')}Season ${first} is ${esc(c.name)}</button>`));
      out.push(`<button class="btn" data-nodub="${missingSeasons.join(',')}" type="button" title="Stop counting ${UI.seasonList(missingSeasons)} as missing; nothing of ${missingSeasons.length === 1 ? 'it' : 'them'} is fetched">${UI.icon('x')}${esc(cap(UI.seasonList(missingSeasons)))} never dubbed</button>`);
    }
    if (why === 'packaged') out.push(`<button class="btn" data-handoff type="button" title="Sonarr searches for the missing episodes; the show is no longer followed here">${UI.icon('next')}Hand to Sonarr</button>`);
    if ((r.notDubbed || []).length) out.push(`<span class="hint">${esc(cap(UI.seasonList(r.notDubbed)))} marked never dubbed.</span><button class="linkbtn" data-nodubundo type="button">Count again</button>`);
    if ((r.pages || []).length) out.push(`<span class="hint">${r.pages.map((p) => `Season ${p.season} from ${esc(p.slug)}`).join(', ')}.</span>`);
    return out.join('');
  }

  // The wco show a row would follow: its link, its one exact match, or the one picked in its list.
  function choice(r, li) {
    if (r.slug) return { slug: r.slug, language: r.language || 'dub' };
    if (r.state === 'exact') return r.candidates[0];
    const v = li?.querySelector('select')?.value;
    return v ? r.candidates[+v] : null;
  }
  // A pick for a row that already has a link replaces it (23 Nov 2026): the old link is unfollowed, not left beside it.
  async function follow(items) {
    const res = await api('POST', '/links', { items: items.map(({ r, c }) => ({ slug: c.slug, seriesId: r.id, follow: true, language: c.language,
      ...(r.slug && r.slug !== c.slug ? { replaces: r.slug } : {}) })) });
    const bad = new Set(res.skipped.map((s) => s.slug));
    for (const { r, c } of items) if (!bad.has(c.slug)) { r.state = 'following'; r.slug = c.slug; r.language = c.language; }
    render();
    toast(`Following ${res.linked} show${res.linked === 1 ? '' : 's'}: the overnight run fills them${res.skipped.length ? `. ${res.skipped.length} skipped: ${res.skipped[0].why}` : ''}`);
  }

  $('rows').addEventListener('click', async (ev) => {
    const li = ev.target.closest('li[data-id]'); if (!li) return;
    const r = rows.find((x) => x.id === +li.dataset.id);
    if (ev.target.closest('[data-follow]')) {
      const c = choice(r, li);
      if (!c) { toast('Pick the wcostream show first'); li.querySelector('select')?.focus(); return; }
      try { await follow([{ r, c }]); } catch (e) { status(`Could not follow ${r.title}: ${e.message}`, true); }
      return;
    }
    if (ev.target.closest('[data-find]')) {
      const m = li.querySelector('.match');
      m.innerHTML = `<input type="search" placeholder="Search wcostream by name" aria-label="Search wcostream for ${esc(r.title)}" value="${esc(r.title.replace(/\s*\(.*?\)\s*/g, ' ').trim())}"><div class="found"></div>`;
      const input = m.querySelector('input'); input.focus(); input.select(); search(input, r);
      return;
    }
    const relink = ev.target.closest('[data-relink]');
    if (relink) {
      try { await follow([{ r, c: { slug: relink.dataset.relink, language: relink.dataset.lang } }]); r.gap = undefined; r.linkWrong = undefined; r.onWco = undefined; render(); }
      catch (e) { status(`Could not relink ${r.title}: ${e.message}`, true); }
      return;
    }
    const page = ev.target.closest('[data-page]');
    if (page) {
      try {
        await api('POST', '/links/season-page', { slug: r.slug, page: page.dataset.page, season: +page.dataset.season });
        r.pages = [...(r.pages || []), { slug: page.dataset.page, season: +page.dataset.season }];
        r.gap = r.gap && { ...r.gap, seasons: (r.gap.seasons || []).filter((n) => n !== +page.dataset.season) };
        render(); toast(`Season ${page.dataset.season} now comes from ${page.dataset.page}; the overnight run fills it`);
      } catch (e) { status(`Could not link that page: ${e.message}`, true); }
      return;
    }
    const nodub = ev.target.closest('[data-nodub], [data-nodubundo]');
    if (nodub) {
      const seasons = nodub.dataset.nodub ? [...new Set([...(r.notDubbed || []), ...nodub.dataset.nodub.split(',').map(Number)])] : [];
      try {
        await api('POST', '/links/not-dubbed', { slug: r.slug, seasons });
        r.notDubbed = seasons; toast(seasons.length ? `${UI.seasonList(seasons).replace(/^./, (c) => c.toUpperCase())} no longer counted as missing` : 'Counted as missing again');
        render(); setTimeout(reload, 4000);       // the server recounts and checks the link behind the screen
      } catch (e) { status(`Could not change it: ${e.message}`, true); }
      return;
    }
    if (ev.target.closest('[data-handoff]')) {
      try { const x = await api('POST', '/followed/hand-off', { slug: r.slug }); r.state = 'linked'; render(); toast(`Handed to Sonarr: ${x.monitored} episode${x.monitored === 1 ? '' : 's'} monitored${x.searched ? `, ${x.searched} searched for` : ''}`); }
      catch (e) { status(`Could not hand it to Sonarr: ${e.message}`, true); }
      return;
    }
    const pick = ev.target.closest('[data-pick]');
    if (pick) {
      try { await follow([{ r, c: { slug: pick.dataset.pick, language: pick.dataset.lang } }]); } catch (e) { status(`Could not follow ${r.title}: ${e.message}`, true); }
    }
  });
  let st;
  $('rows').addEventListener('input', (ev) => {
    const input = ev.target.closest('.match input'); if (!input) return;
    const r = rows.find((x) => x.id === +input.closest('li').dataset.id);
    clearTimeout(st); st = setTimeout(() => search(input, r), 250);
  });
  async function search(input, r) {
    const box = input.parentElement.querySelector('.found');
    let found = [];
    try { found = await api('GET', '/library/search?q=' + encodeURIComponent(input.value)); } catch (e) { box.textContent = 'Could not search: ' + e.message; return; }
    box.innerHTML = found.length ? found.map((c) => `<button class="btn" data-pick="${esc(c.slug)}" data-lang="${c.language}" type="button" title="Follow ${esc(r.title)} as ${esc(c.name)}">${UI.icon('check')}${esc(c.name)}${c.language === 'sub' ? ' (sub only)' : ''}</button>`).join('')
      : '<span class="hint">Nothing on wcostream by that name.</span>';
  }

  $('followall').onclick = async () => {
    const items = readyRows().map((r) => ({ r, c: choice(r) })).filter((x) => x.c);
    if (!items.length) return;
    $('followall').disabled = true;
    try { await follow(items); } catch (e) { status(`Could not follow them: ${e.message}`, true); }
    $('followall').disabled = false;
  };
  $('followlinked').onclick = async () => {
    const items = linkedRows().map((r) => ({ r, c: { slug: r.slug, language: r.language || 'dub' } }));
    if (!items.length) return;
    $('followlinked').disabled = true;
    try { await follow(items); } catch (e) { status(`Could not follow them: ${e.message}`, true); }
    $('followlinked').disabled = false;
  };
  $('countwco').onclick = async () => {
    $('countwco').disabled = true;
    try {
      const r = await api('POST', '/followed/check-links', { all: true });
      toast(r.started ? 'Counting what wcostream has for every linked show. This takes a while; reload this page later to see the counts' : 'A count is running already');
    } catch (e) { status(`Could not start the count: ${e.message}`, true); }
    $('countwco').disabled = false;
  };
  $('drive').addEventListener('click', (ev) => { const b = ev.target.closest('button'); if (b) { drive = b.dataset.v; render(); } });
  $('kind').addEventListener('click', (ev) => { const b = ev.target.closest('button'); if (b) { kind = b.dataset.v; render(); } });
  $('filter').addEventListener('input', render);

  async function reload() {
    try { rows = (await api('GET', '/library/gaps')).rows; render(); } catch { /* the rows on screen stay */ }
  }

  (async () => {
    try {
      const data = await api('GET', '/library/gaps');
      rows = data.rows;
      kind = rows.some((r) => kindOf(r) === 'maybe') ? 'maybe' : 'all';
      try { const k = new URLSearchParams(location.search).get('kind'); if (KINDS.some(([v]) => v === k)) kind = k; } catch { /* the default stays */ }
      status(data.catalogueErrors.length ? `Part of wcostream's catalogue could not be read, so some matches are missing (${data.catalogueErrors.join('; ')}). Reload to try again.` : '', data.catalogueErrors.length > 0);
      $('lib').hidden = false; render();
    } catch (e) { status(`Could not read the library: ${e.message}`, true); }
  })();
})();
