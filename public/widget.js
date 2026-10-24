/*
 * ChatBird website chat widget.
 * Embed with: <script src="https://YOUR-CHATDESK-SERVER/widget.js" data-key="WIDGET_KEY" async></script>
 * Optional, to override the position set in ChatBird for one site:
 *   data-position="left|right" data-offset-x="20" data-offset-y="20" (pixels from the side and bottom)
 */
(function () {
  'use strict';

  var script = document.currentScript;
  if (!script || window.__chatdeskLoaded) return;
  var key = script.getAttribute('data-key');
  if (!key) return console.warn('ChatBird: missing data-key on the widget script tag');
  window.__chatdeskLoaded = true;

  var base = new URL(script.src).origin;
  var api = base + '/api/widget/' + encodeURIComponent(key);
  var storeKey = 'chatdesk:' + key;

  var state = { config: null, session: null, messages: [], open: false, stream: null, view: null };

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
    '.launcher{position:fixed;width:60px;height:60px;border-radius:50%;border:0;cursor:pointer;' +
    'background:var(--c);color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;transition:transform .15s}' +
    '.launcher:hover{transform:scale(1.06)}' +
    '.launcher svg{width:28px;height:28px}' +
    '.badge{position:absolute;top:-2px;right:-2px;min-width:20px;height:20px;border-radius:10px;background:#ef4444;color:#fff;font-size:12px;font-weight:700;display:none;align-items:center;justify-content:center;padding:0 5px}' +
    '.panel{position:fixed;width:370px;max-width:calc(100vw - 32px);height:540px;max-height:calc(100vh - 120px);' +
    'background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.25);display:none;flex-direction:column;overflow:hidden;color:#0f172a}' +
    '.panel.open{display:flex}' +
    '.head{background:var(--c);color:#fff;padding:18px 20px}' +
    '.head h2{margin:0;font-size:17px;font-weight:700}' +
    '.head p{margin:6px 0 0;font-size:13px;line-height:1.4;opacity:.92}' +
    '.head .away{display:none;margin-top:10px;font-size:12px;background:rgba(0,0,0,.18);border-radius:6px;padding:6px 8px;opacity:1}' +
    '.body{flex:1;overflow-y:auto;padding:16px;background:#f8fafc}' +
    'form.start label{display:block;font-size:12px;font-weight:600;color:#475569;margin:0 0 4px}' +
    'form.start label .opt{font-weight:400;color:#94a3b8}' +
    'form.start input,form.start textarea,form.start select{width:100%;border:1px solid #cbd5e1;border-radius:8px;padding:10px;font-size:14px;margin:0 0 12px;background:#fff;color:#0f172a}' +
    'form.start textarea{resize:none;height:84px}' +
    'form.start h3{margin:0 0 12px;font-size:15px}' +
    '.back{border:0;background:none;color:#475569;font-size:13px;padding:0;margin:0 0 10px;cursor:pointer}' +
    '.menu{display:flex;flex-direction:column;gap:10px}' +
    '.option{display:flex;align-items:center;gap:12px;width:100%;text-align:left;border:1px solid #e2e8f0;border-radius:12px;background:#fff;padding:14px;cursor:pointer;color:#0f172a;text-decoration:none;font-size:14px}' +
    '.option:hover{border-color:var(--c)}' +
    '.option .ic{width:38px;height:38px;flex:none;border-radius:10px;background:var(--c);color:#fff;display:flex;align-items:center;justify-content:center;font-size:18px}' +
    '.option b{display:block;font-size:14px}' +
    '.option small{display:block;color:#64748b;font-size:12px;margin-top:2px}' +
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
    // Quick buttons above the closed chat button.
    '.quick{position:fixed;display:flex;flex-direction:column;gap:8px;opacity:0;transform:translateY(8px);transition:opacity .25s,transform .25s;pointer-events:none}' +
    '.quick.show{opacity:1;transform:none;pointer-events:auto}' +
    '.quick.right{align-items:flex-end}.quick.left{align-items:flex-start}' +
    '.pill{display:flex;align-items:center;gap:8px;border:0;border-radius:999px;background:#fff;color:#0f172a;padding:8px 16px 8px 8px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.18);white-space:nowrap;transition:transform .15s}' +
    '.pill:hover{transform:translateY(-1px);box-shadow:0 6px 20px rgba(0,0,0,.22)}' +
    '.pill .ic{width:28px;height:28px;border-radius:50%;background:var(--c);color:#fff;display:flex;align-items:center;justify-content:center;flex:none}' +
    '.quick .x{width:24px;height:24px;border-radius:50%;border:0;background:#fff;color:#64748b;font-size:15px;line-height:1;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.18);padding:0}' +
    '@media (max-width:480px){.pill{font-size:13px;padding:6px 13px 6px 6px}.pill .ic{width:24px;height:24px}}' +
    '</style>' +
    '<div class="panel" role="dialog" aria-label="Chat with us">' +
    '  <div class="head"><h2></h2><p class="greeting"></p><p class="away">We’re away right now. Leave a message and we’ll get back to you when we open.</p></div>' +
    '  <div class="body"></div>' +
    '  <form class="composer hidden"><textarea placeholder="Type a message…" aria-label="Message" maxlength="2000"></textarea><button type="submit">Send</button></form>' +
    '</div>' +
    '<div class="quick" role="group" aria-label="Contact options"></div>' +
    '<button class="launcher" type="button" aria-label="Open chat">' +
    '  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' +
    '  <span class="badge"></span>' +
    '</button>';

  var panel = root.querySelector('.panel');
  var launcher = root.querySelector('.launcher');
  var bodyEl = root.querySelector('.body');
  var composer = root.querySelector('.composer');
  var composerInput = composer.querySelector('textarea');
  var quick = root.querySelector('.quick');
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
    if (state.config && hasMenu()) {
      // Closing goes back to the menu, where "Continue your conversation" keeps their chat. A reply that
      // came in while it was closed opens straight on the chat.
      if (open && unseen > 0 && state.session) renderThread();
      else if (!open && state.view !== 'menu') renderMenu();
    }
    state.open = open;
    showQuick(!open);
    panel.classList.toggle('open', open);
    launcher.innerHTML = open ? CLOSE_ICON : CHAT_ICON;
    launcher.setAttribute('aria-label', open ? 'Close chat' : 'Open chat');
    setBadge(open ? 0 : unseen);
    if (open) {
      var focusable = root.querySelector('form.start input') || (state.session && composerInput) || root.querySelector('.option');
      if (focusable) setTimeout(function () { focusable.focus(); }, 50);
      bodyEl.scrollTop = bodyEl.scrollHeight;
    }
  }
  launcher.addEventListener('click', function () { toggle(!state.open); });

  // ---------- Quick buttons ----------
  // "Chat with us", "Get a quote", "Request a call back" above the closed button, each opening
  // straight to that form. Closing them with × hides them for the rest of the visit.
  var quickKey = storeKey + ':quick-closed';
  var svg = function (d) {
    return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
  };
  var QUICK_ICONS = {
    chat: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
    quote: svg('<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.2"/>'),
    callback: svg('<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>'),
  };
  function quickClosed() {
    try { return sessionStorage.getItem(quickKey) === '1'; } catch (e) { return false; }
  }
  function showQuick(on) {
    quick.classList.toggle('show', Boolean(on && quick.childNodes.length && !quickClosed()));
  }
  function buildQuick() {
    quick.innerHTML = '';
    if (!state.config.buttons) return;
    var o = state.config.options || {};
    var items = [['chat', QUICK_ICONS.chat, state.session ? 'Continue your chat' : 'Chat with us']];
    if (o.quote) items.push(['quote', QUICK_ICONS.quote, 'Get a quote']);
    if (o.callback) items.push(['callback', QUICK_ICONS.callback, 'Request a call back']);
    var close = el('button', 'x', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Hide these buttons');
    close.addEventListener('click', function () {
      try { sessionStorage.setItem(quickKey, '1'); } catch (e) { /* hides for this page view only */ }
      showQuick(false);
    });
    quick.appendChild(close);
    items.forEach(function (item) {
      var b = el('button', 'pill');
      b.type = 'button';
      var ic = el('span', 'ic');
      ic.innerHTML = item[1];
      b.appendChild(ic);
      b.appendChild(document.createTextNode(item[2]));
      b.addEventListener('click', function () { openTo(item[0]); });
      quick.appendChild(b);
    });
  }
  function openTo(kind) {
    if (kind === 'chat') {
      if (state.session) renderThread();
      else renderForm('chat');
    } else {
      renderForm(kind);
    }
    toggle(true);
  }

  // ---------- Views ----------
  var FORMS = {
    chat: {
      title: 'Chat with us',
      submit: 'Send',
      path: '/conversations',
      fields: [
        ['Name', 'name', 'text', { autocomplete: 'name', maxlength: '100' }],
        ['Mobile number', 'phone', 'tel', { autocomplete: 'tel', inputmode: 'tel' }],
        ['Message', 'message', 'textarea', { maxlength: '2000' }],
      ],
    },
    quote: {
      title: 'Get a quote',
      submit: 'Get my quote',
      path: '/requests',
      fields: [
        ['Name', 'name', 'text', { autocomplete: 'name', maxlength: '100' }],
        ['Mobile number', 'phone', 'tel', { autocomplete: 'tel', inputmode: 'tel' }],
        ['Email', 'email', 'email', { autocomplete: 'email', maxlength: '200', optional: true }],
        ['Device / model', 'device', 'text', { maxlength: '120', placeholder: 'e.g. iPhone 13, Galaxy S22' }],
        ['What needs fixing?', 'issue', 'textarea', { maxlength: '2000', placeholder: 'e.g. cracked screen, battery drains fast' }],
      ],
    },
    callback: {
      title: 'Request a call back',
      submit: 'Call me back',
      path: '/requests',
      fields: [
        ['Name', 'name', 'text', { autocomplete: 'name', maxlength: '100' }],
        ['Mobile number', 'phone', 'tel', { autocomplete: 'tel', inputmode: 'tel' }],
        ['Best time to call', 'time', 'select', { choices: ['As soon as possible', 'Morning', 'Afternoon', 'Evening'] }],
        ['What is it about?', 'note', 'textarea', { maxlength: '2000', optional: true }],
      ],
    },
  };

  function hasMenu() {
    var o = state.config.options || {};
    return Boolean(o.quote || o.callback || o.callNumber);
  }

  function option(icon, title, text) {
    var b = el('button', 'option');
    b.type = 'button';
    var ic = el('span', 'ic', icon);
    var label = el('span');
    label.appendChild(el('b', null, title));
    label.appendChild(el('small', null, text));
    b.appendChild(ic);
    b.appendChild(label);
    return b;
  }

  function renderMenu() {
    state.view = 'menu';
    composer.classList.add('hidden');
    bodyEl.innerHTML = '';
    var o = state.config.options || {};
    var menu = el('div', 'menu');
    // Someone who already wrote to us can go back to that conversation, or start something new.
    if (state.session) {
      var last = state.messages[state.messages.length - 1];
      var cont = option('💬', 'Continue your conversation', last ? last.body.replace(/\s+/g, ' ').slice(0, 60) : 'See our replies');
      cont.addEventListener('click', function () { renderThread(); });
      menu.appendChild(cont);
    }
    var items = state.session ? [] : [['chat', '💬', 'Chat with us', 'Send a message, we’ll reply here or by text']];
    if (o.quote) items.push(['quote', '📋', 'Get a quote', 'Tell us the device and what’s wrong']);
    if (o.callback) items.push(['callback', '📞', 'Request a call back', 'We’ll ring you at a time that suits']);
    items.forEach(function (item) {
      var b = option(item[1], item[2], item[3]);
      b.addEventListener('click', function () { renderForm(item[0]); });
      menu.appendChild(b);
    });
    if (o.callNumber) {
      var call = option('☎️', 'Call us now', o.callNumber);
      var a = el('a', 'option');
      a.href = 'tel:' + o.callNumber.replace(/[^\d+]/g, '');
      while (call.firstChild) a.appendChild(call.firstChild);
      menu.appendChild(a);
    }
    bodyEl.appendChild(menu);
  }

  function renderForm(kind) {
    var spec = FORMS[kind];
    state.view = 'form';
    composer.classList.add('hidden');
    bodyEl.innerHTML = '';
    var form = el('form', 'start');
    if (hasMenu()) {
      var back = el('button', 'back', '← Back');
      back.type = 'button';
      back.addEventListener('click', renderMenu);
      form.appendChild(back);
      form.appendChild(el('h3', null, spec.title));
    }
    var error = el('p', 'error');
    error.style.display = 'none';
    form.appendChild(error);

    spec.fields.forEach(function (f) {
      var label = f[0], name = f[1], type = f[2], attrs = f[3] || {};
      var id = 'cd-' + kind + '-' + name;
      var l = el('label', null, label);
      if (attrs.optional) l.appendChild(el('span', 'opt', ' (optional)'));
      l.setAttribute('for', id);
      var input;
      if (type === 'select') {
        input = el('select');
        attrs.choices.forEach(function (c) { var opt = el('option', null, c); opt.value = c; input.appendChild(opt); });
      } else {
        input = el(type === 'textarea' ? 'textarea' : 'input');
        if (type !== 'textarea') input.type = type;
        input.required = !attrs.optional;
      }
      input.id = id;
      input.name = name;
      for (var k in attrs) if (k !== 'optional' && k !== 'choices') input.setAttribute(k, attrs[k]);
      form.appendChild(l);
      form.appendChild(input);
    });

    var btn = el('button', 'btn', spec.submit);
    btn.type = 'submit';
    form.appendChild(btn);
    form.appendChild(el('p', 'consent',
      'By sending, you agree that ' + state.config.name + ' may reply to you here or by text message. Message and data rates may apply.'));

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      btn.disabled = true;
      error.style.display = 'none';
      var payload = { pageUrl: location.href };
      if (kind !== 'chat') payload.type = kind;
      // form.name is the form's own name attribute, so read fields by their elements.
      spec.fields.forEach(function (f) { payload[f[1]] = form.querySelector('[name="' + f[1] + '"]').value; });
      request('POST', spec.path, payload).then(function (data) {
        state.session = { conversationId: data.conversationId, visitorToken: data.visitorToken };
        saveSession(state.session);
        buildQuick();
        state.messages = data.messages;
        renderThread(kind);
        connect();
      }).catch(function (err) {
        error.textContent = err.message;
        error.style.display = 'block';
        btn.disabled = false;
      });
    });
    bodyEl.appendChild(form);
    var first = form.querySelector('input');
    if (first && state.open) setTimeout(function () { first.focus(); }, 50);
  }

  function renderStart() {
    if (hasMenu()) renderMenu();
    else renderForm('chat');
  }

  function formatTime(iso) {
    try { return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; }
  }

  var THANKS = {
    quote: 'Thanks! We’ll send your quote here or by text shortly.',
    callback: 'Thanks! We’ll call you back. You can also chat with us here.',
  };

  function renderThread(kind) {
    state.view = 'thread';
    composer.classList.remove('hidden');
    bodyEl.innerHTML = '';
    if (hasMenu()) {
      // Back to the menu: get a quote, ask for a call back or call us, without losing this chat.
      var back = el('button', 'back', '← Menu');
      back.type = 'button';
      back.addEventListener('click', renderMenu);
      bodyEl.appendChild(back);
    }
    bodyEl.appendChild(el('p', 'note', THANKS[kind] || 'We’ll reply here. If you leave, we can text you back.'));
    if (state.open) setBadge(0);
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
    if (state.view === 'thread') {
      appendMessageEl(m);
      bodyEl.scrollTop = bodyEl.scrollHeight;
    }
    // A reply while they're looking elsewhere (closed, or on the menu) shows on the badge.
    if (m.direction === 'out' && (!state.open || state.view !== 'thread')) setBadge(unseen + 1);
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
    buildQuick();
    renderStart();
  }

  // ---------- Placement ----------
  // Set in ChatBird, or per site with data-position / data-offset-x / data-offset-y on the script tag.
  function px(value, fallback) {
    var n = parseInt(value, 10);
    return isFinite(n) && n >= 0 && n <= 400 ? n : fallback;
  }
  function place(config) {
    var side = script.getAttribute('data-position') || config.position;
    if (side !== 'left') side = 'right';
    var x = px(script.getAttribute('data-offset-x'), px(config.offsetX, 20));
    var y = px(script.getAttribute('data-offset-y'), px(config.offsetY, 20));
    var other = side === 'left' ? 'right' : 'left';
    host.style[other] = 'auto';
    host.style[side] = '0';
    launcher.style[side] = x + 'px';
    launcher.style.bottom = y + 'px';
    // Keep the panel on screen on phones even with a large side gap.
    panel.style[side] = Math.min(x, 16) + 'px';
    if (window.innerWidth > 480) panel.style[side] = x + 'px';
    panel.style.bottom = (y + 72) + 'px';
    quick.classList.add(side);
    quick.style[side] = x + 'px';
    quick.style.bottom = (y + 72) + 'px';
    panel.style.maxHeight = 'calc(100vh - ' + (y + 100) + 'px)';
  }

  // ---------- Boot ----------
  request('GET', '/config').then(function (config) {
    state.config = config;
    host.style.setProperty('--c', /^#[0-9a-f]{6}$/i.test(config.color) ? config.color : '#087565');
    root.querySelector('.head h2').textContent = config.name;
    root.querySelector('.head .greeting').textContent = config.greeting;
    if (config.open === false) root.querySelector('.head .away').style.display = 'block';
    place(config);
    document.body.appendChild(host);

    state.session = loadSession();
    buildQuick();
    setTimeout(function () { showQuick(!state.open); }, 1200);
    if (!state.session) return renderStart();
    request('GET', '/conversations/' + state.session.conversationId + '/messages')
      .then(function (data) {
        state.messages = data.messages;
        // With a menu they start there; "Continue your conversation" is at the top.
        if (hasMenu()) renderMenu();
        else renderThread();
        connect();
      })
      .catch(function () { reset(); });
  }).catch(function (err) {
    console.warn('ChatBird: could not load widget -', err.message);
  });
})();
