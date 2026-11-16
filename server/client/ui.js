// Shared by every page (12 Nov 2026; the header since 15 Nov): the header itself, the accent picker, a remembered
// light or dark choice, the settings dialog, the header counts, and the thin loading bar shown while the server is
// asking Sonarr or wcostream for something. Pages reach the shared helpers through window.wcoUI.
(() => {
  const root = document.documentElement;
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* not remembered */ } } };
  const UI = window.wcoUI = { hooks: {} };

  // ---------- Icons (15 Nov 2026): one per verb, the same on every page. 16px line icons in the text colour ----------
  // download · copy · check (follow, save) · x (unfollow, dismiss, clear, cancel, close) · pause and play (resume) · retry ·
  // grid (open map) · list (queue) · search · plus (add) · refresh (recount) · moon (theme) · select · next (run next) ·
  // import · alert (needs you) · chev (show more) · cog (settings).
  const ICON = {
    download: '<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
    check: '<path d="m5 12 5 5 9-10"/>',
    x: '<path d="m6 6 12 12M18 6 6 18"/>',
    pause: '<path d="M9 5v14M15 5v14"/>',
    play: '<path d="M8 5.5v13l10-6.5Z"/>',
    retry: '<path d="M20 11a8 8 0 1 0-2.3 6"/><path d="M20 4v7h-7"/>',
    grid: '<rect x="4" y="4" width="6" height="6" rx="1.5"/><rect x="14" y="4" width="6" height="6" rx="1.5"/><rect x="4" y="14" width="6" height="6" rx="1.5"/><rect x="14" y="14" width="6" height="6" rx="1.5"/>',
    list: '<path d="M4 7h16M4 12h16M4 17h10"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    refresh: '<path d="M20 12a8 8 0 0 1-13.7 5.7"/><path d="M4 12a8 8 0 0 1 13.7-5.7"/><path d="M18 2.5v4h-4"/><path d="M6 21.5v-4h4"/>',
    moon: '<path d="M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9Z"/>',
    select: '<rect x="4" y="4" width="16" height="16" rx="3" stroke-dasharray="3 3.4"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
    next: '<path d="M12 19V6"/><path d="m6 11 6-6 6 6"/>',
    import: '<path d="M12 3v10"/><path d="m8 9 4 4 4-4"/><path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><path d="M12 16.5v.01"/>',
    chev: '<path d="m9 6 6 6-6 6"/>',
    cog: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  };
  ICON.settings = ICON.cog;
  const icon = UI.icon = (name, cls = '') => `<svg class="ico${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" aria-hidden="true">${ICON[name] || ''}</svg>`;
  // ---------- Posters (15 Nov 2026): a show's small Sonarr poster at the left of its row ----------
  // UI.poster(seriesId, title, size) gives the markup: 's' 28x42 in lists, 'l' 64x96 on the show page, 'xs' 18x27 in the
  // search panel. The space is reserved, so nothing moves when the picture arrives. A show with no poster (or no Sonarr
  // id) gets a tile: two letters from its title on one of six muted tones, picked by a hash of the title so it never changes.
  const esc = UI.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const POSTER = { s: [28, 42], l: [64, 96], xs: [18, 27] };
  const noPoster = new Set();
  const initials = (t) => {
    const w = String(t || '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
    return (w.length > 1 ? [...w[0]][0] + [...w[1]][0] : [...(w[0] || '?')].slice(0, 2).join('')).toUpperCase();
  };
  const tone = (t) => { let h = 0; for (const c of String(t || '')) h = (h * 31 + c.codePointAt(0)) >>> 0; return (h % 6) + 1; };
  const tile = (title, size) => `<span class="poster ${size} tile p${tone(title)}" aria-hidden="true">${esc(initials(title))}</span>`;
  UI.poster = (id, title, size = 's') => {
    if (!id || noPoster.has(String(id))) return tile(title, size);
    const [w, h] = POSTER[size];
    return `<img class="poster ${size}" src="/poster/${encodeURIComponent(id)}" width="${w}" height="${h}" loading="lazy" decoding="async" alt="" data-id="${esc(id)}" data-t="${esc(title)}">`;
  };
  document.addEventListener('error', (ev) => {       // no picture: the tile takes its place, and later rows skip the request
    const img = ev.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains('poster')) return;
    noPoster.add(img.dataset.id);
    img.outerHTML = tile(img.dataset.t, ['l', 'xs'].find((s) => img.classList.contains(s)) || 's');
  }, true);

  // ---------- Lists that are redrawn often (15 Nov 2026) ----------
  // UI.patchList(ul, [{ key, html }]) makes the list match: a row whose markup is unchanged is left alone (its picture
  // is not fetched again, its fade keeps playing, focus stays put), a changed one is swapped, the order is kept.
  UI.patchList = (ul, items) => {
    const old = new Map();
    for (const el of [...ul.children]) { if (el.dataset.key === undefined) el.remove(); else old.set(el.dataset.key, el); }
    let prev = null;
    for (const { key, html } of items) {
      let el = old.get(key);
      old.delete(key);
      if (!el || el._h !== html) {
        const t = document.createElement('template'); t.innerHTML = html.trim();
        const neu = t.content.firstElementChild; neu.dataset.key = key; neu._h = html;
        if (el) {
          const at = el.contains(document.activeElement) ? [...el.querySelectorAll('a,button,select,input')].indexOf(document.activeElement) : -1;
          el.replaceWith(neu);
          if (at >= 0) neu.querySelectorAll('a,button,select,input')[at]?.focus({ preventScroll: true });
        }
        el = neu;
      }
      if ((prev ? prev.nextElementSibling : ul.firstElementChild) !== el) { if (prev) prev.after(el); else ul.prepend(el); }
      prev = el;
    }
    for (const el of old.values()) el.remove();
  };

  // A button written in a page's HTML names its icon (data-icon="download") and gets it here, before its label.
  document.querySelectorAll('[data-icon]').forEach((el) => el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon)));

  // ---------- Header (15 Nov 2026): built once here, the same on every page ----------
  // Left: the mark and the pages. Middle: the search box. Right: what is happening (Needs you, Queue) and the looks.
  // A page gives <header class="top ui" id="top" data-page="home|library|calendar|browse"></header> and nothing else.
  // On the map page the Queue control opens the panel in place, so it is a button there and a link elsewhere.
  const top = document.getElementById('top');
  const page = top?.dataset.page || '';
  UI.page = page;
  if (top) {
    const PAGES = [['home', '/map.html', 'Home'], ['library', '/library.html', 'Library gaps'], ['calendar', '/calendar.html', 'Dub calendar'], ['browse', '/index.html', 'Browse']];
    const queue = page === 'home'
      ? `<button class="btn" id="queuebtn" type="button" aria-expanded="false" aria-controls="queue">${icon('list')}Queue <span id="queuecount" class="count"></span></button>`
      : `<a class="btn" id="queuebtn" href="/map.html#queue">${icon('list')}Queue <span id="queuecount" class="count"></span></a>`;
    top.innerHTML = `<a class="brand" href="/map.html" aria-label="wco-dl, Home"><img src="favicon.svg" width="20" height="20" alt=""><span>wco-dl</span></a>
      <nav class="nav" aria-label="Pages">${PAGES.map(([id, href, label]) => `<a href="${href}"${id === page ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>
      <form class="lookup" id="lookup" role="search" aria-label="Search or jump" action="/map.html" method="get">
        <div class="searchbox">
          ${icon('search', 'sico')}
          <input id="url" name="find" role="combobox" aria-expanded="false" aria-controls="suggest" aria-autocomplete="list" aria-label="Search or jump: a show, an action, or a wcostream link"
            placeholder="Search or jump" autocomplete="off" spellcheck="false">
          <kbd class="skey" id="skey" aria-hidden="true">/</kbd>
          <button class="sclear" id="sclear" type="button" aria-label="Clear the search" hidden>${icon('x')}</button>
          <div class="suggest" id="suggest" role="listbox" aria-label="Results" hidden></div>
        </div>
      </form>
      <div class="side">
        <span class="happening">
          <a class="btn btn-quiet" id="attnbtn" href="/map.html#attention" hidden>${icon('alert')}Needs you <span class="count" id="attncount"></span></a>
          ${queue}
        </span>
        <span class="looktools">
          <button class="btn btn-quiet" id="theme" type="button" aria-label="Switch light or dark">${icon('moon')}</button>
        </span>
      </div>`;   // .happening: what is going on. .looktools: the looks and settings; another control for the right side goes in here.
    // "/" or Ctrl+K reaches the search box from anywhere on any page.
    const box = document.getElementById('url');
    document.addEventListener('keydown', (ev) => {
      const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);
      if ((ev.key === '/' && !typing && !ev.ctrlKey && !ev.metaKey && !ev.altKey) || (ev.key?.toLowerCase() === 'k' && (ev.ctrlKey || ev.metaKey))) { ev.preventDefault(); box.focus(); box.select(); }
    });
    addEventListener('scroll', () => root.classList.toggle('scrolled', scrollY > 8), { passive: true });
    // How much of the top edge the header holds while it sticks (nothing on a phone, where it scrolls away): --toph.
    // Anything else that sticks, or scrolls a target into view, starts below it.
    const measure = () => root.style.setProperty('--toph', (getComputedStyle(top).position === 'sticky' ? top.offsetHeight : 0) + 'px');
    if (window.ResizeObserver) new ResizeObserver(measure).observe(top);
    addEventListener('resize', measure); measure();
    // Light or dark: flips what is showing now, and remembers it. A page with its own body styles ([data-theme]
    // only, no system query) always carries the attribute, set in its <head>.
    document.getElementById('theme').addEventListener('click', () => {
      const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
      root.dataset.theme = dark ? 'light' : 'dark'; store.set('wco-theme', root.dataset.theme);
    });
  }
  // The header counts. "Needs you" is shown only when there is something; it is the count of episodes.
  UI.setCounts = ({ queue, attention }) => {
    const q = document.getElementById('queuecount'), a = document.getElementById('attncount'), ab = document.getElementById('attnbtn');
    if (q && queue !== undefined) q.textContent = queue ? String(queue) : '';
    if (a && attention !== undefined) { a.textContent = attention ? String(attention) : ''; ab.hidden = !attention; }
  };
  // ---------- A run you can watch from another tab (15 Nov 2026) ----------
  // UI.busyTab(true) swaps the tab's icon for the same one with a small dot while something is downloading or
  // importing; false puts it back. The dotted icon is made once from favicon.svg, so the two cannot drift apart.
  let dotted = null, tabBusy = false;
  UI.busyTab = async (on) => {
    on = !!on;
    if (on === tabBusy) return;
    tabBusy = on;
    const link = document.querySelector('link[rel~="icon"]'); if (!link) return;
    if (!on) { link.href = 'favicon.svg'; return; }
    if (!dotted) {
      try {
        const svg = await (await fetch('favicon.svg')).text();
        dotted = 'data:image/svg+xml,' + encodeURIComponent(svg.replace('</svg>', '<style>.dot{fill:#4f46e5;stroke:#fafafa;stroke-width:2.5}@media (prefers-color-scheme:dark){.dot{stroke:#161617}}</style><circle class="dot" cx="24.5" cy="7.5" r="6.2"/></svg>'));
      } catch { tabBusy = false; return; }
    }
    if (tabBusy) link.href = dotted;
  };

  // Pages without a queue of their own ask for the two counts here: the queue every minute (every 15 seconds while
  // something is active), "Needs you" once a minute because the server asks Sonarr for it.
  // While an episode is downloading or importing the tab says so ("Downloading · Library gaps · wco-dl") and carries the dot.
  if (top && page !== 'home') {
    const ACTIVE = ['queued', 'downloading', 'importing'], TITLE = document.title;
    let attnAt = 0;
    const tick = async () => {
      let active = 0;
      try {
        const runs = await (await fetch('/fill/jobs')).json();
        active = runs.reduce((n, j) => n + j.episodes.filter((e) => ACTIVE.includes(e.state)).length, 0);
        UI.setCounts({ queue: active });
        const working = runs.some((j) => j.episodes.some((e) => e.state === 'downloading' || e.state === 'importing'));
        document.title = (working ? 'Downloading · ' : '') + TITLE;
        UI.busyTab(working);
        if (Date.now() - attnAt >= 60000) { attnAt = Date.now(); UI.setCounts({ attention: (await (await fetch('/attention')).json()).length }); }
      } catch { /* the counts are optional */ }
      setTimeout(tick, active ? 15000 : 60000);
    };
    tick();
  }

  // ---------- Jump to anything (15 Nov 2026): the header's search box, on every page ----------
  // Focus it (or press "/") and a panel opens: your followed shows first, filtered by what is typed, answered from the
  // list kept in memory so it never waits on Sonarr; then actions; then wcostream's catalogue, added when it arrives.
  // Arrows move, Enter opens, Esc closes; a pasted link opens straight away. Typing selects the first result, so a
  // few letters and Enter is enough. A page hooks in what it can do in place (UI.hooks); elsewhere a choice navigates.
  if (top) {
    const box = document.getElementById('url'), panel = document.getElementById('suggest'), clear = document.getElementById('sclear'), key = document.getElementById('skey');
    const isLink = UI.isLink = (v) => /^https?:\/\//i.test(String(v).trim());
    const go = (href) => { location.href = href; };
    const openShow = (slug, lang) => (UI.hooks.openShow ? UI.hooks.openShow(slug, lang) : go('/map.html?url=' + encodeURIComponent(slug)));
    const search = (q) => (UI.hooks.search ? UI.hooks.search(q) : go('/map.html?find=' + encodeURIComponent(q)));
    const getJSON = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`The server answered ${r.status}`); return r.json(); };
    const postJSON = async (url, body) => { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); if (!r.ok) throw new Error(`The server answered ${r.status}`); return r.json().catch(() => ({})); };

    // Followed shows: asked for once, the first time the panel opens, and kept. The home page hands over its own copy.
    let mine = null, asking = null, paused = null;
    UI.setFollowed = (list) => { mine = list; };
    UI.setPaused = (p) => { paused = !!p; };
    const loadMine = () => (mine ? Promise.resolve(mine) : (asking = asking || getJSON('/followed').then((l) => { mine = mine || l; }, () => { mine = mine || []; })));
    const recents = () => { try { return JSON.parse(localStorage.getItem('wco-recent') || '[]'); } catch { return []; } };
    UI.remember = (slug, title) => { store.set('wco-recent', JSON.stringify([{ slug, title }, ...recents().filter((r) => r.slug !== slug)].slice(0, 6))); };

    const ACTIONS = [
      { id: 'pause', icon: () => (paused ? 'play' : 'pause'), title: () => (paused === null ? 'Pause or resume the queue' : paused ? 'Resume the queue' : 'Pause the queue'), words: 'pause resume the queue' },
      { id: 'retry', icon: () => 'retry', title: () => 'Retry everything that failed', words: 'retry everything that failed' },
      { id: 'library', icon: () => 'chev', title: () => 'Open Library gaps', words: 'open library gaps' },
      { id: 'calendar', icon: () => 'chev', title: () => 'Open Dub calendar', words: 'open dub calendar' },
      { id: 'queue', icon: () => 'list', title: () => 'Open the queue', words: 'open the queue' },
    ];
    const act = {
      pause: async () => {
        try { const now = await getJSON('/fill/state'), r = await postJSON('/fill/pause', { paused: !now.paused }); paused = !!r.paused; UI.toast(paused ? 'Paused: the episode in hand finishes, nothing new starts' : 'Resumed'); }
        catch (e) { UI.toast(`Could not change the queue: ${e.message}`); }
        if (UI.hooks.refresh) UI.hooks.refresh();
      },
      retry: async () => {
        try {
          const rows = (await getJSON('/attention')).filter((a) => a.state === 'failed' || a.state === 'kept');
          if (!rows.length) { UI.toast('Nothing has failed: there is nothing to retry'); return; }
          let n = 0;
          for (const a of rows) { try { await postJSON(`/fill/jobs/${a.jobId}/retry/${a.id}`); n++; } catch { /* that one stays in Needs you */ } }
          UI.toast(`Queued ${n} episode${n === 1 ? '' : 's'} again${n < rows.length ? `; ${rows.length - n} could not be queued` : ''}`);
        } catch (e) { UI.toast(`Could not retry: ${e.message}`); }
        if (UI.hooks.refresh) UI.hooks.refresh();
      },
      library: () => go('/library.html'),
      calendar: () => go('/calendar.html'),
      queue: () => (UI.hooks.queue ? UI.hooks.queue() : go('/map.html#queue')),
    };

    const sug = { items: [], active: -1, seq: 0, timer: null, loading: false, q: '' };
    const close = () => { panel.hidden = true; box.setAttribute('aria-expanded', 'false'); box.removeAttribute('aria-activedescendant'); sug.active = -1; };
    UI.closeJump = close;
    const mark = () => {     // move the selection without redrawing, so pictures are not fetched again
      panel.querySelectorAll('.sopt').forEach((o) => o.setAttribute('aria-selected', String(+o.dataset.n === sug.active)));
      if (sug.active >= 0) box.setAttribute('aria-activedescendant', 'sopt' + sug.active); else box.removeAttribute('aria-activedescendant');
    };
    const draw = () => {
      let n = -1;
      const html = [['shows', 'Shows'], ['actions', 'Actions'], ['wco', 'On wcostream']].map(([g, label]) => {
        const list = sug.items.filter((x) => x.group === g);
        return list.length ? `<div role="group" aria-label="${label}"><div class="sgroup" aria-hidden="true">${label}</div>` + list.map((x) => {
          n++;
          return `<div class="sopt" role="option" id="sopt${n}" data-n="${n}" aria-selected="${n === sug.active}">${x.pic || ''}<span class="sname">${esc(x.title)}</span>${x.meta ? `<span class="smeta">${esc(x.meta)}</span>` : ''}</div>`;
        }).join('') + '</div>' : '';
      }).join('') + (sug.loading ? '<div class="snote">Searching wcostream…</div>' : '');
      panel.innerHTML = html;
      panel.hidden = !html; box.setAttribute('aria-expanded', String(!!html));
      mark();
    };
    const build = () => {
      const q = sug.q, words = q.toLowerCase().split(/\s+/).filter(Boolean);
      const has = (t) => words.every((w) => t.toLowerCase().includes(w));
      const starts = (t) => words.every((w) => t.toLowerCase().split(/[^a-z0-9]+/).some((p) => p.startsWith(w)));
      const name = (x) => x.title || x.slug;
      const recent = recents().map((r) => r.slug), rank = (x) => { const i = recent.indexOf(x.slug); return i < 0 ? 99 : i; };
      const shows = (mine || []).filter((x) => has(name(x)))
        .sort((a, b) => (q ? Number(starts(name(b))) - Number(starts(name(a))) : rank(a) - rank(b)) || name(a).localeCompare(name(b), 'en', { sensitivity: 'base' })).slice(0, 6)
        .map((x) => ({ group: 'shows', title: name(x), pic: UI.poster(x.seriesId, name(x), 'xs'),
          meta: [x.missing > 0 && x.missing + ' missing', x.undub > 0 && x.undub + ' to dub'].filter(Boolean).join(' · ') || (x.countedAt ? 'complete' : ''), run: () => openShow(x.slug) }));
      const actions = ACTIONS.filter((a) => !q || has(a.words)).map((a) => ({ group: 'actions', title: a.title(), pic: icon(a.icon()), run: act[a.id] }));
      if (q) actions.push({ group: 'actions', title: `Search wcostream for "${q}"`, pic: icon('search'), run: () => search(q) });
      return { shows, actions, have: new Set((mine || []).filter((x) => has(name(x))).map((x) => x.slug)), starts };
    };
    function suggest() {
      const q = sug.q = box.value.trim();
      clear.hidden = !q; key.hidden = !!q;
      clearTimeout(sug.timer); const my = ++sug.seq;
      if (isLink(q)) { close(); return; }
      const first = build();
      sug.items = [...first.shows, ...first.actions]; sug.loading = q.length >= 2; sug.active = q && sug.items.length ? 0 : -1;
      draw();
      if (!mine) loadMine().then(() => { if (my === sug.seq && document.activeElement === box) suggest(); });
      if (paused === null) getJSON('/fill/state').then((s) => { paused = !!s.paused; if (my === sug.seq && !panel.hidden) { const b = build(); sug.items = [...b.shows, ...b.actions, ...sug.items.filter((x) => x.group === 'wco')]; draw(); } }, () => undefined);   // the pause action now names what it will do
      if (q.length < 2) return;
      sug.timer = setTimeout(async () => {
        const found = await getJSON('/library/search?q=' + encodeURIComponent(q)).catch(() => []);
        if (my !== sug.seq) return;                       // the box has moved on
        const now = build(), keep = sug.active;
        sug.items = [...now.shows, ...now.actions, ...found.filter((c) => !now.have.has(c.slug)).sort((a, b) => Number(now.starts(b.name)) - Number(now.starts(a.name))).slice(0, 8).map((c) => ({ group: 'wco', title: c.name,
          pic: c.series ? UI.poster(c.series.id, c.series.title || c.name, 'xs') : '<span class="poster xs none"></span>',
          meta: [c.language === 'sub' ? 'sub only' : 'dub', c.series ? (c.follow ? 'following' : 'in Sonarr') : 'not in Sonarr yet'].join(' · '),
          run: () => (c.series ? openShow(c.slug, c.language) : search(c.name)) }))];   // not in Sonarr: the results page has "Add to Sonarr"
        sug.loading = false; sug.active = Math.min(keep, sug.items.length - 1);
        draw();
      }, 220);
    }
    const choose = (x) => { if (!x) return; close(); box.value = ''; clear.hidden = true; key.hidden = false; box.blur(); x.run(); };
    box.addEventListener('input', suggest);
    box.addEventListener('focus', suggest);
    box.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== box) close(); }, 120));   // not if the box was reached again meanwhile
    box.addEventListener('paste', () => setTimeout(() => { if (isLink(box.value)) { const v = box.value.trim(); close(); box.value = ''; clear.hidden = true; key.hidden = false; (UI.hooks.link || ((u) => go('/map.html?url=' + encodeURIComponent(u))))(v); } }, 0));
    box.addEventListener('keydown', (ev) => {
      const open = !panel.hidden, n = sug.items.length;
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        if (!open) { suggest(); return; }
        if (!n) return;
        ev.preventDefault();
        sug.active = ev.key === 'ArrowDown' ? (sug.active + 1) % n : (sug.active - 1 + n) % n;
        mark();
        document.getElementById('sopt' + sug.active)?.scrollIntoView({ block: 'nearest' });
      } else if (ev.key === 'Enter' && open && sug.active >= 0) {
        ev.preventDefault(); choose(sug.items[sug.active]);
      } else if (ev.key === 'Escape' && open) {
        ev.preventDefault(); ev.stopPropagation(); close();
      }
    });
    panel.addEventListener('mousedown', (ev) => ev.preventDefault());   // keep the focus in the box
    panel.addEventListener('click', (ev) => { const o = ev.target.closest('.sopt'); if (o) choose(sug.items[+o.dataset.n]); });
    panel.addEventListener('pointermove', (ev) => {
      const o = ev.target.closest('.sopt'); if (!o || +o.dataset.n === sug.active) return;
      sug.active = +o.dataset.n; mark();
    });
    clear.onclick = () => { box.value = ''; box.focus(); suggest(); };
    // Enter with nothing selected: a link opens, words are searched for on wcostream.
    document.getElementById('lookup').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const q = box.value.trim(); if (!q) return;
      close();
      if (isLink(q)) (UI.hooks.link || ((u) => go('/map.html?url=' + encodeURIComponent(u))))(q); else search(q);
    });
  }

  // ---------- Accent: six measured colours; each is at least 4.5:1 as text on every surface, light and dark ----------
  const ACCENTS = [['indigo', 'Indigo'], ['blue', 'Blue'], ['teal', 'Teal'], ['green', 'Green'], ['rose', 'Rose'], ['violet', 'Violet'], ['graphite', 'Graphite']];
  const theme = document.getElementById('theme');
  if (theme) {
    const wrap = document.createElement('div'); wrap.className = 'looks';
    wrap.innerHTML = `<button class="btn btn-quiet" id="accentbtn" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="accents" aria-label="Accent colour"><span class="swatch"></span></button>
      <div class="accents" id="accents" role="radiogroup" aria-label="Accent colour" hidden>${ACCENTS.map(([v, label]) =>
        `<button type="button" role="radio" data-accent="${v}" aria-label="${label}" title="${label}"><span class="swatch"></span></button>`).join('')}</div>`;
    theme.before(wrap);
    const btn = wrap.querySelector('#accentbtn'), menu = wrap.querySelector('#accents');
    const mark = () => menu.querySelectorAll('[data-accent]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.accent === (root.dataset.accent || 'indigo'))));
    const open = (on) => { menu.hidden = !on; btn.setAttribute('aria-expanded', String(on)); if (on) { mark(); (menu.querySelector('[aria-checked=true]') || menu.firstElementChild).focus(); } };
    btn.onclick = () => open(menu.hidden);
    menu.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-accent]'); if (!b) return;
      root.dataset.accent = b.dataset.accent; store.set('wco-accent', b.dataset.accent); mark();
    });
    menu.addEventListener('keydown', (ev) => {
      const all = [...menu.querySelectorAll('[data-accent]')], i = all.indexOf(document.activeElement);
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') { ev.preventDefault(); all[(i + 1) % all.length].focus(); }
      if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') { ev.preventDefault(); all[(i - 1 + all.length) % all.length].focus(); }
      if (ev.key === 'Escape') { ev.stopPropagation(); open(false); btn.focus(); }
    });
    document.addEventListener('pointerdown', (ev) => { if (!menu.hidden && !wrap.contains(ev.target)) open(false); });
  }

  // ---------- Settings (12 Nov 2026): the cog beside the light and dark button ----------
  const hh = (h) => String(h).padStart(2, '0') + ':00';
  let settings = { nightFrom: 1, nightTo: 7, nightBudget: 120, quality: '1080', hasDubToken: false };
  window.wcoNight = () => `${hh(settings.nightFrom)} and ${hh(settings.nightTo)}`;
  function showSettings() {
    document.querySelectorAll('[data-night]').forEach((e) => { e.textContent = window.wcoNight(); });
    document.querySelectorAll('[data-budget]').forEach((e) => { e.textContent = settings.nightBudget; });
    const q = document.getElementById('q');           // the map's quality choice starts at the default
    if (q && !q.dataset.touched) q.value = settings.quality;
  }
  document.getElementById('q')?.addEventListener('change', (ev) => { ev.target.dataset.touched = '1'; });
  const loaded = fetch('/settings').then((r) => (r.ok ? r.json() : settings)).then((s) => { settings = { ...settings, ...s }; showSettings(); }).catch(() => undefined);
  if (theme) {
    const cog = document.createElement('button');
    cog.className = 'btn btn-quiet'; cog.id = 'settingsbtn'; cog.type = 'button'; cog.setAttribute('aria-label', 'Settings'); cog.title = 'Settings';
    cog.innerHTML = icon('cog');
    theme.after(cog);
    const hours = [...Array(24).keys()].map((h) => `<option value="${h}">${hh(h)}</option>`).join('');
    const dlg = document.createElement('dialog');
    dlg.className = 'settings ui'; dlg.setAttribute('aria-labelledby', 'settingstitle');
    dlg.innerHTML = `<form method="dialog" id="settingsform">
      <h2 id="settingstitle">Settings</h2>
      <fieldset><legend>Overnight runs</legend>
        <div class="srow"><label for="s-from">Start</label><select id="s-from">${hours}</select><label for="s-to">Stop starting new episodes at</label><select id="s-to">${hours}</select></div>
        <div class="srow"><label for="s-budget">Episodes a night, at most</label><input id="s-budget" type="number" min="1" max="1000" step="1" inputmode="numeric"></div>
        <p class="hint">The night's plan is made five minutes after the start. Runs you start by hand ignore the window.</p>
      </fieldset>
      <fieldset><legend>Downloads</legend>
        <div class="srow"><label for="s-quality">Quality</label><select id="s-quality"><option value="1080">HD / FHD (best available)</option><option value="480">SD (480p)</option></select></div>
        <p class="hint">Used by overnight runs and offered first on the map. A refused HD file is tried once more in SD either way.</p>
      </fieldset>
      <fieldset><legend>Dub calendar</legend>
        <div class="srow"><label for="s-token">AnimeSchedule token</label><input id="s-token" type="password" autocomplete="off" spellcheck="false"></div>
        <p class="hint" id="s-tokenhint"></p>
      </fieldset>
      <p class="serr" id="s-err" role="alert" hidden></p>
      <div class="sacts"><button class="btn btn-quiet" type="button" id="s-cancel">${icon('x')}Cancel</button><button class="btn btn-primary" type="submit" id="s-save">${icon('check')}Save</button></div>
    </form>`;
    document.body.append(dlg);
    const f = (id) => dlg.querySelector('#' + id);
    cog.onclick = async () => {
      await loaded;
      f('s-from').value = settings.nightFrom; f('s-to').value = settings.nightTo; f('s-budget').value = settings.nightBudget; f('s-quality').value = settings.quality;
      f('s-token').value = ''; f('s-token').placeholder = settings.hasDubToken ? 'Saved. Type a new one to replace it' : 'Paste the token';
      f('s-tokenhint').textContent = settings.hasDubToken ? 'A token is saved. It is never shown again.' : 'From your animeschedule.net account settings, API tab. Without it the dub calendar stays empty.';
      f('s-err').hidden = true;
      dlg.showModal();
    };
    f('s-cancel').onclick = () => dlg.close();
    dlg.addEventListener('click', (ev) => { if (ev.target === dlg) dlg.close(); });   // a press on the backdrop
    f('settingsform').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const err = (m) => { f('s-err').textContent = m; f('s-err').hidden = false; };
      if (f('s-from').value === f('s-to').value) return err('Start and stop are the same hour: the window would be empty.');
      const n = Number(f('s-budget').value);
      if (!Number.isInteger(n) || n < 1 || n > 1000) return err('Episodes a night must be a whole number from 1 to 1000.');
      f('s-save').disabled = true;
      try {
        const body = { nightFrom: Number(f('s-from').value), nightTo: Number(f('s-to').value), nightBudget: n, quality: f('s-quality').value };
        const token = f('s-token').value.trim();
        if (token) body.dubToken = token;
        const r = await fetch('/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) return err(d.message ? [].concat(d.message).join('; ') : `The server answered ${r.status}`);
        settings = { ...settings, ...d }; showSettings(); dlg.close();
        if (token && /calendar\.html$/.test(location.pathname)) location.reload();
      } catch (e) { err(`Not saved: ${e.message}`); } finally { f('s-save').disabled = false; }
    });
  }

  // ---------- Toast, with Undo (15 Nov 2026) ----------
  // UI.toast(msg) says something for a few seconds (the page's #toast, a status region, so it is read out).
  // UI.toast(msg, { undo, commit, key }) is for something that has already happened on screen: commit(keepalive) is
  // the request that makes it real, held back for six seconds. Undo (the button, or Ctrl+Z) drops the request and
  // calls undo() to put the screen back. Another toast, or leaving the page, sends a held request at once; a toast
  // with the same key takes the held one's place instead (its commit and undo then cover both).
  let toastT = null, held = null;
  const toastEl = () => document.getElementById('toast');
  const hideToast = () => {
    const t = toastEl(); clearTimeout(toastT);
    if (t.contains(document.activeElement)) (document.querySelector('h1[tabindex]:not([hidden])') || document.body).focus?.({ preventScroll: true });
    t.classList.remove('on', 'act');
  };
  const send = (keepalive) => { const h = held; held = null; if (h) h.commit(!!keepalive); };
  UI.toast = (msg, o = {}) => {
    const t = toastEl(); if (!t) return;
    clearTimeout(toastT);
    if (held && !(o.key && held.key === o.key)) send();
    held = o.undo ? { key: o.key, commit: o.commit || (() => undefined), undo: o.undo } : held && o.key === held.key ? held : null;
    t.innerHTML = `<span>${esc(msg)}</span>` + (o.undo ? '<span class="vh">. Press Control Z to undo.</span><button type="button" class="tundo" aria-keyshortcuts="Control+Z">Undo</button>' : '');
    t.classList.add('on'); t.classList.toggle('act', !!o.undo);
    toastT = setTimeout(() => { hideToast(); send(); }, o.undo ? 6000 : o.ms || 3600);
  };
  UI.undo = () => { const h = held; if (!h) return false; held = null; hideToast(); h.undo(); return true; };
  // Drop a held request without putting the screen back: the person has just done the opposite by hand.
  UI.unhold = (key) => { if (!held || held.key !== key) return false; held = null; hideToast(); return true; };
  document.addEventListener('click', (ev) => { if (ev.target.closest?.('.tundo')) UI.undo(); });
  document.addEventListener('keydown', (ev) => {
    if (!held || ev.key?.toLowerCase() !== 'z' || !(ev.ctrlKey || ev.metaKey) || ev.shiftKey || ev.altKey) return;
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;   // the field's own undo
    ev.preventDefault(); UI.undo();
  });
  addEventListener('pagehide', () => send(true));       // leaving: the held request goes now, and outlives the page

  // ---------- Loading bar: appears after a short wait, so quick answers do not flash it ----------
  const bar = document.createElement('div'); bar.className = 'busy'; bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-label', 'Loading'); bar.hidden = true;
  bar.innerHTML = '<i></i>';
  document.body.prepend(bar);
  let pending = 0, timer = null;
  const QUIET = /^\/(fill\/jobs$|fill\/state|attention|followed$)/;   // the background polls stay silent
  window.wcoBusy = (url, promise) => {
    if (QUIET.test(url.split('?')[0])) return promise;
    pending++;
    if (!timer) timer = setTimeout(() => { if (pending) bar.hidden = false; }, 180);
    const done = () => { if (--pending <= 0) { pending = 0; clearTimeout(timer); timer = null; bar.hidden = true; } };
    promise.then(done, done);
    return promise;
  };
})();
