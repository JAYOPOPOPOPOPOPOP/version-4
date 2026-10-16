/* Safe website updater.
 * Upload a new project .zip from Admin -> Update. Code files are replaced,
 * but DATA IS NEVER TOUCHED: data/, uploads/, public/uploads/, node_modules/, .env stay as-is.
 * Flow: parse zip -> stage in temp dir -> syntax-check -> backup current code -> swap files -> restart.
 * Any failure while swapping restores the backup automatically. No external dependencies.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const cp = require('child_process');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const LOG_FILE = path.join(DATA_DIR, 'update-log.json');
const MAX_ZIP = 200 * 1024 * 1024;
const MAX_UNPACKED = 600 * 1024 * 1024;
const MAX_ENTRIES = 20000;
const KEEP_BACKUPS = 3;

// Paths that an update must never overwrite or delete (relative, forward slashes)
const PROTECTED = ['data', 'uploads', 'public/uploads', 'node_modules', '.env', '.git', 'backups'];
function isProtected(rel) {
  const r = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  return PROTECTED.some(p => r === p || r.startsWith(p + '/')) || /\.updtmp$/.test(r) || /^\.update-staging/.test(r);
}

let busy = false;
const pending = new Map(); // token -> { buf, plan, at }

// ---------- zip reading (stored + deflate) ----------
function readZip(buf) {
  if (buf.length < 22) throw new Error('This is not a valid zip file');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This is not a valid zip file (end record not found)');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || off === 0xffffffff) throw new Error('ZIP64 is not supported. Please create a normal zip file');
  if (count > MAX_ENTRIES) throw new Error('The zip contains too many files');
  const out = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('The zip file is corrupt (central directory)');
    const flags = buf.readUInt16LE(off + 8);
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString((flags & 0x800) ? 'utf8' : 'utf8', off + 46, off + 46 + nlen);
    off += 46 + nlen + elen + clen;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new Error('Password-protected zip files are not supported');
    total += usize;
    if (total > MAX_UNPACKED) throw new Error('The zip is too large when unpacked');
    out.push({ name, method, csize, usize, lho });
  }
  return out;
}

function extract(buf, e) {
  if (buf.readUInt32LE(e.lho) !== 0x04034b50) throw new Error('The zip file is corrupt: ' + e.name);
  const nlen = buf.readUInt16LE(e.lho + 26);
  const elen = buf.readUInt16LE(e.lho + 28);
  const start = e.lho + 30 + nlen + elen;
  const raw = buf.subarray(start, start + e.csize);
  let data;
  if (e.method === 0) data = Buffer.from(raw);
  else if (e.method === 8) data = zlib.inflateRawSync(raw);
  else throw new Error('Unsupported zip compression in ' + e.name);
  if (data.length !== e.usize) throw new Error('The zip file is corrupt (size mismatch): ' + e.name);
  return data;
}

function cleanName(name) {
  let n = name.replace(/\\/g, '/').replace(/^\.\//, '');
  if (n.startsWith('/') || /^[a-zA-Z]:/.test(n)) return null;
  const parts = n.split('/');
  if (parts.some(p => p === '..' || p === '')) return null;
  return parts.join('/');
}

// ---------- build a plan from the zip ----------
function buildPlan(buf) {
  const entries = readZip(buf)
    .map(e => Object.assign(e, { clean: cleanName(e.name) }))
    .filter(e => e.clean && !e.clean.startsWith('__MACOSX/') && !/(^|\/)(\.DS_Store|Thumbs\.db)$/.test(e.clean));
  if (!entries.length) throw new Error('The zip file is empty');

  // project root inside zip = folder that holds server.js (zip root or one folder deep)
  const servers = entries.filter(e => /^([^/]+\/)?server\.js$/.test(e.clean)).sort((a, b) => a.clean.length - b.clean.length);
  if (!servers.length) throw new Error('server.js was not found in this zip. Please zip the entire website folder and upload it.');
  const prefix = servers[0].clean.slice(0, -'server.js'.length);

  const files = [];
  const skipped = [];
  for (const e of entries) {
    if (!e.clean.startsWith(prefix)) continue;
    const rel = e.clean.slice(prefix.length);
    if (!rel) continue;
    if (isProtected(rel)) { skipped.push(rel); continue; }
    files.push({ rel, entry: e });
  }
  if (!files.some(f => f.rel === 'server.js')) throw new Error('server.js not found');

  let added = 0, changed = 0, same = 0;
  const changedList = [];
  for (const f of files) {
    const dest = path.join(ROOT, f.rel);
    f.data = extract(buf, f.entry);
    if (!fs.existsSync(dest)) { added++; f.status = 'new'; changedList.push('+ ' + f.rel); }
    else if (Buffer.compare(fs.readFileSync(dest), f.data) !== 0) { changed++; f.status = 'changed'; changedList.push('~ ' + f.rel); }
    else { same++; f.status = 'same'; }
  }
  return { prefix, files, skipped, added, changed, same, changedList };
}

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function versionOf(dataBuf) {
  try { return JSON.parse(dataBuf.toString()).version || ''; } catch { return ''; }
}

// ---------- step 1: check ----------
function check(buf) {
  if (busy) throw new Error('Another update is in progress. Please wait a moment');
  if (buf.length > MAX_ZIP) throw new Error('The zip file is too large (max 200 MB)');
  const plan = buildPlan(buf);

  // syntax-check every staged .js outside public/ in a temp dir (never touches live files)
  const stage = path.join(ROOT, '.update-staging-' + Date.now());
  const warnings = [];
  try {
    for (const f of plan.files) {
      if (!/\.js$/.test(f.rel) || f.rel.startsWith('public/')) continue;
      const p = path.join(stage, f.rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, f.data);
      try { cp.execFileSync(process.execPath, ['--check', p], { stdio: 'pipe', timeout: 20000 }); }
      catch (err) {
        const msg = String((err.stderr || err.message || '')).split('\n').slice(0, 4).join(' ');
        throw new Error('Syntax error in the new ' + f.rel + '. Update aborted: ' + msg);
      }
    }
  } finally {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
  }
  const srv = plan.files.find(f => f.rel === 'server.js').data.toString();
  if (!/createServer/.test(srv)) throw new Error('This does not look like this website\'s server.js. Update aborted');

  const pkgNew = plan.files.find(f => f.rel === 'package.json');
  const curPkg = readJSON(path.join(ROOT, 'package.json'), {});
  const newVersion = pkgNew ? versionOf(pkgNew.data) : '';
  if (pkgNew) {
    let np = {};
    try { np = JSON.parse(pkgNew.data.toString()); } catch {}
    const a = JSON.stringify(np.dependencies || {}), b = JSON.stringify(curPkg.dependencies || {});
    if (a !== b) warnings.push('The dependencies in package.json have changed. You will need to run "npm install" on the server after the update.');
  }
  if (plan.added + plan.changed === 0) warnings.push('This zip contains no new changes (all files are already identical).');

  const token = require('crypto').randomBytes(16).toString('hex');
  pending.set(token, { buf, at: Date.now() });
  for (const [k, v] of pending) if (Date.now() - v.at > 15 * 60 * 1000) pending.delete(k);
  return {
    token,
    currentVersion: curPkg.version || '',
    newVersion,
    added: plan.added,
    changed: plan.changed,
    same: plan.same,
    protectedSkipped: plan.skipped.length,
    changedFiles: plan.changedList.slice(0, 80),
    moreFiles: Math.max(0, plan.changedList.length - 80),
    warnings
  };
}

// ---------- backup / restore ----------
function copyCode(srcRoot, dstRoot) {
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = path.relative(srcRoot, full).replace(/\\/g, '/');
      if (isProtected(rel)) continue;
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else {
        const dest = path.join(dstRoot, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(full, dest);
      }
    }
  };
  walk(srcRoot);
}

function makeBackup(label) {
  const id = new Date().toISOString().replace(/[:.]/g, '-') + (label ? '_' + label : '');
  const dir = path.join(BACKUP_DIR, id);
  fs.mkdirSync(path.join(dir, 'code'), { recursive: true });
  copyCode(ROOT, path.join(dir, 'code'));
  try { if (global.flushDBSync) global.flushDBSync(); } catch (e) {}
  const dbFile = path.join(DATA_DIR, 'db.json');
  if (fs.existsSync(dbFile)) fs.copyFileSync(dbFile, path.join(dir, 'db.json'));
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id, at: new Date().toISOString(), version: readJSON(path.join(ROOT, 'package.json'), {}).version || '' }));
  const all = fs.readdirSync(BACKUP_DIR).filter(n => fs.existsSync(path.join(BACKUP_DIR, n, 'meta.json'))).sort();
  while (all.length > KEEP_BACKUPS) {
    try { fs.rmSync(path.join(BACKUP_DIR, all.shift()), { recursive: true, force: true }); } catch {}
  }
  return id;
}

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .map(n => readJSON(path.join(BACKUP_DIR, n, 'meta.json'), null))
    .filter(Boolean)
    .sort((a, b) => b.at.localeCompare(a.at));
}

function restoreFiles(codeDir) {
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = path.relative(codeDir, full).replace(/\\/g, '/');
      if (fs.statSync(full).isDirectory()) { walk(full); continue; }
      const dest = path.join(ROOT, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(full, dest);
    }
  };
  walk(codeDir);
}

function log(entry) {
  const arr = readJSON(LOG_FILE, []);
  arr.unshift(entry);
  try { fs.writeFileSync(LOG_FILE, JSON.stringify(arr.slice(0, 30), null, 2)); } catch {}
}

// ---------- step 2: apply ----------
function apply(token, who) {
  if (busy) throw new Error('Another update is in progress');
  const item = pending.get(token);
  if (!item) throw new Error('The check session has expired. Please upload the zip again');
  busy = true;
  let backupId = '';
  try {
    const plan = buildPlan(item.buf);
    const fromVersion = readJSON(path.join(ROOT, 'package.json'), {}).version || '';
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    backupId = makeBackup('before-update');
    try {
      for (const f of plan.files) {
        if (f.status === 'same') continue;
        const dest = path.join(ROOT, f.rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const tmp = dest + '.updtmp';
        fs.writeFileSync(tmp, f.data);
        fs.renameSync(tmp, dest);
      }
    } catch (err) {
      // automatic rollback of code; data was never touched
      try { restoreFiles(path.join(BACKUP_DIR, backupId, 'code')); } catch {}
      throw new Error('Update failed. The previous code has been restored: ' + err.message);
    }
    const toVersion = readJSON(path.join(ROOT, 'package.json'), {}).version || '';
    log({ at: new Date().toISOString(), by: who || '', from: fromVersion, to: toVersion, added: plan.added, changed: plan.changed, backup: backupId });
    pending.delete(token);
    return { ok: true, backupId, added: plan.added, changed: plan.changed, fromVersion, toVersion };
  } finally {
    busy = false;
  }
}

function rollback(id, who) {
  if (busy) throw new Error('Another update is in progress');
  if (!/^[0-9A-Za-z_\-]+$/.test(id)) throw new Error('Invalid backup id');
  const dir = path.join(BACKUP_DIR, id, 'code');
  if (!fs.existsSync(dir)) throw new Error('Backup not found');
  busy = true;
  try {
    const safety = makeBackup('before-rollback');
    restoreFiles(dir);
    log({ at: new Date().toISOString(), by: who || '', rollback: id, backup: safety });
    return { ok: true };
  } finally {
    busy = false;
  }
}

function deleteBackup(id) {
  if (busy) throw new Error('Another update is in progress');
  if (!/^[0-9A-Za-z_\-]+$/.test(id)) throw new Error('Invalid backup id');
  const dir = path.join(BACKUP_DIR, id);
  if (!fs.existsSync(path.join(dir, 'meta.json'))) throw new Error('Backup not found');
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true };
}

function deleteHistory(at) {
  const arr = readJSON(LOG_FILE, []);
  const next = arr.filter(e => e.at !== at);
  if (next.length === arr.length) throw new Error('History entry not found');
  fs.writeFileSync(LOG_FILE, JSON.stringify(next, null, 2));
  return { ok: true };
}

function info() {
  return {
    version: readJSON(path.join(ROOT, 'package.json'), {}).version || '',
    node: process.version,
    launcher: process.env.UPDATER_LAUNCHER === '1',
    restartMode: process.env.UPDATER_LAUNCHER === '1' ? 'supervisor' : (managedHost() ? 'platform' : 'self'),
    managed: managedHost(),
    backups: listBackups(),
    history: readJSON(LOG_FILE, []).slice(0, 10)
  };
}

// ---------- restart ----------
function managedHost() {
  const e = process.env;
  return !!(e.pm_id || e.PM2_HOME || e.RENDER || e.RAILWAY_ENVIRONMENT || e.DYNO || e.FLY_APP_NAME || e.K_SERVICE || e.KUBERNETES_SERVICE_HOST || e.WEBSITE_SITE_NAME || e.INVOCATION_ID || e.UPDATER_EXIT_ONLY);
}

function scheduleRestart(closeFn) {
  // launcher : started via launcher.js, which restarts us when we exit with code 75 (works on every host)
  // platform : managed host without the launcher; exit with a NON-zero code, because e.g. Railway's
  //            default "restart on failure" policy ignores exit code 0 and the site would stay down
  // self     : plain local run; spawn a detached helper that boots the new code
  const underLauncher = process.env.UPDATER_LAUNCHER === '1';
  const mode = underLauncher ? 'launcher' : (managedHost() ? 'platform' : 'self');
  setTimeout(() => {
    try { if (closeFn) closeFn(); } catch {}
    if (mode === 'self') {
      // detached helper waits until the port is free, then boots the new code
      const script = path.join(ROOT, 'server.js');
      const code = "setTimeout(function(){require('child_process').spawn(process.execPath,[" + JSON.stringify(script) + "],{cwd:" + JSON.stringify(ROOT) + ",detached:true,stdio:'ignore',env:process.env}).unref();},2500)";
      cp.spawn(process.execPath, ['-e', code], { detached: true, stdio: 'ignore' }).unref();
    }
    process.exit(mode === 'launcher' ? 75 : (mode === 'platform' ? 1 : 0));
  }, 800);
  return mode;
}

module.exports = { check, apply, rollback, deleteBackup, deleteHistory, info, scheduleRestart, MAX_ZIP };
