/* Module loader (v1.3.0)
 * Put <div data-nx-slot="home"></div> on any page and <script src="/js/modules-loader.js" defer></script>.
 * Every enabled module of that slot is shown in its own box (Shadow DOM, so styles never clash with the site
 * or with other modules). A module that fails is skipped silently - it can never break the page.
 */
(function () {
  'use strict';
  var registry = (window.NXModules = window.NXModules || {});
  var defs = registry._defs = registry._defs || {};
  registry.register = function (id, def) { defs[id] = def; };

  var BASE_CSS =
    ':host{display:block;min-width:0}' +
    '*{box-sizing:border-box}' +
    '.nx-box{height:100%;background:var(--bg-card,#fff);border:1px solid var(--border,rgba(8,145,178,.22));' +
    'border-radius:16px;padding:1.1rem 1.25rem;color:var(--text,#0f172a);font-family:inherit;box-shadow:var(--shadow,none)}' +
    '.nx-title{margin:0 0 .8rem;font-size:1.05rem;font-weight:700;color:var(--text,#0f172a)}' +
    'a{color:var(--accent,#0891b2)}img{max-width:100%}';

  var GRID_CSS =
    '[data-nx-slot]{position:relative;z-index:1}' +
    '.nx-grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:1.25rem;max-width:1200px;margin:0 auto;padding:1.5rem 1.25rem}' +
    '.nx-grid:empty{display:none}' +
    '@media(max-width:820px){.nx-grid>.nx-item{grid-column:span 12!important}}';

  function addGridStyle() {
    if (document.getElementById('nx-grid-style')) return;
    var st = document.createElement('style');
    st.id = 'nx-grid-style';
    st.textContent = GRID_CSS;
    document.head.appendChild(st);
  }

  function getText(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error(url + ' ' + r.status);
      return r.text();
    });
  }
  function loadScript(url) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = url; s.async = true;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('script failed: ' + url)); };
      document.head.appendChild(s);
    });
  }

  function mountModule(grid, m) {
    var v = encodeURIComponent(m.updatedAt || m.version || '1');
    var base = '/api/modules/assets/' + m.id + '/';

    var item = document.createElement('div');
    item.className = 'nx-item';
    item.dataset.module = m.id;
    item.style.gridColumn = 'span ' + (m.span || 12);
    grid.appendChild(item);

    var shadow = item.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = BASE_CSS;
    shadow.appendChild(style);

    var box = document.createElement('div');
    box.className = 'nx-box';
    if (m.showTitle) {
      var h = document.createElement('h3');
      h.className = 'nx-title';
      h.textContent = m.name;
      box.appendChild(h);
    }
    var body = document.createElement('div');
    body.className = 'nx-body';
    box.appendChild(body);
    shadow.appendChild(box);

    var jobs = [];
    if (m.hasCss) jobs.push(getText(base + 'widget.css?v=' + v).then(function (css) {
      var s = document.createElement('style'); s.textContent = css; shadow.appendChild(s);
    }));
    if (m.hasHtml) jobs.push(getText(base + 'widget.html?v=' + v).then(function (html) { body.innerHTML = html; }));
    if (m.hasJs) jobs.push(loadScript(base + 'widget.js?v=' + v));

    return Promise.all(jobs).then(function () {
      var def = defs[m.id];
      if (def && typeof def.mount === 'function') {
        def.mount(body, {
          id: m.id,
          root: shadow,
          settings: { name: m.name, span: m.span },
          api: function (p, opts) { return fetch('/api/m/' + m.id + (p.charAt(0) === '/' ? p : '/' + p), Object.assign({ credentials: 'same-origin' }, opts || {})).then(function (r) { return r.json(); }); },
          assetUrl: function (f) { return base + 'assets/' + String(f).replace(/^\/+/, ''); }
        });
      }
    }).catch(function (err) {
      console.warn('[modules] "' + m.id + '" skipped:', err && err.message);
      if (item.parentNode) item.parentNode.removeChild(item);
    });
  }

  function loadSlot(el) {
    var slot = el.getAttribute('data-nx-slot') || 'home';
    fetch('/api/modules/active?slot=' + encodeURIComponent(slot), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var list = (d && d.modules) || [];
        if (!list.length) return;
        addGridStyle();
        var grid = document.createElement('div');
        grid.className = 'nx-grid';
        el.appendChild(grid);
        // mount in order (one failing module does not stop the others)
        return list.reduce(function (p, m) { return p.then(function () { return mountModule(grid, m); }); }, Promise.resolve());
      })
      .catch(function (e) { console.warn('[modules] could not load slot', slot, e && e.message); });
  }

  function start() { document.querySelectorAll('[data-nx-slot]').forEach(loadSlot); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
