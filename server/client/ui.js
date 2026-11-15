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
      <form class="lookup" id="lookup" role="search" aria-label="Search" action="/map.html" method="get">
        <div class="searchbox">
          ${icon('search', 'sico')}
          <input id="url" name="find" role="combobox" aria-expanded="false" aria-controls="suggest" aria-autocomplete="list" aria-label="Search shows by name, or paste a wcostream show link"
            placeholder="Search shows, or paste a wcostream link" autocomplete="off" spellcheck="false">
          <kbd class="skey" id="skey" aria-hidden="true">/</kbd>
          <button class="sclear" id="sclear" type="button" aria-label="Clear the search" hidden>${icon('x')}</button>
          <div class="suggest" id="suggest" role="listbox" aria-label="Suggestions" hidden></div>
        </div>
      </form>
      <div class="side">
        <a class="btn btn-quiet" id="attnbtn" href="/map.html#attention" hidden>${icon('alert')}Needs you <span class="count" id="attncount"></span></a>
        ${queue}
        <button class="btn btn-quiet" id="theme" type="button" aria-label="Switch light or dark">${icon('moon')}</button>
      </div>`;
    // "/" or Ctrl+K reaches the search box from anywhere on any page.
    const box = document.getElementById('url');
    document.addEventListener('keydown', (ev) => {
      const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);
      if ((ev.key === '/' && !typing && !ev.ctrlKey && !ev.metaKey && !ev.altKey) || (ev.key.toLowerCase() === 'k' && (ev.ctrlKey || ev.metaKey))) { ev.preventDefault(); box.focus(); box.select(); }
    });
    addEventListener('scroll', () => root.classList.toggle('scrolled', scrollY > 8), { passive: true });
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
  // Pages without a queue of their own ask for the two counts here: the queue every minute (every 15 seconds while
  // something is active), "Needs you" once a minute because the server asks Sonarr for it.
  if (top && page !== 'home') {
    const ACTIVE = ['queued', 'downloading', 'importing'];
    let attnAt = 0;
    const tick = async () => {
      let active = 0;
      try {
        const runs = await (await fetch('/fill/jobs')).json();
        active = runs.reduce((n, j) => n + j.episodes.filter((e) => ACTIVE.includes(e.state)).length, 0);
        UI.setCounts({ queue: active });
        if (Date.now() - attnAt >= 60000) { attnAt = Date.now(); UI.setCounts({ attention: (await (await fetch('/attention')).json()).length }); }
      } catch { /* the counts are optional */ }
      setTimeout(tick, active ? 15000 : 60000);
    };
    tick();
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
      <div class="sacts"><button class="btn" type="button" id="s-cancel">${icon('x')}Cancel</button><button class="btn btn-primary" type="submit" id="s-save">${icon('check')}Save</button></div>
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
