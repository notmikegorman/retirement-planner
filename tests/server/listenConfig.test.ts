/**
 * WHERE THE SERVER LISTENS (src/server/listenConfig.ts).
 *
 * Two properties, and they are in tension, which is why they are pinned
 * together rather than assumed:
 *
 * 1. THE DEFAULT HAS NOT MOVED. Before packaging, the bind was a literal pair
 *    in the middle of main() — 127.0.0.1:5599. Every bookmark, the vite dev
 *    proxy, and both install scripts assume that is still what "unset" means.
 * 2. A SET VALUE IS EITHER USED OR REFUSED, NEVER DISCARDED. The line this
 *    replaced was `Number(process.env.FPLAN_PORT) || 5599`, and both `''` and
 *    `'abc'` are falsy after Number(), so a typo in a unit file put the server
 *    on 5599 while the unit, the docs, the update script and any reverse proxy
 *    all said something else. That is the failure where everything looks right
 *    and nothing works.
 *
 * The exposure warning is pinned too, because it is the only thing standing
 * between someone setting FPLAN_HOST=0.0.0.0 and publishing an unauthenticated
 * financial dossier. A test that lets it silently become an empty string is
 * worse than no test.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  ListenConfigError,
  displayHost,
  exposureWarning,
  isLoopback,
  resolveHost,
  resolvePort,
} from '../../src/server/listenConfig';

describe('resolvePort', () => {
  it('defaults to 5599 when unset', () => {
    expect(resolvePort(undefined)).toBe(DEFAULT_PORT);
    expect(DEFAULT_PORT).toBe(5599);
  });

  it('treats empty and whitespace as unset', () => {
    // `EnvironmentFile` with a bare `FPLAN_PORT=` line delivers the empty
    // string, and that plainly means "I did not choose one".
    expect(resolvePort('')).toBe(5599);
    expect(resolvePort('   ')).toBe(5599);
  });

  it('uses a valid port', () => {
    expect(resolvePort('8080')).toBe(8080);
    expect(resolvePort(' 8080 ')).toBe(8080);
    expect(resolvePort('1')).toBe(1);
    expect(resolvePort('65535')).toBe(65535);
  });

  it('REFUSES a value it cannot use rather than silently falling back', () => {
    // This is the whole reason the module exists. Each of these used to
    // produce 5599 with no message at all.
    for (const bad of ['abc', '80800', '0', '-1', '5599x', '55.9']) {
      expect(() => resolvePort(bad), bad).toThrow(ListenConfigError);
    }
  });

  it('names the offending value in the message', () => {
    expect(() => resolvePort('sixty')).toThrow(/FPLAN_PORT is "sixty"/);
    expect(() => resolvePort('99999')).toThrow(/outside 1\.\.65535/);
  });
});

describe('resolveHost', () => {
  it('defaults to loopback', () => {
    expect(resolveHost(undefined)).toBe(DEFAULT_HOST);
    expect(resolveHost('')).toBe(DEFAULT_HOST);
    expect(DEFAULT_HOST).toBe('127.0.0.1');
  });

  it('passes through anything else verbatim', () => {
    expect(resolveHost('0.0.0.0')).toBe('0.0.0.0');
    expect(resolveHost(' ::1 ')).toBe('::1');
  });
});

describe('isLoopback', () => {
  it('accepts the whole 127.0.0.0/8 block, localhost, and ::1', () => {
    for (const host of ['127.0.0.1', '127.0.0.2', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]']) {
      expect(isLoopback(host), host).toBe(true);
    }
  });

  it('treats everything else as exposed, including the wildcards', () => {
    // Guessing generously here would be guessing in the direction that hurts:
    // 0.0.0.0 is every interface, and an empty bind is the same thing.
    for (const host of ['0.0.0.0', '', '::', '192.168.1.10', '10.0.0.4', 'planner.example.com']) {
      expect(isLoopback(host), host).toBe(false);
    }
  });
});

describe('displayHost', () => {
  it('turns bind wildcards into an address a browser can actually open', () => {
    expect(displayHost('0.0.0.0')).toBe('127.0.0.1');
    expect(displayHost('::')).toBe('127.0.0.1');
    expect(displayHost('')).toBe('127.0.0.1');
  });

  it('leaves a real address alone', () => {
    expect(displayHost('127.0.0.1')).toBe('127.0.0.1');
    expect(displayHost('192.168.1.10')).toBe('192.168.1.10');
  });
});

describe('exposureWarning', () => {
  it('says nothing for a loopback bind — the ordinary case stays quiet', () => {
    expect(exposureWarning('127.0.0.1')).toBeNull();
    expect(exposureWarning('localhost')).toBeNull();
  });

  it('names the address and what a stranger can now do with it', () => {
    const warning = exposureWarning('0.0.0.0');
    expect(warning).not.toBeNull();
    const text = warning as string;
    expect(text).toContain('0.0.0.0');
    expect(text).toContain('NO PASSWORD');
    // The specifics are the point. "Warning: listening on all interfaces" is a
    // line people scroll past; a list of what is now readable is not.
    expect(text).toContain('dates of birth');
    expect(text).toContain('PUT /api/profile');
    expect(text).toContain('DELETE /api/networth/:id');
    expect(text).toContain('unset FPLAN_HOST');
  });
});
