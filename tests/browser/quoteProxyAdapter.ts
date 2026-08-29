/**
 * The ~10-line node adapter that mounts the QUOTE PROXY's real handler module
 * (workers/quote-proxy/handler.ts) on an ephemeral local port — how the
 * browser lane e2e-tests the Worker without any Cloudflare machinery. The
 * handler is a plain (Request, env) → Response function; this file only
 * translates node's http shapes to and from the fetch shapes. wrangler runs
 * the SAME module at deploy time.
 */
import { createServer, type Server } from 'node:http';
import { handleQuoteRequest, type QuoteProxyEnv } from '../../workers/quote-proxy/handler';

export interface MountedProxy {
  origin: string;
  /** Every request the proxy saw: its query and the page origin it carried. */
  seen: { url: string; origin: string | undefined }[];
  close(): Promise<void>;
}

export async function mountQuoteProxy(env: QuoteProxyEnv): Promise<MountedProxy> {
  const seen: MountedProxy['seen'] = [];
  const server: Server = createServer((req, res) => {
    void (async () => {
      seen.push({ url: req.url ?? '', origin: req.headers.origin });
      const response = await handleQuoteRequest(
        new Request(`http://127.0.0.1${req.url ?? '/'}`, {
          method: req.method,
          headers: req.headers.origin === undefined ? {} : { origin: req.headers.origin },
        }),
        env,
      );
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      res.end(Buffer.from(await response.arrayBuffer()));
    })().catch(() => res.writeHead(500).end());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no TCP port assigned');
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    seen,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
