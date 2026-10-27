(() => {
  'use strict';

  const $ = s => document.querySelector(s);
  // Tried in order: if one CDN fails, the next is used.
  const WEBLLM_URLS = [
    'https://esm.run/@mlc-ai/web-llm@0.2.79',
    'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.79/+esm'
  ];
  const KEY = 'cai.chat.v1';
  const SYSTEM = 'You are a friendly, helpful assistant. Answer clearly and concisely.';
  const MAX_FILE_BYTES = 20 * 1024 * 1024; // refuse files bigger than this
  const MAX_IMG_SIDE = 1024;               // images are shrunk before sending
  const PDF_IMG_PAGES = 4;                 // scanned PDFs: pages rendered as images
  const PDFJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
  const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const TEXT_RE = /\.(txt|md|json|csv|js|ts|jsx|tsx|html|css|py|xml|yaml|yml|log|sh|c|cpp|java|go|rs)$/i;

  let cfg = {};
  try { cfg = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { cfg = {}; }
  const saveCfg = () => { try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) { /* ignore */ } };

  let webllm = null;
  let engine = null;
  let loadedId = '';
  let ctxWindow = 4096;  // tokens, from the loaded model's config
  let loading = false;
  let busy = false;
  let history = [];   // text-only history; images are sent only with the turn they're attached to
  let pending = [];   // attachments waiting to be sent: {kind:'image'|'text', name, url?, text?}

  const log = $('#log');
  const shortName = id => id.replace(/-MLC$/, '');
  const isVision = id => /vision|-VL|VL-|\bVL\b/i.test(id || '');

  // Characters of file text that fit alongside the chat (about 3 chars per token, minus room for the reply).
  const textBudget = () => Math.max(2000, ctxWindow * 3 - 3000);

  let pdfjsPromise = null;
  function loadPdfJs() {
    if (!pdfjsPromise) {
      pdfjsPromise = new Promise((resolve, reject) => {
        if (window.pdfjsLib) return resolve(window.pdfjsLib);
        const sc = document.createElement('script');
        sc.src = PDFJS_URL;
        sc.onload = () => {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
          resolve(window.pdfjsLib);
        };
        sc.onerror = () => reject(new Error('couldn’t load the PDF reader'));
        document.head.appendChild(sc);
      });
    }
    return pdfjsPromise;
  }

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
      let lastErr = null;
      for (const url of WEBLLM_URLS) {
        try { webllm = await import(url); break; } catch (e) { lastErr = e; }
      }
      if (!webllm) throw lastErr || new Error('no CDN answered');
      const models = webllm.prebuiltAppConfig.model_list
        .filter(m => !m.model_type && !/coder/i.test(m.model_id))
        .map(m => ({ id: m.model_id, vram: m.vram_required_MB || 0 }))
        .sort((a, b) => a.vram - b.vram);
      const sel = $('#modelSel');
      sel.innerHTML = '';
      models.forEach(m => {
        const o = document.createElement('option');
        o.value = m.id;
        o.textContent = (isVision(m.id) ? '👁 ' : '') + shortName(m.id) + (m.vram ? ' · ' + (m.vram / 1024).toFixed(1) + ' GB' : '');
        sel.appendChild(o);
      });
      const ids = models.map(m => m.id);
      const pick = ids.includes(cfg.model) ? cfg.model
        : ids.find(i => /Llama-3\.2-3B/.test(i)) || ids[0];
      if (pick) sel.value = pick;
      if (navigator.gpu) setStatus('Pick a model and choose Download and load. 👁 models can read images.');
    } catch (e) {
      $('#modelSel').innerHTML = '<option>Unavailable</option>';
      setStatus('Couldn’t load the WebLLM library: ' + e.message + '. If this page was opened from the Files app, try opening it from its web address instead.', true);
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
      const info = webllm.prebuiltAppConfig.model_list.find(m => m.model_id === id);
      ctxWindow = (info && info.overrides && info.overrides.context_window_size) || 4096;
      $('#bar').style.width = '100%';
      setStatus('Ready: ' + shortName(id) + (isVision(id) ? ' (can read images)' : ' (text only)'));
    } catch (e) {
      loadedId = '';
      setStatus('Couldn’t load that model: ' + e.message + ' Try a smaller one.', true);
    } finally {
      loading = false;
      $('#btnLoad').disabled = false;
      updateSend();
    }
  }

  // ---------- attachments ----------

  // Scales an image source down and returns a JPEG data URL.
  function toDataUrl(source, w, h) {
    const scale = Math.min(1, MAX_IMG_SIDE / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * scale));
    c.height = Math.max(1, Math.round(h * scale));
    c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.85);
  }

  function imageFromFile(file) {
    return new Promise((resolve, reject) => {
      const u = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try { resolve(toDataUrl(img, img.naturalWidth, img.naturalHeight)); }
        catch (e) { reject(e); }
        finally { URL.revokeObjectURL(u); }
      };
      img.onerror = () => { URL.revokeObjectURL(u); reject(new Error('unreadable image')); };
      img.src = u;
    });
  }

  // Reads a PDF: extracts its text, and renders pages as images when there is no text (scanned PDFs).
  async function readPdf(f) {
    const lib = await loadPdfJs();
    const doc = await lib.getDocument({ data: await f.arrayBuffer() }).promise;
    const parts = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      const t = tc.items.map(it => it.str).join(' ').trim();
      if (t) parts.push('[Page ' + i + ']\n' + t);
    }
    const text = parts.join('\n\n');
    let scanImages = [];
    if (text.trim().length < 50) {
      const n = Math.min(doc.numPages, PDF_IMG_PAGES);
      for (let i = 1; i <= n; i++) {
        const page = await doc.getPage(i);
        const vp = page.getViewport({ scale: 1.5 });
        const c = document.createElement('canvas');
        c.width = vp.width;
        c.height = vp.height;
        await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        scanImages.push(toDataUrl(c, c.width, c.height));
      }
    }
    return { text, scanImages, pages: doc.numPages };
  }

  async function addFiles(files) {
    const skipped = [];
    for (const f of files) {
      try {
        if (f.size > MAX_FILE_BYTES) { skipped.push(f.name + ' (over 20 MB)'); continue; }
        if (f.type.startsWith('image/')) {
          pending.push({ kind: 'image', name: f.name, url: await imageFromFile(f) });
        } else if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') {
          const r = await readPdf(f);
          const name = f.name + ' (' + r.pages + ' pages)';
          if (r.text.trim()) pending.push({ kind: 'text', name, text: r.text });
          else pending.push({ kind: 'text', name, text: '', scanImages: r.scanImages });
        } else if (TEXT_RE.test(f.name) || f.type.startsWith('text/')) {
          pending.push({ kind: 'text', name: f.name, text: await f.text() });
        } else {
          skipped.push(f.name + ' (type not supported)');
        }
      } catch (e) {
        skipped.push(f.name + ' (' + e.message + ')');
      }
    }
    renderTray();
    if (skipped.length) setStatus('Skipped: ' + skipped.join(', '), true);
  }

  async function shareScreen() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      setStatus('Screen sharing isn’t supported in this browser.', true);
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch (e) {
      setStatus('Screen share cancelled or blocked.', true);
      return;
    }
    try {
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.srcObject = stream;
      await v.play();
      await new Promise(r => setTimeout(r, 300)); // let the first frame arrive
      const url = toDataUrl(v, v.videoWidth, v.videoHeight);
      pending.push({ kind: 'image', name: 'screenshot.jpg', url });
      renderTray();
      setStatus('Screenshot added. Send it with a question.');
    } catch (e) {
      setStatus('Couldn’t capture the screen: ' + e.message, true);
    } finally {
      stream.getTracks().forEach(t => t.stop());
    }
  }

  function renderTray() {
    const tray = $('#tray');
    tray.innerHTML = '';
    pending.forEach((a, i) => {
      const chip = document.createElement('div');
      chip.className = 'chat-chip';
      if (a.kind === 'image') {
        const img = document.createElement('img');
        img.src = a.url;
        img.alt = a.name;
        chip.appendChild(img);
      }
      const label = document.createElement('span');
      label.textContent = a.name;
      chip.appendChild(label);
      const x = document.createElement('button');
      x.textContent = '×';
      x.title = 'Remove';
      x.onclick = () => { pending.splice(i, 1); renderTray(); };
      chip.appendChild(x);
      tray.appendChild(chip);
    });
    tray.hidden = pending.length === 0;
  }

  // ---------- chat ----------

  function addMsg(role, text, images) {
    const empty = log.querySelector('.chat-empty');
    if (empty) empty.remove();
    const el = document.createElement('div');
    el.className = 'chat-msg ' + role;
    el.textContent = text;
    (images || []).forEach(src => {
      const img = document.createElement('img');
      img.src = src;
      img.alt = 'attached image';
      el.appendChild(img);
    });
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  async function send() {
    const p = $('#prompt');
    const typed = p.value.trim();
    if (busy) return;
    if (!typed && pending.length === 0) return;
    if (!loadedId || loading) { setStatus('Load a model first.', true); return; }

    const images = pending.filter(a => a.kind === 'image');
    if (images.length && !isVision(loadedId)) {
      setStatus('This model is text only. Pick a 👁 model and load it to send images.', true);
      return;
    }

    // Scanned PDFs contribute page images, which need a vision model.
    const scanPages = pending.filter(a => a.kind === 'text' && a.scanImages).flatMap(a => a.scanImages);
    if (scanPages.length && !isVision(loadedId)) {
      setStatus('A scanned PDF needs a 👁 model to read its pages. Load one, or attach a text PDF.', true);
      return;
    }

    // Fit text files into the model's context window.
    const textFiles = pending.filter(a => a.kind === 'text' && a.text);
    let budget = textBudget();
    const notes = [];
    const fileBlock = textFiles.map(a => {
      let body = a.text;
      if (body.length > budget) {
        body = body.slice(0, Math.max(0, budget)) + '\n[…cut off: the model’s context window is ' + ctxWindow + ' tokens]';
        notes.push(a.name);
      }
      budget = Math.max(0, budget - body.length);
      return 'File: ' + a.name + '\n```\n' + body + '\n```';
    }).join('\n\n');
    const userText = [fileBlock, typed].filter(Boolean).join('\n\n');
    const imageUrls = images.map(a => a.url).concat(scanPages);
    const content = imageUrls.length
      ? imageUrls.map(url => ({ type: 'image_url', image_url: { url } }))
          .concat([{ type: 'text', text: userText || 'Describe this image.' }])
      : userText;

    pending = [];
    renderTray();
    p.value = '';
    busy = true;
    $('#btnSend').hidden = true;
    $('#btnStop').hidden = false;
    updateSend();

    if (notes.length) setStatus('Trimmed to fit the model: ' + notes.join(', '), true);
    addMsg('user', typed || (fileBlock ? '(file attached)' : ''), imageUrls);
    history.push({ role: 'user', content: userText || '[image]' });
    const el = addMsg('ai', '');
    el.classList.add('live');
    let acc = '';

    try {
      const past = history.slice(0, -1).slice(-12).map(m => ({ role: m.role, content: m.content }));
      const messages = [{ role: 'system', content: SYSTEM }].concat(past, [{ role: 'user', content }]);
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
    pending = [];
    renderTray();
    log.innerHTML = '<p class="chat-empty">Chat cleared.</p>';
  };
  $('#btnAttach').onclick = () => $('#fileIn').click();
  $('#fileIn').addEventListener('change', e => {
    addFiles(Array.from(e.target.files || []));
    e.target.value = '';
  });
  $('#btnShot').onclick = shareScreen;
  $('#prompt').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  $('#modelSel').onchange = e => { cfg.model = e.target.value; saveCfg(); };

  updateSend();
  init();
})();
