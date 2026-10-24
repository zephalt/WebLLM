(() => {
  'use strict';

  const $ = s => document.querySelector(s);
  const WEBLLM_URL = 'https://esm.run/@mlc-ai/web-llm@0.2.79';
  const KEY = 'cai.chat.v1';
  const SYSTEM = 'You are a friendly, helpful assistant. Answer clearly and concisely.';

  let cfg = {};
  try { cfg = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { cfg = {}; }
  const saveCfg = () => { try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) { /* ignore */ } };

  let webllm = null;
  let engine = null;
  let loadedId = '';
  let loading = false;
  let busy = false;
  let history = [];

  const log = $('#log');
  const shortName = id => id.replace(/-MLC$/, '');

  function setStatus(text, warn) {
    const s = $('#status');
    s.textContent = text;
    s.className = 'chat-status' + (warn ? ' warn' : '');
  }

  function updateSend() {
    $('#btnSend').disabled = busy || !loadedId || loading;
  }

  async function init() {
    if (!navigator.gpu) setStatus('WebGPU isn’t available in this browser, so the model can’t run here.', true);
    try {
      webllm = await import(WEBLLM_URL);
      const models = webllm.prebuiltAppConfig.model_list
        .filter(m => !m.model_type && !/coder/i.test(m.model_id))
        .map(m => ({ id: m.model_id, vram: m.vram_required_MB || 0 }))
        .sort((a, b) => a.vram - b.vram);
      const sel = $('#modelSel');
      sel.innerHTML = '';
      models.forEach(m => {
        const o = document.createElement('option');
        o.value = m.id;
        o.textContent = shortName(m.id) + (m.vram ? ' · ' + (m.vram / 1024).toFixed(1) + ' GB' : '');
        sel.appendChild(o);
      });
      const ids = models.map(m => m.id);
      const pick = ids.includes(cfg.model) ? cfg.model
        : ids.find(i => /Llama-3\.2-3B/.test(i)) || ids[0];
      if (pick) sel.value = pick;
      if (navigator.gpu) setStatus('Pick a model and choose Download and load. Models are cached after the first download.');
    } catch (e) {
      $('#modelSel').innerHTML = '<option>Unavailable</option>';
      setStatus('Couldn’t load the WebLLM library (' + e.message + '). Check your connection.', true);
    }
  }

  async function loadModel() {
    if (!webllm) { setStatus('The WebLLM library hasn’t loaded.', true); return; }
    if (!navigator.gpu) { setStatus('This browser has no WebGPU.', true); return; }
    const id = $('#modelSel').value;
    cfg.model = id;
    saveCfg();
    loading = true;
    $('#btnLoad').disabled = true;
    updateSend();
    const cb = p => {
      $('#bar').style.width = Math.round((p.progress || 0) * 100) + '%';
      setStatus(p.text || 'Loading…');
    };
    try {
      if (!engine) engine = await webllm.CreateMLCEngine(id, { initProgressCallback: cb });
      else { engine.setInitProgressCallback(cb); await engine.reload(id); }
      loadedId = id;
      $('#bar').style.width = '100%';
      setStatus('Ready: ' + shortName(id));
    } catch (e) {
      loadedId = '';
      setStatus('Couldn’t load that model: ' + e.message + ' Try a smaller one.', true);
    } finally {
      loading = false;
      $('#btnLoad').disabled = false;
      updateSend();
    }
  }

  function addMsg(role, text) {
    const empty = log.querySelector('.chat-empty');
    if (empty) empty.remove();
    const el = document.createElement('div');
    el.className = 'chat-msg ' + role;
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  async function send() {
    const p = $('#prompt');
    const text = p.value.trim();
    if (!text || busy) return;
    if (!loadedId || loading) { setStatus('Load a model first.', true); return; }
    p.value = '';
    busy = true;
    $('#btnSend').hidden = true;
    $('#btnStop').hidden = false;
    updateSend();

    history.push({ role: 'user', content: text });
    addMsg('user', text);
    const el = addMsg('ai', '');
    el.classList.add('live');
    let acc = '';

    try {
      const messages = [{ role: 'system', content: SYSTEM }].concat(history.slice(-12));
      const stream = await engine.chat.completions.create({ messages, stream: true, temperature: 0.7 });
      for await (const ch of stream) {
        const d = ch.choices[0] && ch.choices[0].delta && ch.choices[0].delta.content;
        if (d) { acc += d; el.textContent = acc; log.scrollTop = log.scrollHeight; }
      }
    } catch (e) {
      acc += (acc ? '\n\n' : '') + 'Error: ' + e.message;
      el.textContent = acc;
    }

    el.classList.remove('live');
    el.textContent = acc || '(no output)';
    history.push({ role: 'assistant', content: acc });
    busy = false;
    $('#btnSend').hidden = false;
    $('#btnStop').hidden = true;
    updateSend();
    log.scrollTop = log.scrollHeight;
  }

  $('#btnLoad').onclick = loadModel;
  $('#btnSend').onclick = send;
  $('#btnStop').onclick = () => { if (engine) engine.interruptGenerate(); };
  $('#btnClear').onclick = () => {
    history = [];
    log.innerHTML = '<p class="chat-empty">Chat cleared.</p>';
  };
  $('#prompt').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  $('#modelSel').onchange = e => { cfg.model = e.target.value; saveCfg(); };

  updateSend();
  init();
})();
