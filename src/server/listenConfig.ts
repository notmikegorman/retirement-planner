/**
 * WHERE THE SERVER LISTENS — and why the default is so timid.
 *
 * This file exists because the app got packaged for someone else's machine.
 * Until then the bind address was a literal in the middle of `main()`, which
 * was fine while the only way to change it was to edit the source. A service
 * unit changes that: it hands the process an environment, and an environment
 * that is silently ignored is worse than one that is refused.
 *
 * TWO RULES, AND THEY PULL IN OPPOSITE DIRECTIONS.
 *
 * 1. THE DEFAULT MUST NOT MOVE. Unset FPLAN_HOST and unset FPLAN_PORT still
 *    mean 127.0.0.1:5599, exactly as the literal did. Every existing bookmark,
 *    every existing `npm start`, the vite proxy in vite.config.ts and the run
 *    cache's URL-free identity all assume it.
 *
 * 2. A SET VALUE MUST NOT BE QUIETLY DISCARDED. The old line was
 *        const port = Number(process.env.FPLAN_PORT) || 5599;
 *    and `Number('') === 0`, `Number('abc') === NaN`, both falsy — so
 *    FPLAN_PORT="8080 " (trailing space is fine, but a typo like "80800" or
 *    "sixty" is not) or a mis-typed unit file would put the server on 5599
 *    while the unit, the docs, the reverse proxy and the update script all
 *    said otherwise. That is the failure mode where everything looks correct
 *    and nothing works, and it costs an afternoon. An unset value still
 *    defaults; a set-but-unusable value now stops the boot and names itself.
 *
 * WHY FPLAN_HOST EXISTS AT ALL, given that the README tells you not to use it:
 * a container has to bind 0.0.0.0 or its published port reaches nothing, and a
 * reverse proxy on a different host has the same problem. Those are real
 * deployments. What is NOT acceptable is doing it by accident, so the one
 * thing this module adds beyond parsing is `exposureWarning()` — a paragraph
 * printed on every boot that is not loopback, saying in full what has just
 * been made reachable. The app has no authentication of any kind; anyone who
 * can open the port can read both people's dates of birth, every account
 * balance, the whole net-worth history, and can overwrite the profile or
 * delete a snapshot with one unauthenticated request. Editing a source literal
 * used to be the barrier. A printed paragraph is a worse barrier but a much
 * better warning, and it is the one that survives someone else installing this.
 */

export const DEFAULT_PORT = 5599;
export const DEFAULT_HOST = '127.0.0.1';

/** Thrown for a set-but-unusable FPLAN_PORT, so `main()` can print it bare. */
export class ListenConfigError extends Error {}

/**
 * FPLAN_PORT -> a port number.
 *
 * Unset, empty, or whitespace -> the default (an `EnvironmentFile` line of
 * `FPLAN_PORT=` arrives as the empty string, and that plainly means "I did not
 * choose one"). Anything else must be a whole number in 1..65535.
 *
 * Port 0 is rejected rather than passed through to the OS. Node would happily
 * bind an ephemeral port, but then nothing — not the boot banner's URL, not
 * the update script's quiet check, not the reverse proxy — could find it.
 */
export function resolvePort(raw: string | undefined): number {
  const value = (raw ?? '').trim();
  if (value === '') return DEFAULT_PORT;
  if (!/^\d+$/.test(value)) {
    throw new ListenConfigError(
      `FPLAN_PORT is "${raw}", which is not a number. Set it to a port between 1 and 65535, or unset it for ${DEFAULT_PORT}.`,
    );
  }
  const port = Number(value);
  if (port < 1 || port > 65535) {
    throw new ListenConfigError(
      `FPLAN_PORT is ${port}, which is outside 1..65535. Unset it for ${DEFAULT_PORT}.`,
    );
  }
  return port;
}

/** FPLAN_HOST -> a bind address. Unset or empty keeps the loopback default. */
export function resolveHost(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  return value === '' ? DEFAULT_HOST : value;
}

/**
 * Whether a bind address is reachable only from this machine.
 *
 * The whole 127.0.0.0/8 block counts, not just 127.0.0.1 — some setups use
 * 127.0.0.2 to separate services. `localhost` counts because it resolves to
 * one of those (or to ::1). Everything else, including an empty-string bind
 * and `0.0.0.0`, is treated as exposed; guessing generously here would be
 * guessing in the direction that hurts.
 */
export function isLoopback(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * The URL to print and to open a browser at. `0.0.0.0` and `::` are bind
 * wildcards, not addresses you can visit, so the banner would otherwise print
 * a link that goes nowhere on some browsers.
 */
export function displayHost(host: string): string {
  const h = host.trim();
  if (h === '0.0.0.0' || h === '' || h === '::' || h === '[::]') return DEFAULT_HOST;
  return h;
}

/**
 * The paragraph printed when the bind address is not loopback — null when it
 * is, so the ordinary case stays silent.
 *
 * Deliberately long and deliberately specific. "Warning: listening on all
 * interfaces" is a line people scroll past; a list of what a stranger can now
 * read is not. See the security section of README.md, which says the same
 * thing at more length.
 */
export function exposureWarning(host: string): string | null {
  if (isLoopback(host)) return null;
  return [
    '',
    '  ############################################################',
    `  ##  THIS SERVER IS BOUND TO ${host} AND HAS NO PASSWORD.`,
    '  ############################################################',
    '',
    '  There is no login, no token, and no access control of any kind.',
    '  Anyone who can reach this port can, with a single request:',
    '',
    '    - read both people\'s dates of birth, Social Security figures,',
    '      salary, every account balance and holding, the full expense',
    '      budget, and the entire net-worth history;',
    '    - overwrite the profile (PUT /api/profile — no undo, no history);',
    '    - delete a net-worth snapshot (DELETE /api/networth/:id — those rows',
    '      record prices from a day that has passed and cannot be recreated);',
    '    - start unlimited simulations, each of which spawns worker threads.',
    '',
    '  If you meant to do this, put an authenticating reverse proxy in front',
    '  of it and firewall this port. If you did not, unset FPLAN_HOST.',
    '',
  ].join('\n');
}
