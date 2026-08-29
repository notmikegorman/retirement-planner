/**
 * Backend selection (src/ui/api.ts, resolveBackendMode): the whole dual-boot
 * switch in one pure function.
 *
 * The properties that matter, each pinned because losing it quietly would
 * change which backend a session runs on — the one thing that must never be
 * ambient:
 *
 *   - HTTP is the default. Until Phase 7 flips the shipped default, an
 *     unadorned load behaves byte-for-byte as the app always has.
 *   - `?backend=` is the explicit switch and it WINS over everything.
 *   - The choice is remembered only when the URL made it: the router rewrites
 *     URLs on navigation, so without memory a reload mid-session would fall
 *     back to HTTP silently — a mode switch nobody asked for.
 *   - `?backend=http` is the escape hatch: it selects HTTP and FORGETS the
 *     remembered 'local', so the revert costs one query parameter, not a
 *     localStorage safari.
 */
import { describe, expect, it } from 'vitest';
import { resolveBackendMode } from '../../src/ui/api';

const decide = (
  queryBackend: string | null,
  stored: string | null = null,
  buildDefault: string | undefined = undefined,
) => resolveBackendMode({ queryBackend, stored, buildDefault });

describe('resolveBackendMode', () => {
  it('defaults to HTTP: no query, nothing stored, no build flag', () => {
    expect(decide(null)).toEqual({ mode: 'http', remember: null });
  });

  it('?backend=local selects local and remembers it', () => {
    expect(decide('local')).toEqual({ mode: 'local', remember: 'local' });
  });

  it('?backend=http selects HTTP and clears the memory — the escape hatch', () => {
    expect(decide('http', 'local')).toEqual({ mode: 'http', remember: 'http' });
  });

  it('a remembered local survives a reload whose URL names no backend', () => {
    expect(decide(null, 'local')).toEqual({ mode: 'local', remember: null });
  });

  it('the URL beats the memory in both directions', () => {
    expect(decide('local', null).mode).toBe('local');
    expect(decide('http', 'local').mode).toBe('http');
  });

  it('a build default of local applies only when URL and memory are silent', () => {
    expect(decide(null, null, 'local')).toEqual({ mode: 'local', remember: null });
    expect(decide('http', null, 'local').mode).toBe('http');
  });

  it('garbage in the query or the store is ignored, never guessed at', () => {
    expect(decide('LOCAL')).toEqual({ mode: 'http', remember: null });
    expect(decide('yes', 'please')).toEqual({ mode: 'http', remember: null });
  });
});
