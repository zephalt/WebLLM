(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const CAI = window.CAI;
  const WEBLLM_URL = 'https://esm.run/@mlc-ai/web-llm@0.2.79';
  const KEY = 'cai.ai.v1';

  // Used only if the WebLLM library can't be loaded, so the list isn't empty.
  const FALLBACK = [
    'Qwen2.5-Coder-0.5B-Instruct-q4f16_1-MLC',
    'Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC',
    'Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC',
    'Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC',
    'Qwen3-4B-q4f16_1-MLC',
    'Qwen3-8B-q4f16_1-MLC',
    'DeepSeek-R1-Distill-Qwen-7B-q4f16_1-MLC',
    'Llama-3.2-3B-Instruct-q4f16_1-MLC',
    'Phi-3.5-mini-instruct-q4f16_1-MLC'
  ];

  const SYSTEM = 'You are a concise coding assistant inside a code editor. ' +
    'When you write or change code, give the complete updated code in one fenced code block with a language tag, ' +
    'so the user can apply it directly. Keep explanations short and put them after the code.';

  const ACTIONS = {
    explain: 'Explain what this code does, briefly.',
    fix: 'Find and fix bugs in this code. Return the corrected code.',
    refactor: 'Refactor this code for clarity without changing its behavior. Return the full result.',
    comment: 'Add concise comments to this code. Return the full result.',
    tests: 'Write unit tests for this code.'
  };

  let cfg = {};
  try { cfg = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { cfg = {}; }
  const saveCfg = () => { try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) { /* ignore */ } };

  let webllm = null;
  let engine = null;
  let loadedId = '';
  let models = [];
  let provider = cfg.provider === 'cloud' ? 'cloud' : 'local';
  let busy = false;
  let loading = false;
  let abort = null;
  let history = [];

  const log = $('#log');
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function setAIState(t) {
    const e = $('#sbAI');
    if (e) e.textContent = t;
  }

  function setStatus(text, kind) {
    const s = $('#status');
    s.textContent = text;
    s.className = 'status' + (kind ? ' ' + kind : '');
  }

  // ---------- model list ----------
  const isCoder = id => /coder|starcoder|codellama/i.test(id);
  const shortName = id => id.replace(/-MLC$/, '');

  function fillModels() {
    const sel = $('#modelSel');
    sel.innerHTML = '';
    const coding = document.createElement('optgroup');
    coding.label = 'Coding models';
    const other = document.createElement('optgroup');
    other.label = 'General and reasoning models';
    models.slice().sort((a, b) => a.vram - b.vram).forEach(m => {
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = shortName(m.id) + (m.vram ? ' · ' + (m.vram / 1024).toFixed(1) + ' GB' : '');
      (isCoder(m.id) ? coding : other).appendChild(o);
    });
    if (coding.children.length) sel.appendChild(coding);
    sel.appendChild(other);
    const ids = models.map(m => m.id);
    const pick = ids.includes(cfg.model) ? cfg.model
      : ids.find(i => /Qwen2\.5-Coder-3B/.test(i)) || ids.find(isCoder) || ids[0];
    if (pick) sel.value = pick;
  }

  async function initLib() {
    if (!navigator.gpu) {
      setStatus('WebGPU isn’t available in this browser, so local models can’t run. Use the Cloud API tab instead.', 'warn');
    }
    try {
      webllm = await import(WEBLLM_URL);
      models = webllm.prebuiltAppConfig.model_list
        .filter(m => !m.model_type)
        .map(m => ({ id: m.model_id, vram: m.vram_required_MB || 0 }));
      if (navigator.gpu) setStatus('Pick a model and choose Download and load. Models are cached after the first download.');
    } catch (e) {
      models = FALLBACK.map(id => ({ id, vram: 0 }));
      setStatus('Couldn’t load the WebLLM library (' + e.message + '). Check your connection, or use the Cloud API tab.', 'warn');
    }
    fillModels();
  }

  async function loadModel() {
    if (!webllm) { CAI.toast('The WebLLM library hasn’t loaded.'); return; }
    if (!navigator.gpu) { CAI.toast('This browser has no WebGPU.'); return; }
    const id = $('#modelSel').value;
    cfg.model = id;
    saveCfg();
    loading = true;
    $('#btnLoad').disabled = true;
    const cb = p => {
      $('#bar').style.width = Math.round((p.progress || 0) * 100) + '%';
      setStatus(p.text || 'Loading…');
    };
    try {
      if (!engine) {
        engine = await webllm.CreateMLCEngine(id, { initProgressCallback: cb });
      } else {
        engine.setInitProgressCallback(cb);
        await engine.reload(id);
      }
      loadedId = id;
      $('#bar').style.width = '100%';
      setStatus('Ready: ' + shortName(id));
      setAIState('AI: ' + shortName(id).replace(/-Instruct|-q4f\d+_\d+/g, ''));
    } catch (e) {
      loadedId = '';
      setAIState('AI: off');
      setStatus('Couldn’t load that model: ' + e.message + ' Try a smaller one.', 'warn');
    } finally {
      loading = false;
      $('#btnLoad').disabled = false;
    }
  }

  // ---------- provider tabs ----------
  function showProvider() {
    $('#tabLocal').classList.toggle('on', provider === 'local');
    $('#tabCloud').classList.toggle('on', provider === 'cloud');
    $('#localBox').hidden = provider !== 'local';
    $('#cloudBox').hidden = provider !== 'cloud';
    if (provider === 'cloud') {
      setStatus('Requests go straight from this page to the endpoint you enter.');
      setAIState('AI: cloud');
    } else {
      if (loadedId) setStatus('Ready: ' + shortName(loadedId));
      setAIState(loadedId ? 'AI: ' + shortName(loadedId).replace(/-Instruct|-q4f\d+_\d+/g, '') : 'AI: off');
    }
  }
  $('#tabLocal').onclick = () => { provider = 'local'; cfg.provider = provider; saveCfg(); showProvider(); };
  $('#tabCloud').onclick = () => { provider = 'cloud'; cfg.provider = provider; saveCfg(); showProvider(); };

  $('#cBase').value = cfg.base || $('#preset').value;
  $('#cKey').value = cfg.key || '';
  $('#cModel').value = cfg.cmodel || '';
  if (cfg.preset !== undefined) $('#preset').value = cfg.preset;
  $('#preset').onchange = e => { $('#cBase').value = e.target.value; cfg.preset = e.target.value; syncCloud(); };
  ['#cBase', '#cKey', '#cModel'].forEach(s => $(s).addEventListener('input', syncCloud));
  function syncCloud() {
    cfg.base = $('#cBase').value.trim();
    cfg.key = $('#cKey').value.trim();
    cfg.cmodel = $('#cModel').value.trim();
    saveCfg();
  }
  $('#btnLoad').onclick = loadModel;

  // ---------- rendering ----------
  function fmt(p) {
    return esc(p)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  }

  function textHtml(s) {
    return s.split(/\n{2,}/).filter(p => p.trim()).map(p => '<p>' + fmt(p.trim()) + '</p>').join('');
  }

  function render(text) {
    const blocks = [];
    let think = '';
    text = text.replace(/<think>([\s\S]*?)(?:<\/think>|$)/, (m, a) => { think = a.trim(); return ''; }).trim();
    let html = '';
    let last = 0;
    let m;
    const re = /```([\w+#-]*)[^\n]*\n?([\s\S]*?)(?:```|$)/g;
    while ((m = re.exec(text)) !== null) {
      html += textHtml(text.slice(last, m.index));
      const code = m[2].replace(/\n$/, '');
      blocks.push(code);
      html += '<div class="code"><div class="code-h"><span>' + esc(m[1] || 'code') + '</span><span class="code-a">' +
        '<button data-a="copy" data-i="' + (blocks.length - 1) + '">Copy</button>' +
        '<button data-a="insert" data-i="' + (blocks.length - 1) + '" title="Insert at the cursor">Insert</button>' +
        '<button data-a="apply" data-i="' + (blocks.length - 1) + '" title="Replace the selection, or the whole file if nothing is selected">Apply</button>' +
        '</span></div><pre>' + esc(code) + '</pre></div>';
      last = re.lastIndex;
      if (m[0].length === 0) re.lastIndex++;
    }
    html += textHtml(text.slice(last));
    if (think) html = '<details class="think"><summary>Thinking</summary><div>' + esc(think) + '</div></details>' + html;
    return { html, blocks };
  }

  function addMsg(role, text) {
    const empty = log.querySelector('.empty');
    if (empty) empty.remove();
    const el = document.createElement('div');
    el.className = 'msg ' + role;
    log.appendChild(el);
    setMsg(el, text);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  function setMsg(el, text) {
    if (el.classList.contains('user')) { el.textContent = text; return; }
    const r = render(text);
    el.innerHTML = r.html;
    el.__blocks = r.blocks;
  }

  log.addEventListener('click', e => {
    const b = e.target.closest('button[data-a]');
    if (!b) return;
    const msg = b.closest('.msg');
    const code = msg && msg.__blocks ? msg.__blocks[+b.dataset.i] : null;
    if (code == null) return;
    if (b.dataset.a === 'copy') {
      (navigator.clipboard ? navigator.clipboard.writeText(code) : Promise.reject()).then(
        () => CAI.toast('Copied'), () => CAI.toast('Couldn’t copy. Select the text and copy it by hand.'));
    } else if (b.dataset.a === 'insert') {
      CAI.insert(code);
      CAI.toast('Inserted at the cursor');
    } else {
      const sel = CAI.hasSelection();
      CAI.apply(code);
      CAI.toast(sel ? 'Replaced the selection' : 'Replaced the file. Undo with Ctrl+Z.');
    }
  });

  // ---------- generation ----------
  function ready() {
    if (provider === 'local') return !!loadedId && !loading;
    return !!($('#cModel').value.trim() && $('#cBase').value.trim());
  }

  function setBusy(b) {
    busy = b;
    $('#btnSend').hidden = b;
    $('#btnStop').hidden = !b;
  }

  async function runLocal(messages, onDelta) {
    const stream = await engine.chat.completions.create({ messages, stream: true, temperature: 0.3 });
    for await (const ch of stream) {
      const d = ch.choices[0] && ch.choices[0].delta && ch.choices[0].delta.content;
      if (d) onDelta(d);
    }
  }

  async function runCloud(messages, onDelta) {
    abort = new AbortController();
    const key = $('#cKey').value.trim();
    const r = await fetch($('#cBase').value.trim().replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, key ? { Authorization: 'Bearer ' + key } : {}),
      body: JSON.stringify({ model: $('#cModel').value.trim(), messages, stream: true, temperature: 0.3 }),
      signal: abort.signal
    });
    if (!r.ok) throw new Error(r.status + ' ' + (await r.text()).slice(0, 300));
    const rd = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) {
        if (!l.startsWith('data:')) continue;
        const d = l.slice(5).trim();
        if (!d || d === '[DONE]') continue;
        try {
          const j = JSON.parse(d);
          const t = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
          if (t) onDelta(t);
        } catch (e) { /* partial line */ }
      }
    }
  }

  async function send(text) {
    text = (text || '').trim();
    if (!text || busy) return;
    if (!ready()) {
      CAI.toast(provider === 'local' ? 'Load a model first.' : 'Enter an endpoint and model name first.');
      return;
    }
    setBusy(true);
    const ctx = $('#useCtx').checked ? CAI.context() : '';
    const messages = [{ role: 'system', content: SYSTEM }]
      .concat(history.slice(-6), [{ role: 'user', content: ctx ? ctx + '\n\n' + text : text }]);
    history.push({ role: 'user', content: text });
    addMsg('user', text);
    const el = addMsg('ai', '');
    el.classList.add('live');
    let acc = '';
    let raf = 0;
    const paint = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; setMsg(el, acc); log.scrollTop = log.scrollHeight; });
    };
    const onDelta = d => { acc += d; paint(); };
    try {
      if (provider === 'local') await runLocal(messages, onDelta);
      else await runCloud(messages, onDelta);
    } catch (e) {
      if (e.name !== 'AbortError') acc += (acc ? '\n\n' : '') + 'Error: ' + e.message;
    }
    cancelAnimationFrame(raf);
    raf = 0;
    setMsg(el, acc || '(no output)');
    el.classList.remove('live');
    history.push({ role: 'assistant', content: acc });
    abort = null;
    setBusy(false);
    log.scrollTop = log.scrollHeight;
  }

  $('#btnSend').onclick = () => { const p = $('#prompt'); const t = p.value; p.value = ''; send(t); };
  $('#btnStop').onclick = () => {
    if (provider === 'local' && engine) engine.interruptGenerate();
    if (abort) abort.abort();
  };
  $('#prompt').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#btnSend').click(); }
  });
  document.querySelectorAll('.quick button').forEach(b => { b.onclick = () => send(ACTIONS[b.dataset.q]); });
  $('#btnClearChat').onclick = () => {
    history = [];
    log.innerHTML = '<p class="empty">Chat cleared.</p>';
  };

  showProvider();
  initLib();
})();
