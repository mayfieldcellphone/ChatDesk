/*
 * ChatBird opening hours for your website: today's open/closed status, the week's hours, upcoming
 * holiday hours, address and phone, kept in step with ChatBird \u2192 Listings. Also tells search engines
 * the same details (schema.org LocalBusiness).
 * Embed with: <script src="https://YOUR-CHATDESK-SERVER/hours.js" data-key="WIDGET_KEY" async></script>
 * It appears where the script tag is, or inside <div id="chatbird-hours"></div> if the page has one.
 * Optional: data-location="LOCATION_ID" for another location; data-layout="compact" for one line.
 */
(function () {
  'use strict';

  var script = document.currentScript;
  if (!script) return;
  var key = script.getAttribute('data-key');
  if (!key) return console.warn('ChatBird hours: missing data-key on the script tag');
  var base = new URL(script.src).origin;
  var location = script.getAttribute('data-location');
  var compact = script.getAttribute('data-layout') === 'compact';

  var host = document.getElementById('chatbird-hours');
  if (!host) {
    host = document.createElement('div');
    script.parentNode.insertBefore(host, script);
  }
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

  var DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  var NAMES = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
  var SCHEMA_DAYS = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function clock(hhmm) {
    var p = hhmm.split(':'), h = Number(p[0]), m = Number(p[1]);
    return (h % 12 || 12) + (m ? ':' + p[1] : '') + (h < 12 ? 'am' : 'pm');
  }
  /** Day, date and time at the shop, whatever the visitor's own time zone. */
  function shopNow(tz) {
    var parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
    var get = function (t) { return (parts.find(function (x) { return x.type === t; }) || {}).value || ''; };
    return { day: get('weekday').toLowerCase().slice(0, 3), time: get('hour') + ':' + get('minute'), date: new Date().toLocaleDateString('en-CA', { timeZone: tz }) };
  }
  function prettyDate(iso) {
    var d = new Date(iso + 'T12:00:00');
    return d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
  }

  var css =
    ':host{all:initial;display:block}' +
    '.card{font-family:"Plus Jakarta Sans",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#0f1e36;max-width:420px;border:1px solid #e2e8f0;border-radius:14px;padding:18px;background:#fff;box-sizing:border-box}' +
    '.status{display:flex;align-items:center;gap:8px;font-weight:700;font-size:16px;margin-bottom:12px}' +
    '.dot{width:10px;height:10px;border-radius:50%}' +
    '.open .dot{background:#16a34a}.closed .dot{background:#dc2626}' +
    '.sub{font-weight:500;color:#475569;font-size:14px}' +
    'table{width:100%;border-collapse:collapse;font-size:14px}' +
    'td{padding:5px 0;border-bottom:1px solid #f1f5f9}td+td{text-align:right;color:#334155}' +
    'tr.today td{font-weight:700;color:var(--c)}' +
    '.notice{margin-top:12px;background:#fff7ed;color:#9a3412;border-radius:10px;padding:10px 12px;font-size:13px;line-height:1.5}' +
    '.contact{margin-top:12px;font-size:14px;line-height:1.7}' +
    '.contact a{color:var(--c);text-decoration:none;font-weight:600}' +
    '.line{font-family:inherit;font-size:14px;color:#0f1e36}';

  fetch(base + '/api/widget/' + encodeURIComponent(key) + '/profile' + (location ? '?location=' + encodeURIComponent(location) : ''))
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d) return;
      var now = shopNow(d.timezone || 'Australia/Sydney');
      var special = {};
      (d.specialHours || []).forEach(function (s) { special[s.date] = s; });
      var todaySpecial = special[now.date];
      var todayHours = todaySpecial ? (todaySpecial.closed ? null : todaySpecial) : d.hours && d.hours[now.day];
      var isOpen = Boolean(d.hours && todayHours && now.time >= todayHours.open && now.time < todayHours.close);

      var style = el('style');
      style.textContent = css;
      root.appendChild(style);

      if (compact) {
        var line = el('div', 'line', (isOpen ? 'Open now until ' + clock(todayHours.close) : todayHours && now.time < todayHours.open ? 'Opens today at ' + clock(todayHours.open) : 'Closed now') + (d.phone ? ' \u00b7 ' + d.phone : ''));
        root.appendChild(line);
      } else {
        var card = el('div', 'card');
        card.style.setProperty('--c', d.color || '#087565');
        if (d.hours) {
          var status = el('div', 'status ' + (isOpen ? 'open' : 'closed'));
          status.appendChild(el('span', 'dot'));
          status.appendChild(document.createTextNode(isOpen ? 'Open now' : 'Closed now'));
          var subText = isOpen ? 'until ' + clock(todayHours.close) : todayHours && now.time < todayHours.open ? 'opens today at ' + clock(todayHours.open) : todaySpecial && todaySpecial.closed ? (todaySpecial.label || 'closed today') : '';
          if (subText) status.appendChild(el('span', 'sub', '\u00b7 ' + subText));
          card.appendChild(status);
          var table = el('table');
          DAYS.forEach(function (day) {
            var h = d.hours[day];
            var tr = el('tr', day === now.day ? 'today' : '');
            tr.appendChild(el('td', '', NAMES[day]));
            tr.appendChild(el('td', '', h ? clock(h.open) + ' \u2013 ' + clock(h.close) : 'Closed'));
            table.appendChild(tr);
          });
          card.appendChild(table);
        }
        if (d.specialHours && d.specialHours.length) {
          var notice = el('div', 'notice');
          notice.appendChild(el('b', '', 'Holiday hours'));
          d.specialHours.forEach(function (s) {
            notice.appendChild(el('div', '', prettyDate(s.date) + (s.label ? ' (' + s.label + ')' : '') + ': ' + (s.closed ? 'Closed' : clock(s.open) + ' \u2013 ' + clock(s.close))));
          });
          card.appendChild(notice);
        }
        var contact = el('div', 'contact');
        if (d.address) {
          var a = el('a', '', '\ud83d\udccd ' + d.address);
          a.href = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(d.name + ' ' + d.address);
          a.target = '_blank';
          a.rel = 'noopener';
          contact.appendChild(a);
          contact.appendChild(el('br'));
        }
        if (d.phone) {
          var tel = el('a', '', '\ud83d\udcde ' + d.phone);
          tel.href = 'tel:' + d.phone.replace(/[^\d+]/g, '');
          contact.appendChild(tel);
        }
        card.appendChild(contact);
        root.appendChild(card);
      }

      // The same details for search engines.
      var ld = { '@context': 'https://schema.org', '@type': 'LocalBusiness', name: d.name };
      if (d.phone) ld.telephone = d.phone;
      if (d.website) ld.url = d.website;
      if (d.address) ld.address = d.address;
      if (d.hours) {
        ld.openingHoursSpecification = DAYS.filter(function (day) { return d.hours[day]; }).map(function (day) {
          return { '@type': 'OpeningHoursSpecification', dayOfWeek: SCHEMA_DAYS[day], opens: d.hours[day].open, closes: d.hours[day].close };
        });
      }
      if (d.specialHours && d.specialHours.length) {
        ld.specialOpeningHoursSpecification = d.specialHours.map(function (s) {
          return s.closed
            ? { '@type': 'OpeningHoursSpecification', validFrom: s.date, validThrough: s.date, opens: '00:00', closes: '00:00' }
            : { '@type': 'OpeningHoursSpecification', validFrom: s.date, validThrough: s.date, opens: s.open, closes: s.close };
        });
      }
      var tag = document.createElement('script');
      tag.type = 'application/ld+json';
      tag.textContent = JSON.stringify(ld);
      document.head.appendChild(tag);
    })
    .catch(function () { /* hours unavailable: show nothing rather than a broken box */ });
})();
