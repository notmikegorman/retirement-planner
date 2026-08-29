/**
 * A tiny static file server for the browser lane, bound to 127.0.0.1 on an
 * OS-ASSIGNED EPHEMERAL PORT (listen(0)).
 *
 * Why not just reuse the Vite dev server: the dev server holds :5174, and on
 * this machine :5174/:5599 may be a LIVE app bound to the real data folder.
 * The lane must be structurally unable to collide with it — an ephemeral port
 * can never be the dev port, and two parallel lane runs can never fight over a
 * fixed one. Why not fixed-but-obscure: "obscure" ports rot into collisions
 * exactly when CI starts running two jobs on one box.
 *
 * Serves the BUILT harness only. Correct MIME types matter here: Chromium
 * refuses to run a module script (the worker included) served as text/plain.
 */
import { createServer, type Server } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
};

export interface StaticServer {
  port: number;
  origin: string;
  close(): Promise<void>;
}

export interface StaticServerOptions {
  /**
   * Serve index.html for extensionless paths that match no file — the SPA
   * fallback the Fastify server provides for the built UI. The dual-stack
   * drive needs it because the app's router pushStates real paths
   * (/workbench), and a reload there must boot the app, not 404. The harness
   * pages don't ask for it, so their 404s stay honest.
   */
  spaFallback?: boolean;
  /**
   * GITHUB PAGES EMULATION (Phase 7's walkthrough gate). A project site
   * serves under /<repo>/, so with basePath: '/retirement-planner':
   *   - files resolve only under the prefix; the bare prefix 301s to
   *     prefix + '/' exactly as Pages does;
   *   - anything outside the prefix is an honest 404 (the real host would
   *     serve the USER site there — either way, not this app);
   *   - with pages404, a miss under the prefix serves 404.html from the
   *     dist root WITH STATUS 404 — Pages' behaviour, and the entire
   *     mechanism behind deep-link reloads (404.html is a copy of
   *     index.html, so the "error page" boots the app on the deep path).
   * Deliberately never combined with spaFallback: the walkthrough must
   * prove deep links survive on the 404 trick alone, because that is all
   * the real host provides.
   */
  basePath?: string;
  pages404?: boolean;
}

export async function serveStatic(
  rootDir: string,
  opts: StaticServerOptions = {},
): Promise<StaticServer> {
  const root = path.resolve(rootDir);

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let pathname = url.pathname;
      if (opts.basePath !== undefined) {
        if (pathname === opts.basePath) {
          // Pages 301s the bare project path to the trailing-slash form.
          res.writeHead(301, { location: `${opts.basePath}/` }).end();
          return;
        }
        if (!pathname.startsWith(`${opts.basePath}/`)) {
          res.writeHead(404).end();
          return;
        }
        pathname = pathname.slice(opts.basePath.length);
      }
      const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
      const file = path.resolve(root, rel);
      // Resolve-then-prefix-check so an escape attempt (/../..) reads nothing.
      if (file !== root && !file.startsWith(root + path.sep)) {
        res.writeHead(403).end();
        return;
      }
      try {
        const body = await fs.readFile(file);
        res
          .writeHead(200, {
            'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
          })
          .end(body);
      } catch {
        if (opts.pages404) {
          try {
            const errorPage = await fs.readFile(path.join(root, '404.html'));
            // Pages serves the custom 404 page's BYTES with the 404 STATUS —
            // both halves matter: the body is what boots the app on a deep
            // link, the status is the proof no real file answered.
            res.writeHead(404, { 'content-type': MIME['.html'] }).end(errorPage);
            return;
          } catch {
            // No 404.html: fall through to the bare 404.
          }
        }
        if (opts.spaFallback && path.extname(file) === '') {
          try {
            const index = await fs.readFile(path.join(root, 'index.html'));
            res.writeHead(200, { 'content-type': MIME['.html'] }).end(index);
            return;
          } catch {
            // No index.html either: fall through to the honest 404.
          }
        }
        res.writeHead(404).end();
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('static server bound to a pipe instead of a TCP port');
  }
  return {
    port: address.port,
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
