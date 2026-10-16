/* Kept for compatibility with "npm start" / "node launcher.js".
 * The restart logic now lives in supervisor.js, which server.js also uses on its own,
 * so the site restarts after an update no matter which start command the host uses.
 */
require('./supervisor').run(require('path').join(__dirname, 'server.js'));
