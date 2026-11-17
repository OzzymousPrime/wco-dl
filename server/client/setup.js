// Setup and Settings (16 Nov 2026). One list of what wco-dl needs: Sonarr, a download folder Sonarr can see, and the
// Cloudflare helper, each tested by the server (GET /setup) with a form that opens in place. A value is saved only
// after it has worked once. No key, token or password ever comes back from the server, so the fields start empty.
// Server: GET /setup, GET /setup/folders, POST /setup/sonarr|folder|extras|reset|lock|unlock|signout.
(() => {
  const UI = window.wcoUI;
  const { icon, esc } = UI;
  const $ = (id) => document.getElementById(id);

  let s = null;          // the last check-up
  let locked = false;    // a password is set and this browser has not given it
  let open = '';         // the row whose form is open: sonarr | folder | notify | lock
  let busy = '';         // the row being tested or saved
  let errs = {};         // row -> why its last save was refused
  let draft = {};        // what is typed, kept while the list is redrawn
  let browse = null;     // { at, parent, directories } while picking a folder
  let focus = '';        // a selector to put the keyboard on after the next redraw

  async function call(method, url, body) {
    const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(d.message ? [].concat(d.message).join('; ') : `The server answered ${r.status}`); e.status = r.status; throw e; }
    return d;
  }

  const SAY = { ok: 'Working', bad: 'Needs fixing', unset: 'Not set up', waiting: 'Waiting' };
  const mark = (state) => `<span class="vh">${SAY[state] || 'Optional'}: </span>` + (state === 'ok' ? `<span class="mark ok">${icon('check')}</span>`
    : state === 'bad' ? '<span class="mark bad" aria-hidden="true">!</span>' : '<span class="mark" aria-hidden="true"></span>');
  const head = (state, name, line, action = '') =>
    `<div class="shead">${mark(state)}<span class="stext"><h2>${name}</h2><span class="sline${state === 'bad' ? ' bad' : ''}">${esc(line)}</span></span>${action}</div>`;
  const change = (row, label = 'Change') => `<button class="btn btn-quiet" type="button" data-open="${row}">${label}</button>`;
  const err = (row) => (errs[row] ? `<p class="serr" role="alert">${esc(errs[row])}</p>` : '');
  const fromEnv = (from) => (from === 'env' ? ' This one is set where wco-dl is started (.env); saving here takes over from it.' : '');
  const forget = (row, ...from) => (from.includes('saved') ? `<button class="btn btn-quiet" type="button" data-reset="${row}">Forget what was saved here</button>` : '');
  const go = (row, label, ic) => `<button class="btn" type="submit"${busy === row ? ' disabled' : ''}>${icon(ic)}${busy === row ? 'Testing…' : label}</button>`;
  const cancel = '<button class="btn btn-quiet" type="button" data-open="">Cancel</button>';

  function sonarrRow() {
    const a = s.sonarr;
    if (open !== 'sonarr') return head(a.state, 'Sonarr', a.message, change('sonarr', a.hasKey ? 'Change' : 'Connect'));
    return head(a.state, 'Sonarr', a.message) + `<form class="sform" data-form="sonarr">
      <label for="f-url">Sonarr's address</label>
      <input id="f-url" type="url" inputmode="url" value="${esc(draft.url ?? a.url)}" placeholder="http://sonarr:8989" autocomplete="off" spellcheck="false" required>
      <label for="f-key">API key</label>
      <input id="f-key" type="password" value="${esc(draft.key ?? '')}" placeholder="${a.hasKey ? 'Saved. Type a new one to replace it' : 'Paste the key'}" autocomplete="off" spellcheck="false"${a.hasKey ? '' : ' required'}>
      <p>In Sonarr: Settings, General, API Key. The key is kept on the server and never shown again. A new address needs the key typed again.${fromEnv(a.keyFrom === 'env' ? 'env' : a.urlFrom)}</p>
      ${err('sonarr')}
      <div class="fbtns">${go('sonarr', 'Test and save', 'check')}${a.hasKey ? cancel : ''}${forget('sonarr', a.urlFrom, a.keyFrom)}</div>
    </form>`;
  }

  function folderRow() {
    const f = s.folder;
    if (open !== 'folder') return head(f.state, 'Download folder', f.message, f.state === 'waiting' ? '' : change('folder'));
    const list = browse && `<div class="browse"><div class="bhead"><code>${esc(browse.at || "Sonarr's drives and folders")}</code>${browse.at ? '<button class="btn btn-quiet" type="button" data-browse-up>Up</button>' : ''}</div>
      ${browse.directories.length ? `<ul>${browse.directories.map((d) => `<li><button type="button" data-browse="${esc(d.path)}">${icon('chev')}${esc(d.name || d.path)}</button></li>`).join('')}</ul>` : '<div class="none">No folders in here.</div>'}</div>`;
    return head(f.state, 'Download folder', f.message) + `<form class="sform" data-form="folder">
      <p>wco-dl saves to <code>${esc(f.outputBase)}</code>. That folder is chosen where wco-dl is started and cannot be moved from here. To test it, wco-dl puts a small file there and asks Sonarr whether it can see it. If Sonarr knows the folder by another name, say which.</p>
      <label for="f-path">Where Sonarr sees that folder</label>
      <input id="f-path" type="text" value="${esc(draft.path ?? f.importBase)}" placeholder="Leave empty when it is the same path" autocomplete="off" spellcheck="false">
      ${list || ''}
      ${err('folder')}
      <div class="fbtns">${go('folder', 'Test and save', 'retry')}<button class="btn btn-quiet" type="button" data-act="browse">${icon('search')}Browse Sonarr's folders</button>${f.state === 'ok' ? cancel : ''}${forget('folder', f.importBaseFrom)}</div>
      ${fromEnv(f.importBaseFrom) ? `<p>${fromEnv(f.importBaseFrom).trim()}</p>` : ''}
    </form>`;
  }

  function notifyRow() {
    const x = s.extras;
    const line = x.notifyUrl ? `Sent to ${x.notifyUrl}` : 'Off';
    if (open !== 'notify') return head('', 'Messages to your phone', line, change('notify', x.notifyUrl ? 'Change' : 'Set up'));
    return head('', 'Messages to your phone', line) + `<form class="sform" data-form="notify">
      <p>wco-dl can post a short message to an address of yours, such as an n8n or Home Assistant webhook: a summary after the overnight runs, a note when a dub you follow appears on wcostream, and a warning if the downloads drive is nearly full and the queue has stopped. Leave the address empty to turn them off.</p>
      <label for="f-nurl">Address to post to</label>
      <input id="f-nurl" type="url" inputmode="url" value="${esc(draft.nurl ?? x.notifyUrl)}" autocomplete="off" spellcheck="false">
      <label for="f-ntok">Token, if that address wants one</label>
      <input id="f-ntok" type="password" value="${esc(draft.ntok ?? '')}" placeholder="${x.hasNotifyToken ? 'Saved. Type a new one to replace it' : 'Optional'}" autocomplete="off" spellcheck="false">
      <label for="f-purl">This app's address, as you open it</label>
      <input id="f-purl" type="url" inputmode="url" value="${esc(draft.purl ?? x.publicUrl)}" placeholder="http://nas:3000" autocomplete="off" spellcheck="false">
      <p>Used for the link in the message. A new address to post to starts without a token: type it again.</p>
      ${err('notify')}
      <div class="fbtns"><button class="btn" type="submit"${busy === 'notify' ? ' disabled' : ''}>${icon('check')}Save</button>${cancel}${forget('extras', x.notifyFrom, x.publicFrom)}</div>
    </form>`;
  }

  function lockRow() {
    const l = s.lock;
    const line = l.on ? (l.from === 'env' ? 'On · set by ADMIN_PASSWORD where wco-dl is started' : 'On · these settings ask for a password') : 'Off · anyone on your network can change these settings';
    const out = l.on ? '<button class="btn btn-quiet" type="button" data-act="signout">Lock now</button>' : '';
    if (l.from === 'env') return head(l.on ? 'ok' : '', 'Lock these settings', line, out);
    if (open !== 'lock') return head(l.on ? 'ok' : '', 'Lock these settings', line, out + change('lock', l.on ? 'Change' : 'Set a password'));
    return head(l.on ? 'ok' : '', 'Lock these settings', line) + `<form class="sform" data-form="lock">
      <p>The password guards this page and the Settings dialog. The rest of wco-dl stays open to everyone who can reach it. If it is forgotten, remove "lock" from connections.json in the config folder and restart.</p>
      <label for="f-pass">${l.on ? 'New password' : 'Password'}, 8 characters or more</label>
      <input id="f-pass" type="password" value="${esc(draft.pass ?? '')}" autocomplete="new-password" minlength="8" required>
      ${err('lock')}
      <div class="fbtns"><button class="btn" type="submit"${busy === 'lock' ? ' disabled' : ''}>${icon('check')}Save</button>${cancel}${l.on ? '<button class="btn btn-quiet danger" type="button" data-act="unlockall">Remove the password</button>' : ''}</div>
    </form>`;
  }

  function keep() {
    const v = (id) => $(id)?.value;
    for (const [k, id] of [['url', 'f-url'], ['key', 'f-key'], ['path', 'f-path'], ['nurl', 'f-nurl'], ['ntok', 'f-ntok'], ['purl', 'f-purl'], ['pass', 'f-pass']]) if (v(id) !== undefined) draft[k] = v(id);
  }

  function render() {
    $('status').hidden = true;
    $('unlock').hidden = !locked;
    $('steps').hidden = $('finish').hidden = locked || !s;
    if (locked) { $('title').textContent = 'Settings'; $('tally').textContent = ''; $('again').hidden = true; return; }
    if (!s) return;
    const first = !s.ready;
    $('title').textContent = first ? 'Set up wco-dl' : 'Settings';
    document.title = `${first ? 'Set up' : 'Settings'} · wco-dl`;
    $('lead').textContent = first ? 'Three things have to work before wco-dl can fill gaps. Each line below tests itself and says what to fix.'
      : 'What wco-dl needs to work, tested each time you open this page.';
    const ready = [s.sonarr, s.folder, s.helper].filter((c) => c.state === 'ok').length;
    $('tally').textContent = `${ready} of 3 working`;
    $('again').hidden = false; $('again').innerHTML = `${icon('refresh')}Test again`;
    $('steps').innerHTML = `<li>${sonarrRow()}</li><li>${folderRow()}</li>
      <li>${head(s.helper.state, 'Cloudflare helper', s.helper.state === 'ok' ? `Answering at ${s.helper.url} · needed because wcostream sits behind Cloudflare` : s.helper.message)}</li>
      <li>${head('', 'Overnight hours, quality and the dub calendar', 'When the overnight runs happen, how many episodes a night, and the dub calendar token', '<button class="btn btn-quiet" type="button" data-act="dialog">Open</button>')}</li>
      <li>${notifyRow()}</li><li>${lockRow()}</li>`;
    const openBtn = $('open');
    openBtn.innerHTML = `${icon('check')}Open wco-dl`;
    openBtn.setAttribute('aria-disabled', String(!s.ready));
    if (s.ready) openBtn.removeAttribute('tabindex'); else openBtn.setAttribute('tabindex', '-1');
    $('openhint').textContent = s.ready ? (s.helper.state === 'ok' ? 'Everything it needs is working.' : 'Sonarr and the folder work. Downloads will fail until the Cloudflare helper answers.')
      : 'Ready when Sonarr and the download folder both pass.';
    if (focus) { const el = document.querySelector(focus); focus = ''; el?.focus(); }
  }

  async function load(first) {
    try {
      s = await call('GET', '/setup'); locked = false;
      if (first) open = s.sonarr.state !== 'ok' ? 'sonarr' : s.folder.state === 'bad' ? 'folder' : '';
    } catch (e) {
      if (e.status === 401) { locked = true; s = null; }
      else { const st = $('status'); st.hidden = false; st.classList.add('err'); st.textContent = `The check-up did not run: ${e.message}. Reload the page to try again.`; return; }
    }
    render();
    if (locked) $('u-pass').focus();
  }

  // One save: mark the row busy, send, then show the new check-up or the reason it was refused.
  async function save(row, url, body, done) {
    keep(); busy = row; delete errs[row]; render();
    try {
      const d = await call('POST', url, body);
      if (d && d.sonarr) s = d; else s = await call('GET', '/setup');
      draft = {}; browse = null; open = '';
      done?.();
    } catch (e) {
      if (e.status === 401) { busy = ''; return load(); }
      errs[row] = e.message;
    }
    busy = ''; render();
  }

  async function pick(dir) {
    keep();
    try {
      const d = await call('GET', '/setup/folders' + (dir ? '?path=' + encodeURIComponent(dir) : ''));
      browse = { at: dir || '', parent: d.parent || '', directories: d.directories || [] };
      if (dir) draft.path = dir;
      delete errs.folder;
    } catch (e) { errs.folder = e.message; }
    focus = dir ? '#f-path' : '.browse button';
    render();
  }

  $('steps').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const form = ev.target.dataset.form; keep();
    if (form === 'sonarr') save('sonarr', '/setup/sonarr', { url: draft.url, apiKey: draft.key }, () => { UI.toast('Sonarr connected'); if (s.folder.state === 'bad') { open = 'folder'; focus = '#f-path'; } });
    if (form === 'folder') save('folder', '/setup/folder', { importBase: draft.path }, () => UI.toast('Sonarr sees the download folder'));
    if (form === 'notify') save('notify', '/setup/extras', { notifyUrl: draft.nurl, notifyToken: draft.ntok, publicUrl: draft.purl }, () => UI.toast('Saved'));
    if (form === 'lock') save('lock', '/setup/lock', { password: draft.pass }, () => UI.toast('Password set. This browser stays signed in for 12 hours.'));
  });

  $('steps').addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    if (b.dataset.open !== undefined) {
      open = b.dataset.open; draft = {}; browse = null; errs = {};
      focus = open ? { sonarr: '#f-url', folder: '#f-path', notify: '#f-nurl', lock: '#f-pass' }[open] : '';
      return render();
    }
    if (b.dataset.reset) return save(b.dataset.reset === 'extras' ? 'notify' : b.dataset.reset, '/setup/reset', { part: b.dataset.reset }, () => UI.toast('Back to the values wco-dl started with'));
    if (b.dataset.browse !== undefined) return pick(b.dataset.browse);
    if (b.hasAttribute('data-browse-up')) return pick(browse?.parent || '');
    const act = b.dataset.act;
    if (act === 'browse') return browse ? (keep(), browse = null, render()) : pick(draft.path || $('f-path')?.value || '');
    if (act === 'dialog') return (UI.openSettings || (() => $('settingsbtn')?.click()))();
    if (act === 'unlockall') return save('lock', '/setup/lock', { password: '' }, () => UI.toast('Password removed'));
    if (act === 'signout') return call('POST', '/setup/signout', {}).then(() => load(), () => load());
  });

  $('again').addEventListener('click', async () => {
    keep(); $('again').disabled = true; $('tally').textContent = 'Testing…';
    await load(); $('again').disabled = false;
  });

  $('unlock').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const e = $('u-err'); e.hidden = true; $('u-go').disabled = true;
    try { await call('POST', '/setup/unlock', { password: $('u-pass').value }); $('u-pass').value = ''; await load(true); }
    catch (x) { e.textContent = x.message; e.hidden = false; $('u-pass').select(); }
    $('u-go').disabled = false;
  });

  load(true);
})();
