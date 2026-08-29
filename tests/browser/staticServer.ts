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

export async function serveStatic(rootDir: string): Promise<StaticServer> {
  const root = path.resolve(rootDir);

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
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
