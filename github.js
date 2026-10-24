(() => {
  'use strict';

  const $ = s => document.querySelector(s);
  const CAI = window.CAI;
  const KEY = 'cai.gh.v1';
  const API = 'https://api.github.com';

  // Token and repo settings live only in this browser's localStorage.
  let cfg = {};
  try { cfg = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { cfg = {}; }
  const saveCfg = () => { try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) { /* ignore */ } };

  // path -> { sha, name } for files loaded from GitHub
  const loaded = new Map();

  const b64enc = s => {
    const bytes = new TextEncoder().encode(s);
    let bin = '';
    bytes.forEach(b => { bin += String.fromCharCode(b); });
    return btoa(bin);
  };
  const b64dec = s => {
    const bin = atob(s.replace(/\s/g, ''));
    return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
  };
  const encPath = p => p.split('/').map(encodeURIComponent).join('/');

  function status(text, kind) {
    const el = $('#ghStatus');
    el.textContent = text;
    el.className = 'gh-msg' + (kind ? ' ' + kind : '');
  }

  async function gh(path, opts = {}) {
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: 'Bearer ' + cfg.token
    };
    if (opts.body) headers['Content-Type'] = 'application/json';
    const r = await fetch(API + path, Object.assign({}, opts, { headers }));
    if (!r.ok) {
      let msg = r.status + ' ' + r.statusText;
      try { const j = await r.json(); if (j.message) msg += ': ' + j.message; } catch (e) { /* no body */ }
      throw new Error(msg);
    }
    return r.json();
  }

  function repoPath(extra) {
    return '/repos/' + cfg.repo.split('/').map(encodeURIComponent).join('/') + extra;
  }

  function fillForm() {
    $('#ghRepo').value = cfg.repo || '';
    $('#ghBranch').value = cfg.branch || '';
    $('#ghDir').value = cfg.dir || '';
    $('#ghToken').value = cfg.token || '';
  }

  function readForm() {
    cfg.token = $('#ghToken').value.trim();
    cfg.repo = $('#ghRepo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
    cfg.branch = $('#ghBranch').value.trim();
    cfg.dir = $('#ghDir').value.trim().replace(/^\/+|\/+$/g, '');
  }

  function renderList(items) {
    const ul = $('#ghList');
    ul.innerHTML = '';
    items.forEach(it => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.textContent = (it.type === 'dir' ? '▸ ' : '') + it.name;
      b.title = it.path;
      b.onclick = () => (it.type === 'dir' ? browse(it.path) : openFile(it.path));
      li.appendChild(b);
      ul.appendChild(li);
    });
  }

  async function connect() {
    readForm();
    if (!cfg.token || !cfg.repo) { status('Enter a token and a repository (owner/repo).', 'err'); return; }
    status('Connecting…');
    try {
      const me = await gh('/user');
      const repo = await gh(repoPath(''));
      if (!cfg.branch) cfg.branch = repo.default_branch;
      saveCfg();
      status('Connected as ' + me.login + '. Browsing ' + repo.full_name + '.', 'ok');
      await browse(cfg.dir || '');
    } catch (e) {
      status('Couldn’t connect: ' + e.message, 'err');
    }
  }

  async function browse(dir) {
    readForm();
    if (!cfg.token || !cfg.repo) { status('Connect first.', 'err'); return; }
    saveCfg();
    const ref = cfg.branch ? '?ref=' + encodeURIComponent(cfg.branch) : '';
    try {
      const items = await gh(repoPath('/contents/' + encPath(dir || '')) + ref);
      if (!Array.isArray(items)) throw new Error('That path is a file, not a folder.');
      const sorted = items
        .filter(i => i.type === 'dir' || i.type === 'file')
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
      if (dir) {
        const parent = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
        sorted.unshift({ name: '.. (up)', path: parent, type: 'dir' });
      }
      renderList(sorted);
      cfg.dir = dir || '';
      saveCfg();
      $('#ghDir').value = cfg.dir;
    } catch (e) {
      status('Couldn’t list that folder: ' + e.message, 'err');
    }
  }

  async function openFile(path) {
    readForm();
    const ref = cfg.branch ? '?ref=' + encodeURIComponent(cfg.branch) : '';
    try {
      const f = await gh(repoPath('/contents/' + encPath(path)) + ref);
      if (f.encoding !== 'base64' || typeof f.content !== 'string') throw new Error('This file can’t be opened as text.');
      const text = b64dec(f.content);
      loaded.set(path, { sha: f.sha });
      // The editor keeps flat file names, so the repo path is used as the name.
      CAI.openContent(path, text);
      status('Opened ' + path + '.', 'ok');
    } catch (e) {
      status('Couldn’t open that file: ' + e.message, 'err');
    }
  }

  async function commit() {
    readForm();
    if (!cfg.token || !cfg.repo) { status('Connect first.', 'err'); return; }
    const cur = CAI.active();
    const path = (cfg.dir ? cfg.dir + '/' : '') + cur.name.replace(/^\/+/, '');
    const known = loaded.get(path);
    const message = $('#ghMsg').value.trim() || ('Update ' + cur.name + ' from web editor');
    const body = { message, content: b64enc(cur.content) };
    if (cfg.branch) body.branch = cfg.branch;
    if (known) body.sha = known.sha;
    status('Committing ' + path + '…');
    try {
      const res = await gh(repoPath('/contents/' + encPath(path)), { method: 'PUT', body: JSON.stringify(body) });
      loaded.set(path, { sha: res.content.sha });
      saveCfg();
      status('Committed ' + path + ' to ' + (cfg.branch || 'default branch') + '.', 'ok');
    } catch (e) {
      status('Commit failed: ' + e.message + (known ? '' : ' (If this file already exists in the repo, open it first so the commit can update it.)'), 'err');
    }
  }

  $('#ghConnect').onclick = connect;
  $('#ghForget').onclick = () => {
    cfg = {};
    saveCfg();
    loaded.clear();
    fillForm();
    $('#ghList').innerHTML = '';
    status('Cleared the saved token and repository from this browser.', 'ok');
  };
  $('#ghCommit').onclick = commit;
  $('#ghMsg').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });

  fillForm();
  if (cfg.token && cfg.repo) $('#ghBox').open = true;
})();
