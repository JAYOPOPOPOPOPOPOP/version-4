Start: node server.js | The first registered user becomes the Admin

=== HOW TO UPDATE (v1.1.0+) ===
1. Create the new version and increase the "version" in package.json (for example, to 1.2.0). Then zip the entire folder.
2. Admin Panel -> Update -> choose the zip -> "Check zip" -> "Apply update".
3. Only the code changes. data/, uploads/, public/uploads/ and logins stay safe.
   The data/ and uploads/ folders inside the zip are ignored.
4. A backup is created in data/backups/ before every update (the last 3 are kept). If something goes wrong, use Rollback on the Update page.
5. Logins last for 1 year. On cloud hosts (Render/Railway), set the JWT_SECRET environment variable
   (any long random text) so that users stay logged in even after a redeploy.
First time only: copy the data/ and public/uploads/ folders from your old website into this new folder, then start the server.

=== HOSTING (Railway / Render / VPS / Pterodactyl / any panel) ===
- Any start command works: "node server.js", "npm start" or "node launcher.js". server.js now supervises itself
  (supervisor.js): it runs the real site as a child process and starts it again after every update or rollback,
  so the host never sees the main process exit. No extra setup is needed.
- If you already use pm2 / systemd / Docker restart policies and do not want the built-in supervisor,
  set the environment variable NO_SUPERVISOR=1 (then the platform's own restart is used).
- IMPORTANT for the first time: the update that installs v1.2.1 is still restarted by the OLD code, so restart the site
  once manually (host panel / redeploy) after applying it. From then on every update restarts automatically.
- Deploy this version normally once (git push / redeploy).
- Cloud disks are temporary. A normal redeploy from Git replaces code updated through the zip updater,
  and data/ is lost unless you attach a persistent volume to it. For permanent changes, also push the same code to your repository.
- Backups and update history can be deleted from Admin Panel -> Update (Delete button next to each item).

=== LOST ADMIN ACCESS? (recovery) ===
Set the environment variable ADMIN_RECOVERY_EMAIL=<your account email> on the host (Railway: Variables tab) and restart/redeploy.
On startup that account becomes admin again (see the log line starting with [recovery]). Log out and log in again,
then DELETE the variable. An admin can no longer demote or ban themselves, and the last active admin cannot be removed.

=== v1.2.6 (speed) ===
- Creating pages / categories / products is now instant: the database is kept in memory and saved to disk in the background
  (data is also flushed on restart/update/stop). Big photos are shrunk in the browser before upload.

=== v1.3.0 (modules) ===
- Admin Panel -> Modules -> "Add Module": upload a module .zip. Each module can be enabled / disabled / deleted, moved up/down,
  resized (1/4, 1/3, 1/2, 2/3, full width) and retitled. Modules appear on the home page (below the hero) in that order.
- Modules live in data/modules/<id>/ (code) and data/module-data/<id>/ (their own saved data), so website updates NEVER touch them,
  and modules can not overwrite core files. Uploading the same module again = upgrade (order, width, data are kept).
- Each module is shown inside its own Shadow DOM box: its CSS can not break the site or other modules, and a broken module is skipped.
- Module zip layout:  module.json (required: id, name, version) + optional widget.js / widget.css / widget.html / server.js / assets/
  * widget.js : NXModules.register('<id>', { mount(el, ctx) { ctx.api('/route').then(...) } })
  * server.js : module.exports = function (api) { api.get('/route', (req, res, c) => api.json(res, 200, {...})); }
                api.db.sales() / products() / categories() (read-only copies), api.storage.get/set(key), api.post(..., {admin:true})
                -> served at /api/m/<id>/route
- SECURITY: a module's server.js runs with full server access. Upload only modules you made or trust.
- Two examples are included in sample-modules/ (top-buys, monthly-sells).

=== v1.3.1 ===
- Fix: modules were hidden behind the fixed background layer on the home page. The module area now sits above it.

=== v1.4.0 (module settings) ===
- Modules can declare editable settings in module.json ("settings": [{ key, label, type, default, min, max }]).
  Types: number | text | textarea | checkbox | select. The admin edits them ONLY in Admin -> Modules -> "✏️ Edit".
  A module's server.js reads them with api.settings(). Visitors (and the home page) can never change them.

=== v1.4.1 ===
- Fix: module admin/loader scripts are never cached by the browser (an old cached script hid the new Edit button).
