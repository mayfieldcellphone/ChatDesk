/*
 * ChatBird reviews widget: your Google rating and recent reviews, for your own website.
 * Embed with: <script src="https://YOUR-CHATDESK-SERVER/reviews.js" data-key="WIDGET_KEY" async></script>
 * It appears where the script tag is, or inside <div id="chatbird-reviews"></div> if the page has one.
 * Which reviews it shows is set in ChatBird under Reviews → Reviews on your website.
 */
(function () {
  'use strict';

  var script = document.currentScript;
  if (!script) return;
  var key = script.getAttribute('data-key');
  if (!key) return console.warn('ChatBird reviews: missing data-key on the script tag');
  var base = new URL(script.src).origin;

  var host = document.getElementById('chatbird-reviews');
  if (!host) {
    host = document.createElement('div');
    script.parentNode.insertBefore(host, script);
  }
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  var STAR = 'M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6L2.5 9.4l6.6-.8z';
  function stars(rating, size) {
    var wrap = el('span', 'stars');
    wrap.setAttribute('aria-label', rating + ' out of 5 stars');
    for (var i = 1; i <= 5; i++) {
      var fill = Math.max(0, Math.min(1, rating - i + 1));
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('width', size);
      svg.setAttribute('height', size);
      var id = 'g' + Math.random().toString(36).slice(2);
      svg.innerHTML =
        '<defs><linearGradient id="' + id + '"><stop offset="' + fill * 100 + '%" stop-color="#F5A623"/><stop offset="' + fill * 100 + '%" stop-color="#D9DEE5"/></linearGradient></defs>' +
        '<path d="' + STAR + '" fill="url(#' + id + ')"/>';
      wrap.appendChild(svg);
    }
    return wrap;
  }

  function ago(iso) {
    var days = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
    if (days < 1) return 'today';
    if (days < 7) return days === 1 ? 'yesterday' : days + ' days ago';
    if (days < 31) return Math.floor(days / 7) === 1 ? 'a week ago' : Math.floor(days / 7) + ' weeks ago';
    if (days < 365) return Math.floor(days / 30) <= 1 ? 'a month ago' : Math.floor(days / 30) + ' months ago';
    return Math.floor(days / 365) === 1 ? 'a year ago' : Math.floor(days / 365) + ' years ago';
  }

  var GOOGLE =
    '<svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z"/><path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.2-8.5 2.2-6.2 0-11.5-4.1-13.4-9.7l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg>';

  var css =
    ':host{all:initial;display:block}' +
    '.wrap{font-family:"Plus Jakarta Sans",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#0f1e36;max-width:1200px;margin:0 auto;padding:8px 0}' +
    '.head{display:flex;flex-wrap:wrap;align-items:center;gap:12px 20px;margin-bottom:16px}' +
    '.score{display:flex;align-items:center;gap:10px}' +
    '.num{font-size:40px;font-weight:800;line-height:1}' +
    '.sub{font-size:14px;color:#475569;display:flex;align-items:center;gap:6px;margin-top:4px}' +
    '.name{font-weight:700;font-size:16px}' +
    '.btn{margin-left:auto;background:var(--c);color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:10px 18px;border-radius:999px;white-space:nowrap}' +
    '.btn:hover{filter:brightness(1.1)}' +
    '.track{display:flex;gap:14px;overflow-x:auto;scroll-snap-type:x mandatory;padding:4px 2px 12px;scrollbar-width:none}' +
    '.track::-webkit-scrollbar{display:none}' +
    '.card{flex:0 0 calc((100% - 28px)/3);scroll-snap-align:start;box-sizing:border-box;background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:16px;box-shadow:0 1px 3px rgba(15,30,54,.06);display:flex;flex-direction:column;gap:10px}' +
    '@media (max-width:900px){.card{flex-basis:calc((100% - 14px)/2)}}' +
    '@media (max-width:560px){.card{flex-basis:85%}.btn{margin-left:0}}' +
    '.who{display:flex;align-items:center;gap:10px}' +
    '.avatar{width:38px;height:38px;border-radius:50%;object-fit:cover;flex:none;background:var(--c);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700}' +
    '.author{font-weight:700;font-size:14px}' +
    '.when{font-size:12px;color:#64748b}' +
    '.g{margin-left:auto;display:flex}' +
    '.text{font-size:14px;line-height:1.55;color:#334155;margin:0;display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden}' +
    '.text.full{-webkit-line-clamp:unset;display:block}' +
    '.more{background:none;border:0;padding:0;color:var(--c);font:inherit;font-size:13px;font-weight:700;cursor:pointer;align-self:flex-start}' +
    '.nav{display:flex;justify-content:center;gap:10px}' +
    '.arrow{width:36px;height:36px;border-radius:50%;border:1px solid #cbd5e1;background:#fff;color:#0f1e36;font-size:18px;cursor:pointer}' +
    '.arrow:hover{border-color:var(--c);color:var(--c)}' +
    '.stars{display:inline-flex;gap:1px}' +
    '.empty{font-size:14px;color:#64748b}';

  fetch(base + '/api/widget/' + encodeURIComponent(key) + '/reviews')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d) return;
      var style = el('style');
      style.textContent = css;
      root.appendChild(style);
      var wrap = el('div', 'wrap');
      wrap.style.setProperty('--c', d.color || '#087565');

      var head = el('div', 'head');
      var score = el('div', 'score');
      if (d.rating) score.appendChild(el('span', 'num', d.rating.toFixed(1)));
      var info = el('div');
      info.appendChild(el('div', 'name', d.name));
      var sub = el('div', 'sub');
      if (d.rating) sub.appendChild(stars(d.rating, 18));
      var count = el('span');
      count.appendChild(document.createTextNode(d.total + ' Google review' + (d.total === 1 ? '' : 's')));
      sub.appendChild(count);
      info.appendChild(sub);
      score.appendChild(info);
      head.appendChild(score);
      if (d.reviewLink) {
        var btn = el('a', 'btn', 'Leave us a review');
        btn.href = d.reviewLink;
        btn.target = '_blank';
        btn.rel = 'noopener';
        head.appendChild(btn);
      }
      wrap.appendChild(head);

      if (!d.reviews.length) {
        wrap.appendChild(el('p', 'empty', 'Reviews are on their way.'));
        root.appendChild(wrap);
        return;
      }
      var track = el('div', 'track');
      d.reviews.forEach(function (r) {
        var card = el('div', 'card');
        var who = el('div', 'who');
        var avatar;
        if (r.photo) {
          avatar = el('img', 'avatar');
          avatar.src = r.photo;
          avatar.alt = '';
          avatar.referrerPolicy = 'no-referrer';
          avatar.loading = 'lazy';
        } else {
          avatar = el('span', 'avatar', (r.author || '?').trim().charAt(0).toUpperCase());
        }
        who.appendChild(avatar);
        var meta = el('div');
        meta.appendChild(el('div', 'author', r.author));
        meta.appendChild(el('div', 'when', ago(r.date)));
        who.appendChild(meta);
        var g = el('span', 'g');
        g.innerHTML = GOOGLE;
        who.appendChild(g);
        card.appendChild(who);
        card.appendChild(stars(r.rating, 16));
        var text = el('p', 'text', r.text);
        card.appendChild(text);
        var more = el('button', 'more', 'Read more');
        more.type = 'button';
        more.style.display = 'none';
        more.onclick = function () {
          var full = text.classList.toggle('full');
          more.textContent = full ? 'Show less' : 'Read more';
        };
        card.appendChild(more);
        track.appendChild(card);
        // Only offer "Read more" when the text is actually cut off.
        requestAnimationFrame(function () {
          if (text.scrollHeight > text.clientHeight + 2) more.style.display = '';
        });
      });
      wrap.appendChild(track);

      var nav = el('div', 'nav');
      [['‹', -1, 'Previous reviews'], ['›', 1, 'Next reviews']].forEach(function (a) {
        var b = el('button', 'arrow', a[0]);
        b.type = 'button';
        b.setAttribute('aria-label', a[2]);
        b.onclick = function () { track.scrollBy({ left: a[1] * track.clientWidth * 0.9, behavior: 'smooth' }); };
        nav.appendChild(b);
      });
      wrap.appendChild(nav);
      root.appendChild(wrap);
    })
    .catch(function () { /* reviews unavailable: show nothing rather than a broken box */ });
})();
