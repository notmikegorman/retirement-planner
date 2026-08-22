/**
 * The dev server: everything reloads, nothing is restarted by hand.
 *
 * WHY THIS EXISTS. `npm run preview` is a PRODUCTION serve — it builds the UI
 * once into dist/ui and Fastify serves those static files. Nothing watches
 * anything, so a UI edit needs a rebuild and an engine edit needs a restart.
 * That is how a server ended up serving engine 1.10.0 for a whole session while
 * the committed code was 1.11.0, showing a new interface computing old numbers
 * — the single most expensive failure mode this project has, because nothing on
 * screen says the numbers are stale.
 *
 * Two processes, because they watch different things:
 *   - vite       : the UI, hot-reloaded in place, no refresh needed
 *   - tsx watch  : the server, which restarts itself on any src/server,
 *                  src/engine, src/shared or src/tax change
 *
 * You browse VITE's port. It proxies /api to the Fastify port (see
 * vite.config.ts), and the UI only ever uses relative /api paths, so a single
 * origin serves both and no CORS or base-URL config is involved.
 *
 * Spawned here rather than with `&` in an npm script so that both children die
 * with the parent. A backgrounded npm script orphans the survivor, which then
 * holds the port and produces exactly the stale-server problem again, except
 * now invisible because the thing you restarted is not the thing still running.
 */
import { spawn } from 'node:child_process';

const children = [];

function run(name, command, args, env) {
  const child = spawn(command, args, {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, ...env },
  });
  child.on('exit', (code, signal) => {
    // If either half dies the pair is useless — a live UI talking to a dead API
    // looks like a broken app, and a live API with no UI looks like nothing at
    // all. Take the whole thing down so the failure is visible immediately.
    if (!shuttingDown) {
      console.error(`\n[dev] ${name} exited (${signal ?? code}); shutting down.`);
      shutdown();
    }
  });
  children.push({ name, child });
  return child;
}

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
  // A child that ignores SIGTERM still holds the port, which is the thing that
  // makes the next start mysteriously serve old code.
  setTimeout(() => {
    for (const { child } of children) child.kill('SIGKILL');
    process.exit(0);
  }, 2000).unref();
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, shutdown);

run('api', 'npx', ['tsx', 'watch', 'src/server/server.ts'], {
  FPLAN_NO_OPEN: '1',
  // Tells the API port to redirect UI requests to the live vite port instead of
  // serving the frozen dist/ui bundle — see the Static UI block in server.ts.
  FPLAN_VITE_URL: 'http://localhost:5174',
});
run('ui', 'npx', ['vite'], {});

console.log(
  '\n[dev] API on :5599 (tsx watch — restarts on engine/server edits)\n' +
    '[dev] UI  on :5174 (vite — hot reload, proxies /api to :5599)\n' +
    '[dev] Open the UI port. Engine changes take effect on the next run you trigger.\n',
);
