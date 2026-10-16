/* Built-in supervisor: makes updates restart the website on ANY host.
 *
 * How it works: whatever the start command is (node server.js, npm start, node launcher.js,
 * pm2, a game-panel like Pterodactyl, a VPS, Railway, Render ...), the process that the host
 * started stays alive and runs the real website (server.js) as a child process.
 * When the updater finishes, the child exits with code 75 and this supervisor starts it again.
 * The host never sees the main process exit, so it can't "stop the container" or ignore the restart.
 *
 *  - exit code 75            -> restart requested by the updater/rollback  -> start again
 *  - exit code 0             -> intentional stop                          -> stop too
 *  - crash (non-zero/signal) -> start again with a short delay; if it crashes 5 times within a
 *                               minute we give up and exit so the host's own policy takes over
 *  - SIGTERM / SIGINT        -> forwarded to the child, then we exit (clean stop / redeploy)
 *  - child process can't be spawned at all (very restrictive hosts) -> runs the site in the
 *                               same process (old behaviour) instead of failing
 */
const { spawn } = require('child_process');
const path = require('path');

const RESTART_CODE = 75;
const MAX_CRASHES = 5;
const CRASH_WINDOW_MS = 60 * 1000;
const FORCE_KILL_MS = 10 * 1000;

function run(entryFile) {
  const entry = entryFile || path.join(__dirname, 'server.js');
  let child = null;
  let stopping = false;
  let everSpawned = false;
  let crashes = [];

  function inProcess(reason) {
    console.warn('[supervisor] Could not start a child process (' + reason + '). Running the site in this process instead.');
    process.env.UPDATER_INPROCESS = '1';
    require(entry);
  }

  function start() {
    let spawned = false;
    let handled = false;
    let c;
    try {
      c = spawn(process.execPath, [entry], {
        cwd: path.dirname(entry),
        stdio: 'inherit',
        env: Object.assign({}, process.env, { UPDATER_LAUNCHER: '1' })
      });
    } catch (err) {
      return everSpawned ? process.exit(1) : inProcess(err.message);
    }
    child = c;

    c.on('spawn', () => { spawned = true; everSpawned = true; });

    c.on('error', (err) => {
      if (handled) return;
      handled = true;
      child = null;
      if (!spawned && !everSpawned) return inProcess(err.message);
      console.error('[supervisor] Child process error:', err.message);
      process.exit(1);
    });

    c.on('exit', (code, signal) => {
      if (handled) return;
      handled = true;
      child = null;
      if (stopping) return process.exit(code || 0);

      if (code === RESTART_CODE) {
        console.log('[supervisor] Restart requested. Starting the new version...');
        crashes = [];
        return setTimeout(start, 700);
      }
      if (code === 0) return process.exit(0);

      const now = Date.now();
      crashes = crashes.filter(t => now - t < CRASH_WINDOW_MS);
      crashes.push(now);
      if (crashes.length >= MAX_CRASHES) {
        console.error('[supervisor] The website crashed ' + crashes.length + ' times within a minute. Giving up (exit code ' + (code || 1) + ').');
        return process.exit(code || 1);
      }
      const delay = Math.min(1000 * crashes.length, 5000);
      console.error('[supervisor] Website stopped unexpectedly (' + (signal || 'exit code ' + code) + '). Restarting in ' + delay / 1000 + 's...');
      setTimeout(start, delay);
    });
  }

  ['SIGTERM', 'SIGINT', 'SIGHUP'].forEach((sig) => {
    process.on(sig, () => {
      stopping = true;
      if (!child) return process.exit(0);
      try { child.kill(sig); } catch {}
      setTimeout(() => { try { child && child.kill('SIGKILL'); } catch {} process.exit(0); }, FORCE_KILL_MS).unref();
    });
  });

  start();
}

module.exports = { run, RESTART_CODE };
