(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const KEY_FILES = 'cai.files.v2';
  const KEY_ACTIVE = 'cai.active.v2';
  const KEY_FONT = 'cai.font.v1';
  const KEY_WRAP = 'cai.wrap.v1';
  const KEY_THEME = 'cai.theme.v1';

  const SAMPLE = [
    {
      name: 'index.html',
      content: `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Hello</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <h1>Hello</h1>
  <button id="go">Click me</button>
  <p id="out"></p>
  <script src="script.js"></script>
</body>
</html>
`
    },
    {
      name: 'style.css',
      content: `body {
  font-family: system-ui, sans-serif;
  padding: 2rem;
}

button {
  padding: .5rem 1rem;
}
`
    },
    {
      name: 'script.js',
      content: `let count = 0;

document.getElementById('go').addEventListener('click', () => {
  count++;
  document.getElementById('out').textContent = 'Clicked ' + count + ' times';
  console.log('count is', count);
});
`
    }
  ];

  const MODES = {
    html: 'htmlmixed', htm: 'htmlmixed', css: 'css', js: 'javascript', mjs: 'javascript',
    json: { name: 'javascript', json: true }, ts: 'text/typescript', py: 'python',
    c: 'text/x-csrc', h: 'text/x-csrc', cpp: 'text/x-c++src', java: 'text/x-java',
    cs: 'text/x-csharp', md: 'markdown', xml: 'xml', svg: 'xml'
  };
  const LANG_NAMES = {
    html: 'HTML', htm: 'HTML', css: 'CSS', js: 'JavaScript', mjs: 'JavaScript', json: 'JSON',
    ts: 'TypeScript', py: 'Python', c: 'C', h: 'C', cpp: 'C++', java: 'Java', cs: 'C#',
    md: 'Markdown', xml: 'XML', svg: 'SVG'
  };
  const ext = n => (n.split('.').pop() || '').toLowerCase();
  const modeFor = n => MODES[ext(n)] || null;
  const langOf = n => ({ htm: 'html', mjs: 'js', py: 'python', ts: 'typescript', md: 'markdown' }[ext(n)] || ext(n));

  let toastTimer = 0;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('on'), 2400);
  }

  // ---------- files ----------
  function loadSaved() {
    try {
      const j = JSON.parse(localStorage.getItem(KEY_FILES));
      if (Array.isArray(j) && j.length) return j;
    } catch (e) { /* use sample */ }
    return SAMPLE;
  }

  const files = loadSaved().map(f => ({
    name: f.name,
    open: f.open !== false,
    doc: CodeMirror.Doc(f.content, modeFor(f.name))
  }));
  if (!files.some(f => f.open)) files[0].open = true;
  let active = files.findIndex(f => f.open);
  try {
    const a = parseInt(localStorage.getItem(KEY_ACTIVE), 10);
    if (a >= 0 && a < files.length && files[a].open) active = a;
  } catch (e) { /* ignore */ }

  const cm = CodeMirror($('#editor'), {
    theme: 'cai',
    lineNumbers: true,
    tabSize: 2,
    indentUnit: 2,
    indentWithTabs: false,
    autoCloseBrackets: true,
    matchBrackets: true,
    styleActiveLine: true,
    foldGutter: true,
    gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter'],
    extraKeys: {
      'Ctrl-Enter': () => run(),
      'Ctrl-S': () => download(),
      'Ctrl-/': 'toggleComment',
      'Ctrl-K': () => openAssistant(),
      'Ctrl-Space': c => c.showHint({ completeSingle: false }),
      'Ctrl-F': 'findPersistent',
      'Ctrl-H': 'replace',
      'Ctrl-G': 'findNext',
      'Shift-Ctrl-G': 'findPrev',
      'Alt-G': 'jumpToLine',
      Tab: c => (c.somethingSelected() ? c.indentSelection('add') : c.replaceSelection('  ', 'end')),
      'Shift-Tab': c => c.indentSelection('subtract')
    }
  });

  let saveTimer = 0;
  function persist() {
    try {
      localStorage.setItem(KEY_FILES, JSON.stringify(files.map(f => ({ name: f.name, open: f.open, content: f.doc.getValue() }))));
      localStorage.setItem(KEY_ACTIVE, String(active));
    } catch (e) { /* storage full or blocked */ }
  }
  const persistSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(persist, 400); };
  cm.on('change', persistSoon);

  // sidebar list of every file
  function renderFiles() {
    const ul = $('#fileList');
    ul.innerHTML = '';
    files.forEach((f, i) => {
      const li = document.createElement('li');
      if (i === active) li.className = 'on';
      li.dataset.ext = ext(f.name);
      const name = document.createElement('button');
      name.className = 'name';
      name.textContent = f.name;
      name.title = f.name;
      name.onclick = () => openFile(i);
      const acts = document.createElement('span');
      acts.className = 'acts';
      const ren = document.createElement('button');
      ren.textContent = 'Rename';
      ren.onclick = () => renameFile(i);
      const del = document.createElement('button');
      del.textContent = 'Delete';
      del.onclick = () => deleteFile(i);
      acts.append(ren, del);
      li.append(name, acts);
      ul.appendChild(li);
    });
  }

  // tabs for the files that are open
  function renderTabs() {
    const bar = $('#tabs');
    bar.innerHTML = '';
    files.forEach((f, i) => {
      if (!f.open) return;
      const tab = document.createElement('div');
      tab.className = 'tab' + (i === active ? ' on' : '');
      tab.setAttribute('role', 'tab');
      tab.dataset.ext = ext(f.name);
      const name = document.createElement('button');
      name.className = 'tab-name';
      name.textContent = f.name;
      name.onclick = () => openFile(i);
      const x = document.createElement('button');
      x.className = 'tab-x';
      x.textContent = '×';
      x.title = 'Close';
      x.setAttribute('aria-label', 'Close ' + f.name);
      x.onclick = e => { e.stopPropagation(); closeTab(i); };
      tab.addEventListener('auxclick', e => { if (e.button === 1) { e.preventDefault(); closeTab(i); } });
      tab.append(name, x);
      bar.appendChild(tab);
    });
    const plus = document.createElement('button');
    plus.className = 'tab-new';
    plus.textContent = '+';
    plus.title = 'New file';
    plus.setAttribute('aria-label', 'New file');
    plus.onclick = newFilePrompt;
    bar.appendChild(plus);
    const on = bar.querySelector('.tab.on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function updateStatus() {
    const c = cm.getCursor();
    const sel = cm.getSelection();
    $('#sbPos').textContent = 'Ln ' + (c.line + 1) + ', Col ' + (c.ch + 1) + (sel ? '  (' + sel.length + ' selected)' : '');
  }
  cm.on('cursorActivity', updateStatus);

  function openFile(i) {
    files[i].open = true;
    active = i;
    cm.swapDoc(files[i].doc);
    $('#sbLang').textContent = LANG_NAMES[ext(files[i].name)] || 'Plain text';
    renderFiles();
    renderTabs();
    updateStatus();
    persist();
    cm.focus();
  }

  function closeTab(i) {
    const openIdx = files.map((f, k) => (f.open ? k : -1)).filter(k => k >= 0);
    if (openIdx.length === 1) { toast('That’s the last open file.'); return; }
    files[i].open = false;
    if (i === active) {
      const next = openIdx.filter(k => k !== i);
      openFile(next.find(k => k > i) ?? next[next.length - 1]);
    } else {
      renderTabs();
      persist();
    }
  }

  function uniqueName(n) {
    if (!files.some(f => f.name === n)) return n;
    const dot = n.lastIndexOf('.');
    const base = dot > 0 ? n.slice(0, dot) : n;
    const tail = dot > 0 ? n.slice(dot) : '';
    let k = 2;
    while (files.some(f => f.name === base + '-' + k + tail)) k++;
    return base + '-' + k + tail;
  }

  function addFile(name, content) {
    name = uniqueName(name);
    files.push({ name, open: true, doc: CodeMirror.Doc(content || '', modeFor(name)) });
    openFile(files.length - 1);
    return name;
  }

  function renameFile(i) {
    const n = (prompt('New name', files[i].name) || '').trim();
    if (!n || n === files[i].name) return;
    if (files.some((f, j) => j !== i && f.name === n)) { toast('A file with that name already exists.'); return; }
    files[i].name = n;
    files[i].doc.setOption('mode', modeFor(n));
    if (i === active) $('#sbLang').textContent = LANG_NAMES[ext(n)] || 'Plain text';
    renderFiles();
    renderTabs();
    persist();
  }

  function deleteFile(i) {
    if (files.length === 1) { toast('Keep at least one file.'); return; }
    if (!confirm('Delete ' + files[i].name + '?')) return;
    const wasActive = i === active;
    files.splice(i, 1);
    if (!files.some(f => f.open)) files[0].open = true;
    if (wasActive) {
      active = Math.min(i, files.length - 1);
      if (!files[active].open) active = files.findIndex(f => f.open);
    } else if (i < active) {
      active--;
    }
    openFile(active);
  }

  function newFilePrompt() {
    const n = (prompt('File name', 'untitled.js') || '').trim();
    if (n) addFile(n, '');
  }
  $('#btnNew').onclick = newFilePrompt;

  // ---------- save and open ----------
  function download() {
    const f = files[active];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([f.doc.getValue()], { type: 'text/plain' }));
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  $('#btnSave').onclick = download;
  $('#btnOpen').onclick = () => $('#openInput').click();
  $('#openInput').onchange = e => {
    [...e.target.files].forEach(file => {
      const r = new FileReader();
      r.onload = () => addFile(file.name, String(r.result));
      r.readAsText(file);
    });
    e.target.value = '';
  };

  // ---------- run ----------
  const frame = $('#frame');
  const consoleEl = $('#console');

  const HOOK = '<script>(function(){var s=function(t,a){var m=a.map(function(x){try{return typeof x==="string"?x:JSON.stringify(x)}catch(e){return String(x)}}).join(" ");parent.postMessage({__cai:1,t:t,m:m},"*")};["log","info","warn","error"].forEach(function(k){var o=console[k];console[k]=function(){s(k,[].slice.call(arguments));o.apply(console,arguments)}});addEventListener("error",function(e){s("error",[e.message+" (line "+e.lineno+")"])});addEventListener("unhandledrejection",function(e){s("error",[String(e.reason)])})})()</script>';

  function bundle(html) {
    const byName = n => files.find(f => f.name === n.replace(/^\.\//, ''));
    html = html.replace(/<link\b[^>]*>/gi, m => {
      const h = /href=["']([^"']+)["']/i.exec(m);
      const f = h && /stylesheet/i.test(m) ? byName(h[1]) : null;
      return f ? '<style>' + f.doc.getValue() + '</style>' : m;
    });
    html = html.replace(/<script\b([^>]*?)\ssrc=["']([^"']+)["']([^>]*)><\/script>/gi, (m, a, src, b) => {
      const f = byName(src);
      return f ? '<script' + a + b + '>' + f.doc.getValue().replace(/<\/script/gi, '<\\/script') + '</script>' : m;
    });
    return html;
  }

  function withHook(html) {
    return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, m => m + HOOK) : HOOK + html;
  }

  function log(type, msg) {
    const d = document.createElement('div');
    d.className = type;
    d.textContent = msg;
    consoleEl.appendChild(d);
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  function run() {
    const f = files[active];
    const e = ext(f.name);
    let html;
    if (e === 'html' || e === 'htm') {
      html = bundle(f.doc.getValue());
    } else if (e === 'js' || e === 'mjs') {
      html = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><script>' +
        f.doc.getValue().replace(/<\/script/gi, '<\\/script') + '</script></body></html>';
    } else if (e === 'css') {
      html = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' + f.doc.getValue() +
        '</style></head><body><h1>Heading</h1><p>Paragraph with <a href="#">a link</a>.</p><button>Button</button></body></html>';
    } else {
      toast('Run works with HTML, JavaScript and CSS files.');
      return;
    }
    consoleEl.innerHTML = '';
    log('sys', 'Running ' + f.name);
    $('#preview').classList.add('open');
    frame.srcdoc = withHook(html);
    cm.refresh();
  }

  window.addEventListener('message', e => {
    if (e.source !== frame.contentWindow || !e.data || !e.data.__cai) return;
    log(e.data.t, e.data.m);
  });

  $('#btnRun').onclick = run;
  $('#closePreview').onclick = () => { $('#preview').classList.remove('open'); frame.srcdoc = ''; cm.refresh(); };
  $('#clearConsole').onclick = () => { consoleEl.innerHTML = ''; };

  // ---------- theme ----------
  let theme = 'dark';
  try {
    theme = localStorage.getItem(KEY_THEME) ||
      (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  } catch (e) { /* ignore */ }
  function setTheme(t) {
    theme = t;
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem(KEY_THEME, t); } catch (e) { /* ignore */ }
  }
  setTheme(theme);
  $('#btnTheme').onclick = () => setTheme(theme === 'dark' ? 'light' : 'dark');

  // ---------- layout, text size, wrap ----------
  const refreshSoon = () => setTimeout(() => cm.refresh(), 50);
  $('#btnFiles').onclick = () => { document.body.classList.toggle('hide-files'); refreshSoon(); };
  function openAssistant() {
    document.body.classList.remove('hide-ai');
    refreshSoon();
    const p = $('#prompt');
    if (p) p.focus();
  }
  $('#btnAI').onclick = () => { document.body.classList.toggle('hide-ai'); refreshSoon(); };
  $('#sbAI').onclick = () => { document.body.classList.toggle('hide-ai'); refreshSoon(); };
  if (window.innerWidth <= 960) document.body.classList.add('hide-files', 'hide-ai');

  let fontPx = 14;
  try { fontPx = parseInt(localStorage.getItem(KEY_FONT), 10) || 14; } catch (e) { /* ignore */ }
  function setFont(px) {
    fontPx = Math.max(10, Math.min(28, px));
    document.querySelector('.CodeMirror').style.fontSize = fontPx + 'px';
    cm.refresh();
    try { localStorage.setItem(KEY_FONT, String(fontPx)); } catch (e) { /* ignore */ }
  }
  $('#fontDown').onclick = () => setFont(fontPx - 1);
  $('#fontUp').onclick = () => setFont(fontPx + 1);

  let wrap = false;
  try { wrap = localStorage.getItem(KEY_WRAP) === '1'; } catch (e) { /* ignore */ }
  function setWrap(on) {
    wrap = on;
    cm.setOption('lineWrapping', on);
    $('#sbWrap').textContent = 'Wrap: ' + (on ? 'on' : 'off');
    try { localStorage.setItem(KEY_WRAP, on ? '1' : '0'); } catch (e) { /* ignore */ }
  }
  $('#sbWrap').onclick = () => setWrap(!wrap);

  // ---------- hooks for the assistant ----------
  window.CAI = {
    toast,
    context() {
      const f = files[active];
      const sel = cm.getSelection();
      const code = sel || f.doc.getValue();
      const cut = code.length > 8000;
      return (sel ? 'Selected code from ' : 'File ') + f.name + ':\n```' + langOf(f.name) + '\n' +
        code.slice(0, 8000) + (cut ? '\n… (truncated)' : '') + '\n```';
    },
    insert(text) { cm.replaceRange(text, cm.getCursor()); cm.focus(); },
    apply(text) {
      if (cm.somethingSelected()) cm.replaceSelection(text, 'around');
      else cm.setValue(text);
      cm.focus();
    },
    hasSelection: () => cm.somethingSelected()
  };

  openFile(active);
  setFont(fontPx);
  setWrap(wrap);
})();
