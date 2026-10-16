/* Module system (v1.3.0)
 *
 * Admin uploads a module .zip -> it is stored in data/modules/<id>/ -> it can be enabled / disabled /
 * reordered / resized / deleted without touching the core code. Because everything lives inside data/,
 * the website updater (updater.js) never overwrites or deletes modules, and modules never overwrite core files.
 *
 * Module zip layout (zip root, or one folder deep):
 *   module.json   REQUIRED  { "id":"top-buys", "name":"Top Buys", "version":"1.0.0", "description":"", "author":"", "slot":"home", "span":6 }
 *   widget.js     optional  frontend (NXModules.register(id, { mount(el, ctx) {...} }))
 *   widget.html   optional  static markup shown inside the module box
 *   widget.css    optional  styles (isolated in Shadow DOM, they can not leak into the site)
 *   server.js     optional  backend:  module.exports = function (api) { api.get('/top', (req,res,c)=>api.json(res,200,{...})); }
 *   assets/       optional  images / fonts (public)
 *
 * Folders:   data/modules/<id>/        module code (replaced on upgrade)
 *            data/module-data/<id>/    module's own saved data (kept on upgrade, removed only if you choose "purge")
 *            data/modules.json         registry: enabled / order / width per module
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const cp = require('child_process');

const DATA_DIR = path.join(__dirname, 'data');
const MOD_DIR = path.join(DATA_DIR, 'modules');
const STORE_DIR = path.join(DATA_DIR, 'module-data');
const REG_FILE = path.join(DATA_DIR, 'modules.json');

const MAX_ZIP = 25 * 1024 * 1024;
const MAX_UNPACKED = 80 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const SPANS = [3, 4, 6, 8, 12]; // 12-column grid: 1/4, 1/3, 1/2, 2/3, full
const PUBLIC_FILES = ['widget.js', 'widget.css', 'widget.html'];
const ALLOWED_EXT = new Set(['.json', '.js', '.css', '.html', '.txt', '.md', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.mp3', '.ogg']);

let ctx = null;            // helpers handed over by server.js
let registry = { modules: {} };
const routes = new Map();  // id -> [{ method, parts, handler, admin }]
const loadErrors = new Map();

// ---------- registry ----------
function readRegistry() {
  try {
    const r = JSON.parse(fs.readFileSync(REG_FILE, 'utf8'));
    if (r && r.modules) return r;
  } catch (e) {}
  return { modules: {} };
}
function saveRegistry() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = REG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2));
  fs.renameSync(tmp, REG_FILE);
}
function readManifest(id) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(MOD_DIR, id, 'module.json'), 'utf8'));
    return m && typeof m === 'object' ? m : null;
  } catch (e) { return null; }
}
function has(id, file) { return fs.existsSync(path.join(MOD_DIR, id, file)); }

function publicInfo(id) {
  const reg = registry.modules[id];
  const man = readManifest(id) || {};
  return {
    id,
    name: reg.titleOverride || man.name || id,
    originalName: man.name || id,
    version: String(man.version || ''),
    description: String(man.description || ''),
    author: String(man.author || ''),
    slot: man.slot || 'home',
    enabled: !!reg.enabled,
    order: reg.order || 0,
    span: SPANS.includes(reg.span) ? reg.span : 12,
    showTitle: reg.showTitle !== false,
    hasConfig: Array.isArray(man.settings) && man.settings.length > 0,
    hasServer: has(id, 'server.js'),
    hasJs: has(id, 'widget.js'),
    hasCss: has(id, 'widget.css'),
    hasHtml: has(id, 'widget.html'),
    error: loadErrors.get(id) || '',
    installedAt: reg.installedAt || '',
    updatedAt: reg.updatedAt || ''
  };
}

// ---------- zip reading (stored + deflate, no dependencies) ----------
function readZip(buf) {
  if (buf.length < 22) throw new Error('Yeh valid zip file nahi hai');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Yeh valid zip file nahi hai');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || off === 0xffffffff) throw new Error('ZIP64 supported nahi hai');
  if (count > MAX_ENTRIES) throw new Error('Zip me bahut zyada files hain');
  const out = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('Zip file corrupt hai');
    const flags = buf.readUInt16LE(off + 8);
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nlen);
    off += 46 + nlen + elen + clen;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new Error('Password-protected zip supported nahi hai');
    total += usize;
    if (total > MAX_UNPACKED) throw new Error('Zip unpack hone par bahut badi hai');
    out.push({ name, method, csize, usize, lho });
  }
  return out;
}
function extractEntry(buf, e) {
  if (buf.readUInt32LE(e.lho) !== 0x04034b50) throw new Error('Zip corrupt: ' + e.name);
  const nlen = buf.readUInt16LE(e.lho + 26);
  const elen = buf.readUInt16LE(e.lho + 28);
  const start = e.lho + 30 + nlen + elen;
  const raw = buf.subarray(start, start + e.csize);
  let data;
  if (e.method === 0) data = Buffer.from(raw);
  else if (e.method === 8) data = zlib.inflateRawSync(raw);
  else throw new Error('Unsupported compression: ' + e.name);
  if (data.length !== e.usize) throw new Error('Zip corrupt (size mismatch): ' + e.name);
  return data;
}
function cleanName(name) {
  const n = name.replace(/\\/g, '/').replace(/^\.\//, '');
  if (n.startsWith('/') || /^[a-zA-Z]:/.test(n)) return null;
  const parts = n.split('/');
  if (parts.some(p => p === '..' || p === '' || p === '.')) return null;
  return parts.join('/');
}

// ---------- install / upgrade ----------
function install(buf, opts) {
  opts = opts || {};
  if (buf.length > MAX_ZIP) throw new Error('Zip bahut badi hai (max 25 MB)');
  const entries = readZip(buf)
    .map(e => Object.assign(e, { clean: cleanName(e.name) }))
    .filter(e => e.clean && !e.clean.startsWith('__MACOSX/') && !/(^|\/)(\.DS_Store|Thumbs\.db)$/.test(e.clean));
  if (!entries.length) throw new Error('Zip khaali hai');

  const mj = entries.filter(e => /^([^/]+\/)?module\.json$/.test(e.clean)).sort((a, b) => a.clean.length - b.clean.length)[0];
  if (!mj) throw new Error('module.json nahi mila. Zip ke andar module.json hona zaroori hai.');
  const prefix = mj.clean.slice(0, -'module.json'.length);

  let manifest;
  try { manifest = JSON.parse(extractEntry(buf, mj).toString('utf8')); }
  catch (e) { throw new Error('module.json valid JSON nahi hai'); }
  const id = String(manifest.id || '').trim();
  if (!ID_RE.test(id)) throw new Error('module.json me "id" galat hai. Sirf a-z, 0-9 aur "-" (2 se 40 characters), jaise "top-buys".');
  if (!String(manifest.name || '').trim()) throw new Error('module.json me "name" zaroori hai');

  const files = [];
  for (const e of entries) {
    if (!e.clean.startsWith(prefix)) continue;
    const rel = e.clean.slice(prefix.length);
    if (!rel) continue;
    const ext = path.extname(rel).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) throw new Error('File type allowed nahi hai: ' + rel);
    files.push({ rel, data: extractEntry(buf, e) });
  }

  fs.mkdirSync(MOD_DIR, { recursive: true });
  const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  const tmpDir = path.join(MOD_DIR, '.tmp-' + stamp);
  const finalDir = path.join(MOD_DIR, id);
  const oldDir = path.join(MOD_DIR, '.old-' + stamp);
  try {
    for (const f of files) {
      const p = path.join(tmpDir, f.rel);
      if (!p.startsWith(tmpDir + path.sep)) throw new Error('Galat file path: ' + f.rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, f.data);
    }
    // syntax check every .js BEFORE it can touch the live module
    for (const f of files) {
      if (!/\.js$/.test(f.rel)) continue;
      try { cp.execFileSync(process.execPath, ['--check', path.join(tmpDir, f.rel)], { stdio: 'pipe', timeout: 20000 }); }
      catch (err) {
        const m = String((err.stderr || err.message || '')).split('\n').slice(0, 4).join(' ');
        throw new Error('Syntax error in ' + f.rel + ': ' + m);
      }
    }
    const isUpgrade = fs.existsSync(finalDir);
    unload(id);
    if (isUpgrade) fs.renameSync(finalDir, oldDir);
    fs.renameSync(tmpDir, finalDir);

    const now = new Date().toISOString();
    const prev = registry.modules[id];
    const wasEnabled = prev ? !!prev.enabled : !!opts.enable;
    if (!prev) {
      const maxOrder = Object.values(registry.modules).reduce((a, m) => Math.max(a, m.order || 0), 0);
      registry.modules[id] = {
        enabled: false, order: maxOrder + 1,
        span: SPANS.includes(Number(manifest.span)) ? Number(manifest.span) : 12,
        showTitle: manifest.showTitle !== false, installedAt: now
      };
    }
    registry.modules[id].updatedAt = now;
    registry.modules[id].enabled = wasEnabled;
    loadErrors.delete(id);

    if (wasEnabled) {
      try { load(id); }
      catch (err) {
        // new code failed to start -> put the old version back
        try {
          fs.rmSync(finalDir, { recursive: true, force: true });
          if (isUpgrade) { fs.renameSync(oldDir, finalDir); }
          else { delete registry.modules[id]; }
          if (isUpgrade) { try { load(id); } catch (e2) {} }
        } catch (e3) {}
        saveRegistry();
        throw new Error('Module start nahi hua, purana version wapas laga diya: ' + err.message);
      }
    }
    saveRegistry();
    try { fs.rmSync(oldDir, { recursive: true, force: true }); } catch (e) {}
    return { upgraded: isUpgrade, module: publicInfo(id) };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}

// ---------- editable module settings (edited ONLY from Admin -> Modules -> Edit) ----------
// A module declares its fields in module.json:
//   "settings": [ { "key":"goal", "label":"Monthly goal", "type":"number", "default":10000, "min":1, "max":100000000 },
//                 { "key":"label", "label":"Title", "type":"text", "default":"My title", "maxLength":60 } ]
// types: number | text | textarea | checkbox | select (with "options":["a","b"])
const SETTINGS_FILE = (id) => path.join(STORE_DIR, id, '__settings.json');

function schemaOf(id) {
  const man = readManifest(id) || {};
  return (Array.isArray(man.settings) ? man.settings : [])
    .filter(f => f && /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(String(f.key || '')) &&
      ['number', 'text', 'textarea', 'checkbox', 'select'].includes(f.type))
    .slice(0, 30);
}
function getSettings(id) {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(SETTINGS_FILE(id), 'utf8')) || {}; } catch (e) {}
  const out = {};
  schemaOf(id).forEach(f => {
    out[f.key] = Object.prototype.hasOwnProperty.call(saved, f.key) ? saved[f.key]
      : (f.default !== undefined ? f.default : (f.type === 'number' ? 0 : f.type === 'checkbox' ? false : ''));
  });
  return out;
}
function saveSettings(id, body) {
  if (!registry.modules[id]) throw new Error('Module nahi mila');
  const values = {};
  schemaOf(id).forEach(f => {
    const raw = body[f.key];
    const label = f.label || f.key;
    if (f.type === 'number') {
      const n = Number(raw);
      if (raw === '' || raw === null || raw === undefined || !isFinite(n)) throw new Error(label + ': number likho');
      if (f.min !== undefined && n < Number(f.min)) throw new Error(label + ': minimum ' + f.min + ' hona chahiye');
      if (f.max !== undefined && n > Number(f.max)) throw new Error(label + ': maximum ' + f.max + ' hona chahiye');
      values[f.key] = n;
    } else if (f.type === 'checkbox') {
      values[f.key] = !!raw;
    } else if (f.type === 'select') {
      const opts = (f.options || []).map(String);
      if (!opts.includes(String(raw))) throw new Error(label + ': galat option');
      values[f.key] = String(raw);
    } else {
      values[f.key] = String(raw == null ? '' : raw).trim().slice(0, Number(f.maxLength) || (f.type === 'textarea' ? 2000 : 200));
    }
  });
  fs.mkdirSync(path.join(STORE_DIR, id), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE(id), JSON.stringify(values));
  return values;
}

// ---------- server-side loading ----------
function makeApi(id) {
  const list = [];
  routes.set(id, list);
  const add = (method) => (p, handler, o) => {
    if (typeof handler !== 'function') throw new Error('Route handler function hona chahiye');
    list.push({ method, parts: String(p || '/').split('/').filter(Boolean), handler, admin: !!(o && o.admin) });
  };
  const storeDir = path.join(STORE_DIR, id);
  const storeFile = (k) => {
    const key = String(k).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    return path.join(storeDir, key + '.json');
  };
  return {
    id,
    manifest: readManifest(id) || {},
    settings: () => getSettings(id),   // values set by the admin in Admin -> Modules -> Edit
    get: add('GET'), post: add('POST'), put: add('PUT'), delete: add('DELETE'),
    json: (res, status, data) => ctx.sendJSON(res, status, data),
    storage: {
      get(key, fallback) { try { return JSON.parse(fs.readFileSync(storeFile(key), 'utf8')); } catch (e) { return fallback === undefined ? null : fallback; } },
      set(key, value) { fs.mkdirSync(storeDir, { recursive: true }); fs.writeFileSync(storeFile(key), JSON.stringify(value)); return true; },
      remove(key) { try { fs.unlinkSync(storeFile(key)); } catch (e) {} return true; }
    },
    // read-only views of the store data (copies, so a module can not corrupt the core database)
    db: {
      sales: () => (ctx.loadDB().sales || []).map(s => Object.assign({}, s)),
      products: () => (ctx.loadDB().products || []).filter(p => p.enabled !== false).map(p => ({
        id: p.id, name: p.name, price: p.price, image: p.image, categoryId: p.categoryId,
        shortDescription: p.shortDescription || '', featured: !!p.featured
      })),
      categories: () => (ctx.loadDB().categories || []).map(c => Object.assign({}, c)),
      settings: () => {
        const s = ctx.loadDB().settings || {};
        return { siteName: s.siteName, serverIP: s.serverIP, serverPort: s.serverPort, discordLink: s.discordLink };
      }
    },
    log: (...a) => console.log('[module:' + id + ']', ...a)
  };
}

function clearRequireCache(dir) {
  const prefix = dir + path.sep;
  Object.keys(require.cache).forEach(k => { if (k.startsWith(prefix)) delete require.cache[k]; });
}

function load(id) {
  const dir = path.join(MOD_DIR, id);
  unload(id);
  const file = path.join(dir, 'server.js');
  if (!fs.existsSync(file)) { routes.set(id, []); return; }
  clearRequireCache(dir);
  try {
    const api = makeApi(id);
    const fn = require(file);
    const init = typeof fn === 'function' ? fn : (fn && typeof fn.register === 'function' ? fn.register : null);
    if (!init) throw new Error('server.js ko "module.exports = function (api) {...}" export karna chahiye');
    init(api);
    loadErrors.delete(id);
  } catch (err) {
    routes.delete(id);
    clearRequireCache(dir);
    loadErrors.set(id, err.message);
    throw err;
  }
}
function unload(id) {
  routes.delete(id);
  clearRequireCache(path.join(MOD_DIR, id));
}

// ---------- admin actions ----------
function setEnabled(id, enabled) {
  const reg = registry.modules[id];
  if (!reg) throw new Error('Module nahi mila');
  if (enabled) {
    try { load(id); } catch (err) { reg.enabled = false; saveRegistry(); throw new Error('Module enable nahi hua: ' + err.message); }
    reg.enabled = true;
  } else {
    unload(id);
    reg.enabled = false;
  }
  saveRegistry();
  return publicInfo(id);
}
function updateSettings(id, body) {
  const reg = registry.modules[id];
  if (!reg) throw new Error('Module nahi mila');
  if (body.span !== undefined) {
    const s = Number(body.span);
    if (!SPANS.includes(s)) throw new Error('Width galat hai');
    reg.span = s;
  }
  if (body.showTitle !== undefined) reg.showTitle = !!body.showTitle;
  if (body.titleOverride !== undefined) {
    const t = String(body.titleOverride || '').trim().slice(0, 80);
    if (t) reg.titleOverride = t; else delete reg.titleOverride;
  }
  reg.updatedAt = new Date().toISOString();
  saveRegistry();
  return publicInfo(id);
}
function reorder(ids) {
  if (!Array.isArray(ids)) throw new Error('ids list chahiye');
  ids.forEach((id, i) => { if (registry.modules[id]) registry.modules[id].order = i + 1; });
  saveRegistry();
}
function remove(id, purge) {
  if (!registry.modules[id]) throw new Error('Module nahi mila');
  unload(id);
  fs.rmSync(path.join(MOD_DIR, id), { recursive: true, force: true });
  if (purge) fs.rmSync(path.join(STORE_DIR, id), { recursive: true, force: true });
  delete registry.modules[id];
  loadErrors.delete(id);
  saveRegistry();
}
function sortedIds() {
  return Object.keys(registry.modules).sort((a, b) => (registry.modules[a].order || 0) - (registry.modules[b].order || 0));
}

// ---------- startup ----------
function init(helpers) {
  ctx = helpers;
  fs.mkdirSync(MOD_DIR, { recursive: true });
  registry = readRegistry();
  // clean leftovers of an interrupted install
  try { fs.readdirSync(MOD_DIR).forEach(n => { if (/^\.(tmp|old)-/.test(n)) fs.rmSync(path.join(MOD_DIR, n), { recursive: true, force: true }); }); } catch (e) {}
  // drop registry entries whose folder is gone
  Object.keys(registry.modules).forEach(id => { if (!fs.existsSync(path.join(MOD_DIR, id))) delete registry.modules[id]; });
  sortedIds().forEach(id => {
    if (!registry.modules[id].enabled) return;
    try { load(id); console.log('[modules] loaded ' + id); }
    catch (err) { console.error('[modules] ' + id + ' failed to start and was skipped: ' + err.message); }
  });
  saveRegistry();
}

// ---------- HTTP ----------
function matchRoute(list, method, parts) {
  for (const r of list) {
    if (r.method !== method || r.parts.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      if (r.parts[i].startsWith(':')) params[r.parts[i].slice(1)] = decodeURIComponent(parts[i]);
      else if (r.parts[i] !== parts[i]) { ok = false; break; }
    }
    if (ok) return { route: r, params };
  }
  return null;
}

function isAdmin(u) { return !!u && u.role === 'admin' && !u.banned; }

// returns true if the request was handled, false if it is not a module URL
async function handle(req, res, pathname, query) {
  const method = req.method;
  const send = ctx.sendJSON;
  try {
    // ----- public: modules to show on a page -----
    if (pathname === '/api/modules/active' && method === 'GET') {
      const slot = String(query.get('slot') || 'home');
      const list = sortedIds().filter(id => registry.modules[id].enabled && !loadErrors.has(id))
        .map(publicInfo).filter(m => m.slot === slot && (m.hasJs || m.hasHtml));
      res.setHeader && res.setHeader('Cache-Control', 'no-cache');
      send(res, 200, { success: true, modules: list });
      return true;
    }

    // ----- public: module files (only widget.* and assets/**, never server.js) -----
    let m = pathname.match(/^\/api\/modules\/assets\/([a-z0-9-]+)\/(.+)$/);
    if (m && method === 'GET') {
      const id = m[1];
      const rel = decodeURIComponent(m[2]);
      const reg = registry.modules[id];
      const okFile = PUBLIC_FILES.includes(rel) || (rel.startsWith('assets/') && !rel.includes('..'));
      if (!reg || !reg.enabled || !okFile) { send(res, 404, { success: false, message: 'Not found' }); return true; }
      const full = path.join(MOD_DIR, id, rel);
      if (!full.startsWith(path.join(MOD_DIR, id) + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
        send(res, 404, { success: false, message: 'Not found' }); return true;
      }
      const ext = path.extname(full).toLowerCase();
      res.writeHead(200, { 'Content-Type': ctx.getMime(ext), 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      res.end(fs.readFileSync(full));
      return true;
    }

    // ----- module's own API: /api/m/<id>/... -----
    m = pathname.match(/^\/api\/m\/([a-z0-9-]+)(\/.*)?$/);
    if (m) {
      const id = m[1];
      const reg = registry.modules[id];
      if (!reg || !reg.enabled || !routes.has(id)) { send(res, 404, { success: false, message: 'Module not found or disabled' }); return true; }
      const parts = (m[2] || '/').split('/').filter(Boolean);
      const hit = matchRoute(routes.get(id), method, parts);
      if (!hit) { send(res, 404, { success: false, message: 'Module route not found' }); return true; }
      const user = ctx.getAuthUser(req);
      if (hit.route.admin && !isAdmin(user)) { send(res, 403, { success: false, message: 'Admin only' }); return true; }
      let cached = null;
      const c = {
        query: Object.fromEntries(query.entries()), params: hit.params, user: user ? { id: user.id, role: user.role } : null,
        body: async () => {
          if (cached !== null) return cached;
          const raw = await ctx.readBodyLimited(req, 2 * 1024 * 1024);
          try { cached = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch (e) { cached = {}; }
          return cached;
        }
      };
      try { await hit.route.handler(req, res, c); }
      catch (err) {
        console.error('[module:' + id + '] route error:', err);
        if (!res.headersSent) send(res, 500, { success: false, message: 'Module error' });
      }
      return true;
    }

    // ----- admin -----
    if (pathname.startsWith('/api/admin/modules')) {
      const user = ctx.getAuthUser(req);
      if (!isAdmin(user)) { send(res, 403, { success: false, message: 'Admin only' }); return true; }

      if (pathname === '/api/admin/modules' && method === 'GET') {
        send(res, 200, { success: true, modules: sortedIds().map(publicInfo), maxZipMB: MAX_ZIP / 1024 / 1024 });
        return true;
      }
      if (pathname === '/api/admin/modules/upload' && method === 'POST') {
        const buf = await ctx.readBodyLimited(req, MAX_ZIP);
        const r = install(buf, { enable: query.get('enable') !== '0' });
        send(res, 200, Object.assign({ success: true }, r));
        return true;
      }
      if (pathname === '/api/admin/modules/reorder' && method === 'POST') {
        const body = JSON.parse((await ctx.readBody(req)).toString() || '{}');
        reorder(body.ids);
        send(res, 200, { success: true });
        return true;
      }
      m = pathname.match(/^\/api\/admin\/modules\/([a-z0-9-]+)\/config$/);
      if (m && registry.modules[m[1]]) {
        if (method === 'GET') {
          send(res, 200, { success: true, name: publicInfo(m[1]).originalName, schema: schemaOf(m[1]), values: getSettings(m[1]) });
          return true;
        }
        if (method === 'POST') {
          const body = JSON.parse((await ctx.readBody(req)).toString() || '{}');
          send(res, 200, { success: true, values: saveSettings(m[1], body) });
          return true;
        }
      }
      m = pathname.match(/^\/api\/admin\/modules\/([a-z0-9-]+)\/(toggle|settings)$/);
      if (m && method === 'POST') {
        const body = JSON.parse((await ctx.readBody(req)).toString() || '{}');
        const info = m[2] === 'toggle' ? setEnabled(m[1], !!body.enabled) : updateSettings(m[1], body);
        send(res, 200, { success: true, module: info });
        return true;
      }
      m = pathname.match(/^\/api\/admin\/modules\/([a-z0-9-]+)$/);
      if (m && method === 'DELETE') {
        remove(m[1], query.get('purge') === '1');
        send(res, 200, { success: true });
        return true;
      }
      send(res, 404, { success: false, message: 'Not found' });
      return true;
    }
  } catch (err) {
    send(res, 400, { success: false, message: err.message || 'Module error' });
    return true;
  }
  return false;
}

module.exports = { init, handle, MAX_ZIP };
