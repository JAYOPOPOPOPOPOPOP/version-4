/* Admin -> Modules page (v1.3.0): add (zip), enable/disable, order, width, title, delete. */
(function () {
  'use strict';
  var root = document.getElementById('section-modules');
  if (!root) return;

  var SPAN_LABELS = { 3: '1/4 width', 4: '1/3 width', 6: '1/2 width', 8: '2/3 width', 12: 'Full width' };
  var modules = [];
  var esc = function (t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); };

  root.innerHTML =
    '<h1 class="page-title">Modules</h1>' +
    '<div class="panel">' +
    '  <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between">' +
    '    <div><h2 style="margin:0 0 4px">🧩 Installed modules</h2>' +
    '    <div style="opacity:.75;font-size:.88rem">Modules appear on the home page in this order. Upload the same module again to upgrade it - your order, width and saved data stay. <b>Use ✏️ Edit on a module to change its values.</b> <span style="opacity:.6">(Module system v1.4.1)</span></div></div>' +
    '    <button type="button" class="btn" id="mod-add">➕ Add Module</button>' +
    '  </div>' +
    '  <div class="msg" id="mod-msg" style="margin-top:12px"></div>' +
    '  <div id="mod-list" style="margin-top:14px"></div>' +
    '</div>' +
    '<div class="modal-overlay" id="modModal"><div class="modal modal-sm" style="max-width:460px;max-height:92vh;overflow:auto">' +
    '  <h2>Add Module</h2>' +
    '  <p style="opacity:.8;font-size:.88rem;margin:0 0 12px">Select the module <b>.zip</b> (it must contain <code>module.json</code>). Only upload modules you trust: a module can run its own server code.</p>' +
    '  <input type="file" id="mod-file" accept=".zip,application/zip" style="margin-bottom:10px;max-width:100%" />' +
    '  <label style="display:flex;gap:8px;align-items:center;font-size:.9rem;margin-bottom:12px"><input type="checkbox" id="mod-enable" checked /> Enable right after upload</label>' +
    '  <div><button type="button" class="btn" id="mod-upload">⬆ Upload &amp; install</button></div>' +
    '  <div class="msg" id="mod-umsg" style="margin-top:12px"></div>' +
    '  <div class="modal-actions"><button type="button" class="btn btn-outline" id="mod-close">Close</button></div>' +
    '</div></div>' +
    '<div class="modal-overlay" id="modCfgModal"><div class="modal modal-sm" style="max-width:460px;max-height:92vh;overflow:auto">' +
    '  <h2 id="modcfg-title">Edit module</h2>' +
    '  <div id="modcfg-form" style="display:grid;gap:12px;margin:12px 0"></div>' +
    '  <div class="msg" id="modcfg-msg"></div>' +
    '  <div class="modal-actions"><button type="button" class="btn btn-outline" id="modcfg-close">Close</button>' +
    '  <button type="button" class="btn" id="modcfg-save">Save</button></div>' +
    '</div></div>';

  var $ = function (id) { return document.getElementById(id); };

  function flash(el, text, ok) {
    el.className = 'msg ' + (ok ? 'ok' : 'err');
    el.textContent = text;
    el.style.display = 'block';
  }
  function api(url, opts) {
    opts = Object.assign({ credentials: 'same-origin' }, opts || {});
    return fetch(url, opts).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.success) throw new Error(d.message || 'Error');
      return d;
    });
  }
  function postJSON(url, body) {
    return api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  }

  function render() {
    var box = $('mod-list');
    if (!modules.length) {
      box.innerHTML = '<div style="opacity:.7;padding:18px 4px">No modules yet. Click <b>Add Module</b> and upload a zip.</div>';
      return;
    }
    box.innerHTML = modules.map(function (m, i) {
      var badge = m.error
        ? '<span style="background:#dc2626;color:#fff;border-radius:999px;padding:2px 9px;font-size:.72rem">Error</span>'
        : (m.enabled
          ? '<span style="background:#059669;color:#fff;border-radius:999px;padding:2px 9px;font-size:.72rem">Enabled</span>'
          : '<span style="background:#64748b;color:#fff;border-radius:999px;padding:2px 9px;font-size:.72rem">Disabled</span>');
      var spans = Object.keys(SPAN_LABELS).map(function (k) {
        return '<option value="' + k + '"' + (Number(k) === m.span ? ' selected' : '') + '>' + SPAN_LABELS[k] + '</option>';
      }).join('');
      return '<div class="mod-card" data-id="' + esc(m.id) + '" style="border:1px solid rgba(128,128,128,.28);border-radius:12px;padding:14px;margin-bottom:12px">' +
        '<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between">' +
        '  <div style="min-width:0"><b style="font-size:1.02rem">' + esc(m.originalName) + '</b> ' +
        '  <span style="opacity:.6;font-size:.8rem">v' + esc(m.version || '?') + (m.author ? ' · ' + esc(m.author) : '') + ' · ' + esc(m.id) + '</span> ' + badge +
        (m.description ? '<div style="opacity:.8;font-size:.86rem;margin-top:3px">' + esc(m.description) + '</div>' : '') +
        (m.error ? '<div style="color:#ef4444;font-size:.82rem;margin-top:4px">' + esc(m.error) + '</div>' : '') +
        '  </div>' +
        '  <div style="display:flex;gap:6px;flex-wrap:wrap">' +
        '    <button type="button" class="btn btn-outline" data-act="up"' + (i === 0 ? ' disabled' : '') + ' title="Move up">▲</button>' +
        '    <button type="button" class="btn btn-outline" data-act="down"' + (i === modules.length - 1 ? ' disabled' : '') + ' title="Move down">▼</button>' +
        (m.hasConfig ? '    <button type="button" class="btn" data-act="config">✏️ Edit</button>' : '') +
        '    <button type="button" class="btn ' + (m.enabled ? 'btn-outline' : '') + '" data-act="toggle">' + (m.enabled ? 'Disable' : 'Enable') + '</button>' +
        '    <button type="button" class="btn btn-danger" data-act="delete">Delete</button>' +
        '  </div>' +
        '</div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:14px;align-items:center;margin-top:12px;font-size:.88rem">' +
        '  <label>Width: <select data-f="span" style="padding:4px 6px">' + spans + '</select></label>' +
        '  <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-f="showTitle"' + (m.showTitle ? ' checked' : '') + ' /> Show title</label>' +
        '  <label>Title: <input type="text" data-f="title" value="' + esc(m.name) + '" maxlength="80" style="padding:4px 8px;width:190px" /></label>' +
        '  <button type="button" class="btn btn-outline" data-act="save">Save</button>' +
        '</div></div>';
    }).join('');
  }

  function load() {
    return api('/api/admin/modules').then(function (d) { modules = d.modules || []; render(); })
      .catch(function (e) { flash($('mod-msg'), e.message, false); });
  }

  function move(id, dir) {
    var i = modules.findIndex(function (m) { return m.id === id; });
    var j = i + dir;
    if (i < 0 || j < 0 || j >= modules.length) return;
    var t = modules[i]; modules[i] = modules[j]; modules[j] = t;
    render();
    postJSON('/api/admin/modules/reorder', { ids: modules.map(function (m) { return m.id; }) })
      .then(function () { flash($('mod-msg'), 'Order saved', true); })
      .catch(function (e) { flash($('mod-msg'), e.message, false); load(); });
  }

  $('mod-list').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn) return;
    var card = btn.closest('.mod-card');
    var id = card.dataset.id;
    var m = modules.find(function (x) { return x.id === id; });
    var act = btn.dataset.act;
    if (act === 'up') return move(id, -1);
    if (act === 'down') return move(id, 1);
    if (act === 'config') return openConfig(id);
    if (act === 'toggle') {
      btn.disabled = true;
      return postJSON('/api/admin/modules/' + id + '/toggle', { enabled: !m.enabled })
        .then(function () { flash($('mod-msg'), m.originalName + (m.enabled ? ' disabled' : ' enabled'), true); return load(); })
        .catch(function (err) { flash($('mod-msg'), err.message, false); return load(); });
    }
    if (act === 'save') {
      var body = {
        span: Number(card.querySelector('[data-f=span]').value),
        showTitle: card.querySelector('[data-f=showTitle]').checked,
        titleOverride: card.querySelector('[data-f=title]').value.trim() === m.originalName ? '' : card.querySelector('[data-f=title]').value
      };
      return postJSON('/api/admin/modules/' + id + '/settings', body)
        .then(function () { flash($('mod-msg'), 'Saved', true); return load(); })
        .catch(function (err) { flash($('mod-msg'), err.message, false); });
    }
    if (act === 'delete') {
      if (!confirm('Delete module "' + m.originalName + '"?')) return;
      var purge = confirm('Also delete the data saved by this module?\n\nOK = delete data too\nCancel = keep data (useful if you install it again later)');
      return api('/api/admin/modules/' + id + (purge ? '?purge=1' : ''), { method: 'DELETE' })
        .then(function () { flash($('mod-msg'), 'Module deleted', true); return load(); })
        .catch(function (err) { flash($('mod-msg'), err.message, false); });
    }
  });

  // ----- Edit (module settings): the ONLY place where module values are changed -----
  var cfgId = '', cfgSchema = [];
  function fieldHtml(f, v) {
    var label = '<span style="font-size:.82rem;opacity:.8">' + esc(f.label || f.key) + '</span>';
    var base = 'data-key="' + esc(f.key) + '" style="padding:8px 10px;width:100%"';
    if (f.type === 'checkbox') return '<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" ' + base.replace('width:100%', 'width:auto') + (v ? ' checked' : '') + ' /> ' + esc(f.label || f.key) + '</label>';
    if (f.type === 'textarea') return '<label style="display:grid;gap:4px">' + label + '<textarea rows="4" ' + base + '>' + esc(v) + '</textarea></label>';
    if (f.type === 'select') return '<label style="display:grid;gap:4px">' + label + '<select ' + base + '>' + (f.options || []).map(function (o) { return '<option value="' + esc(o) + '"' + (String(o) === String(v) ? ' selected' : '') + '>' + esc(o) + '</option>'; }).join('') + '</select></label>';
    return '<label style="display:grid;gap:4px">' + label + '<input type="' + (f.type === 'number' ? 'number' : 'text') + '" ' + (f.min !== undefined ? 'min="' + esc(f.min) + '" ' : '') + (f.max !== undefined ? 'max="' + esc(f.max) + '" ' : '') + base + ' value="' + esc(v) + '" /></label>';
  }
  function openConfig(id) {
    api('/api/admin/modules/' + id + '/config').then(function (d) {
      cfgId = id; cfgSchema = d.schema || [];
      $('modcfg-title').textContent = 'Edit: ' + d.name;
      $('modcfg-form').innerHTML = cfgSchema.map(function (f) { return fieldHtml(f, d.values[f.key]); }).join('') || '<div style="opacity:.7">This module has no settings.</div>';
      $('modcfg-msg').style.display = 'none';
      $('modCfgModal').classList.add('show');
    }).catch(function (e) { flash($('mod-msg'), e.message, false); });
  }
  $('modcfg-close').onclick = function () { $('modCfgModal').classList.remove('show'); };
  $('modCfgModal').addEventListener('click', function (e) { if (e.target === this) this.classList.remove('show'); });
  $('modcfg-save').onclick = function () {
    var body = {};
    $('modcfg-form').querySelectorAll('[data-key]').forEach(function (el) {
      body[el.dataset.key] = el.type === 'checkbox' ? el.checked : el.value;
    });
    postJSON('/api/admin/modules/' + cfgId + '/config', body)
      .then(function () { flash($('modcfg-msg'), 'Saved ✓ (home page par turant lagu)', true); })
      .catch(function (e) { flash($('modcfg-msg'), e.message, false); });
  };

  $('mod-add').onclick = function () {
    $('mod-file').value = ''; $('mod-umsg').style.display = 'none';
    $('modModal').classList.add('show');
  };
  $('mod-close').onclick = function () { $('modModal').classList.remove('show'); };
  $('modModal').addEventListener('click', function (e) { if (e.target === this) this.classList.remove('show'); });

  $('mod-upload').onclick = function () {
    var f = $('mod-file').files[0];
    if (!f) return flash($('mod-umsg'), 'Please choose a .zip file first', false);
    var b = this; b.disabled = true;
    flash($('mod-umsg'), 'Uploading...', true);
    fetch('/api/admin/modules/upload?enable=' + ($('mod-enable').checked ? '1' : '0'), {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/zip' }, body: f
    }).then(function (r) { return r.json(); }).then(function (d) {
      b.disabled = false;
      if (!d.success) return flash($('mod-umsg'), d.message || 'Upload failed', false);
      flash($('mod-umsg'), (d.upgraded ? 'Upgraded: ' : 'Installed: ') + d.module.originalName + ' v' + d.module.version, true);
      load();
    }).catch(function (err) { b.disabled = false; flash($('mod-umsg'), err.message, false); });
  };

  document.querySelectorAll('.sidebar nav a[data-section="modules"]').forEach(function (a) {
    a.addEventListener('click', load);
  });
})();
