/*
 * ChatDesk website chat widget.
 * Embed with: <script src="https://YOUR-CHATDESK-SERVER/widget.js" data-key="WIDGET_KEY" async></script>
 */
(function () {
  'use strict';

  var script = document.currentScript;
  if (!script || window.__chatdeskLoaded) return;
  var key = script.getAttribute('data-key');
  if (!key) return console.warn('ChatDesk: missing data-key on the widget script tag');
  window.__chatdeskLoaded = true;

  var base = new URL(script.src).origin;
  var api = base + '/api/widget/' + encodeURIComponent(key);
  var storeKey = 'chatdesk:' + key;

  var state = { config: null, session: null, messages: [], open: false, stream: null };

  function loadSession() {
    try { return JSON.parse(localStorage.getItem(storeKey) || 'null'); } catch (e) { return null; }
  }
  function saveSession(s) {
    try {
      if (s) localStorage.setItem(storeKey, JSON.stringify(s));
      else localStorage.removeItem(storeKey);
    } catch (e) { /* storage blocked: chat still works for this page view */ }
  }

  function request(method, path, body) {
    var headers = { 'Content-Type': 'application/json' };
    if (state.session) headers['X-Visitor-Token'] = state.session.visitorToken;
    return fetch(api + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) {
            var err = new Error(data.error || 'Something went wrong. Please try again.');
            err.status = res.status;
            throw err;
          }
          return data;
        });
      });
  }

  // ---------- DOM ----------
  var host = document.createElement('div');
  host.style.cssText = 'position:fixed;z-index:2147483000;bottom:0;right:0;';
  var root = host.attachShadow({ mode: 'open' });
  root.innerHTML =
    '<style>' +
    ':host{all:initial}' +
    '*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}' +
    '.launcher{position:fixed;right:20px;bottom:20px;width:60px;height:60px;border-radius:50%;border:0;cursor:pointer;' +
    'background:var(--c);color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;transition:transform .15s}' +
    '.launcher:hover{transform:scale(1.06)}' +
    '.launcher svg{width:28px;height:28px}' +
    '.badge{position:absolute;top:-2px;right:-2px;min-width:20px;height:20px;border-radius:10px;background:#ef4444;color:#fff;font-size:12px;font-weight:700;display:none;align-items:center;justify-content:center;padding:0 5px}' +
    '.panel{position:fixed;right:20px;bottom:92px;width:370px;max-width:calc(100vw - 32px);height:540px;max-height:calc(100vh - 120px);' +
    'background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.25);display:none;flex-direction:column;overflow:hidden;color:#0f172a}' +
    '.panel.open{display:flex}' +
    '.head{background:var(--c);color:#fff;padding:18px 20px}' +
    '.head h2{margin:0;font-size:17px;font-weight:700}' +
    '.head p{margin:6px 0 0;font-size:13px;line-height:1.4;opacity:.92}' +
    '.body{flex:1;overflow-y:auto;padding:16px;background:#f8fafc}' +
    'form.start label{display:block;font-size:12px;font-weight:600;color:#475569;margin:0 0 4px}' +
    'form.start input,form.start textarea{width:100%;border:1px solid #cbd5e1;border-radius:8px;padding:10px;font-size:14px;margin:0 0 12px;background:#fff;color:#0f172a}' +
    'form.start textarea{resize:none;height:84px}' +
    'input:focus,textarea:focus{outline:2px solid var(--c);outline-offset:-1px}' +
    '.btn{width:100%;border:0;border-radius:8px;padding:11px;font-size:14px;font-weight:600;background:var(--c);color:#fff;cursor:pointer}' +
    '.btn:disabled{opacity:.6;cursor:default}' +
    '.consent{font-size:11px;color:#64748b;margin:10px 0 0;line-height:1.4}' +
    '.error{color:#b91c1c;font-size:13px;margin:0 0 10px}' +
    '.msg{max-width:80%;padding:9px 12px;border-radius:14px;font-size:14px;line-height:1.4;margin:0 0 8px;white-space:pre-wrap;word-wrap:break-word}' +
    '.msg.in{margin-left:auto;background:var(--c);color:#fff;border-bottom-right-radius:4px}' +
    '.msg.out{background:#fff;border:1px solid #e2e8f0;border-bottom-left-radius:4px}' +
    '.time{font-size:10px;opacity:.65;margin-top:3px}' +
    '.note{text-align:center;font-size:12px;color:#64748b;margin:4px 0 12px}' +
    '.composer{display:flex;gap:8px;padding:10px;border-top:1px solid #e2e8f0;background:#fff}' +
    '.composer textarea{flex:1;resize:none;border:1px solid #cbd5e1;border-radius:8px;padding:9px;font-size:14px;height:40px;max-height:100px;color:#0f172a}' +
    '.composer button{border:0;border-radius:8px;background:var(--c);color:#fff;padding:0 14px;font-weight:600;cursor:pointer}' +
    '.composer.hidden{display:none}' +
    '</style>' +
    '<div class="panel" role="dialog" aria-label="Chat with us">' +
    '  <div class="head"><h2></h2><p></p></div>' +
    '  <div class="body"></div>' +
    '  <form class="composer hidden"><textarea placeholder="Type a message…" aria-label="Message" maxlength="2000"></textarea><button type="submit">Send</button></form>' +
    '</div>' +
    '<button class="launcher" type="button" aria-label="Open chat">' +
    '  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' +
    '  <span class="badge"></span>' +
    '</button>';

  var panel = root.querySelector('.panel');
  var launcher = root.querySelector('.launcher');
  var bodyEl = root.querySelector('.body');
  var composer = root.querySelector('.composer');
  var composerInput = composer.querySelector('textarea');
  var unseen = 0;

  var CHAT_ICON = launcher.innerHTML;
  var CLOSE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg><span class="badge"></span>';

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function setBadge(n) {
    unseen = n;
    var b = root.querySelector('.badge');
    b.textContent = n > 9 ? '9+' : String(n);
    b.style.display = n > 0 ? 'flex' : 'none';
  }

  function toggle(open) {
    state.open = open;
    panel.classList.toggle('open', open);
    launcher.innerHTML = open ? CLOSE_ICON : CHAT_ICON;
    launcher.setAttribute('aria-label', open ? 'Close chat' : 'Open chat');
    setBadge(open ? 0 : unseen);
    if (open) {
      var focusable = root.querySelector('form.start input') || (state.session && composerInput);
      if (focusable) setTimeout(function () { focusable.focus(); }, 50);
      bodyEl.scrollTop = bodyEl.scrollHeight;
    }
  }
  launcher.addEventListener('click', function () { toggle(!state.open); });

  // ---------- Views ----------
  function renderStartForm() {
    composer.classList.add('hidden');
    bodyEl.innerHTML = '';
    var form = el('form', 'start');
    var error = el('p', 'error');
    error.style.display = 'none';
    form.appendChild(error);

    function field(label, name, type, attrs) {
      var id = 'cd-' + name;
      var l = el('label', null, label);
      l.setAttribute('for', id);
      var input = el(type === 'textarea' ? 'textarea' : 'input');
      if (type !== 'textarea') input.type = type;
      input.id = id;
      input.name = name;
      input.required = true;
      for (var k in attrs) input.setAttribute(k, attrs[k]);
      form.appendChild(l);
      form.appendChild(input);
    }
    field('Name', 'name', 'text', { autocomplete: 'name', maxlength: '100' });
    field('Mobile number', 'phone', 'tel', { autocomplete: 'tel', inputmode: 'tel' });
    field('Message', 'message', 'textarea', { maxlength: '2000' });

    var btn = el('button', 'btn', 'Send');
    btn.type = 'submit';
    form.appendChild(btn);
    form.appendChild(el('p', 'consent',
      'By sending, you agree that ' + state.config.name + ' may reply to you here or by text message. Message and data rates may apply.'));

    // form.name is the form's own name attribute, so look fields up explicitly.
    function value(name) { return form.querySelector('[name="' + name + '"]').value; }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      btn.disabled = true;
      error.style.display = 'none';
      request('POST', '/conversations', {
        name: value('name'),
        phone: value('phone'),
        message: value('message'),
        pageUrl: location.href,
      }).then(function (data) {
        state.session = { conversationId: data.conversationId, visitorToken: data.visitorToken };
        saveSession(state.session);
        state.messages = data.messages;
        renderThread();
        connect();
      }).catch(function (err) {
        error.textContent = err.message;
        error.style.display = 'block';
        btn.disabled = false;
      });
    });
    bodyEl.appendChild(form);
  }

  function formatTime(iso) {
    try { return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; }
  }

  function renderThread() {
    composer.classList.remove('hidden');
    bodyEl.innerHTML = '';
    bodyEl.appendChild(el('p', 'note', 'We’ll reply here. If you leave, we can text you back.'));
    state.messages.forEach(appendMessageEl);
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  function appendMessageEl(m) {
    var bubble = el('div', 'msg ' + m.direction, m.body);
    bubble.appendChild(el('div', 'time', formatTime(m.created_at)));
    bodyEl.appendChild(bubble);
  }

  function addMessage(m) {
    for (var i = 0; i < state.messages.length; i++) if (state.messages[i].id === m.id) return;
    state.messages.push(m);
    appendMessageEl(m);
    bodyEl.scrollTop = bodyEl.scrollHeight;
    if (m.direction === 'out' && !state.open) setBadge(unseen + 1);
  }

  composer.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = composerInput.value.trim();
    if (!text || !state.session) return;
    composerInput.value = '';
    request('POST', '/conversations/' + state.session.conversationId + '/messages', { body: text })
      .then(function (data) { addMessage(data.message); })
      .catch(function (err) {
        if (err.status === 404) return reset();
        composerInput.value = text;
        alert(err.message);
      });
  });
  composerInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      composer.requestSubmit ? composer.requestSubmit() : composer.dispatchEvent(new Event('submit', { cancelable: true }));
    }
  });

  // ---------- Live updates ----------
  function connect() {
    if (!state.session || !window.EventSource) return;
    if (state.stream) state.stream.close();
    var url = api + '/conversations/' + state.session.conversationId + '/stream?token=' + encodeURIComponent(state.session.visitorToken);
    state.stream = new EventSource(url);
    state.stream.onmessage = function (e) {
      try {
        var data = JSON.parse(e.data);
        if (data.type === 'message') addMessage(data.message);
      } catch (err) { /* ignore malformed event */ }
    };
  }

  function reset() {
    if (state.stream) state.stream.close();
    state.stream = null;
    state.session = null;
    state.messages = [];
    saveSession(null);
    renderStartForm();
  }

  // ---------- Boot ----------
  request('GET', '/config').then(function (config) {
    state.config = config;
    host.style.setProperty('--c', /^#[0-9a-f]{6}$/i.test(config.color) ? config.color : '#2563eb');
    root.querySelector('.head h2').textContent = config.name;
    root.querySelector('.head p').textContent = config.greeting;
    document.body.appendChild(host);

    state.session = loadSession();
    if (!state.session) return renderStartForm();
    request('GET', '/conversations/' + state.session.conversationId + '/messages')
      .then(function (data) {
        state.messages = data.messages;
        renderThread();
        connect();
      })
      .catch(function () { reset(); });
  }).catch(function (err) {
    console.warn('ChatDesk: could not load widget -', err.message);
  });
})();
