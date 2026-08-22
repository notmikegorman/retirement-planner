/**
 * The service definitions, rendered rather than copied.
 *
 * WHY A RENDERER AND NOT TWO TEMPLATE FILES WITH `sed` OVER THEM. Every value
 * that goes into a unit file is a path chosen at install time, and paths break
 * templating: a home directory with a space in it (`/Users/Alex Smith/...`,
 * entirely normal on macOS) turns an unquoted `Environment=` line into two
 * environment variables, and an `&` in a path turns a plist into invalid XML
 * that launchd rejects with a message about nothing in particular. Rendering
 * through functions puts the quoting in one place where a test can hold it
 * still — see tests/scripts/serviceTemplates.test.ts, which installs nothing
 * and asserts on the text.
 *
 * WHAT BOTH DEFINITIONS MUST GET RIGHT, and what happens when they do not:
 *
 *   WorkingDirectory = the checkout. NOT COSMETIC. Every simulation runs in a
 *   worker thread spawned with `execArgv: ['--import', 'tsx']`, and Node
 *   resolves that bare `tsx` specifier against the process's CURRENT WORKING
 *   DIRECTORY, not against the file that asked for it. Start the server from
 *   anywhere else and it boots perfectly, serves the UI, reads and writes the
 *   data folder — and then every Monte Carlo run, every historical run, every
 *   snapshot score and every search fails with ERR_MODULE_NOT_FOUND naming a
 *   directory you have never heard of. `npm start` hides this because npm
 *   always runs scripts from the package root; a service unit does not.
 *
 *   PATH must contain the node binary's directory. The launcher is
 *   node_modules/.bin/tsx, a symlink to a .mjs whose shebang is
 *   `#!/usr/bin/env node`. systemd gives a user unit a minimal PATH and
 *   launchd gives an agent even less, so a node installed by nvm, fnm, asdf or
 *   Homebrew — which is to say almost every node — is simply not found.
 *
 *   FPLAN_NO_OPEN=1. Without it the server tries to spawn a browser at boot.
 *   On a headless Linux box that means shelling out to an xdg-open that is not
 *   there; the failure is swallowed, but a service that gropes for a desktop
 *   is noise in a place where noise is expensive.
 *
 *   Restart on failure, not always. `Restart=always` and an unconditional
 *   launchd `KeepAlive` both fight `systemctl stop` and `launchctl unload`,
 *   and — with FPLAN_AUTO_UPDATE on — turn a bad commit into an infinite
 *   rebuild loop rather than a stopped service with a log you can read.
 */

import { pathToFileURL } from 'node:url';

export interface ServiceConfig {
  /** systemd unit stem and the tail of the launchd label. */
  label: string;
  /** The checkout. Becomes WorkingDirectory — see the note above. */
  appDir: string;
  /** FPLAN_DATA_DIR. Always set explicitly; see resolveDefaults(). */
  dataDir: string;
  port: number;
  /** Bind address. The installer only ever writes a loopback one. */
  host: string;
  /** Absolute path to the node binary, whose directory goes on PATH. */
  nodeBin: string;
  /** Absolute path to scripts/service-run.sh. */
  runScript: string;
  /**
   * Where stdout and stderr go. launchd only — systemd sends a user unit to
   * the journal, which rotates itself and is read with `journalctl --user`.
   */
  logFile: string;
  /** FPLAN_AUTO_UPDATE. Off unless the installer was asked for it. */
  autoUpdate: boolean;
}

export const DEFAULT_LABEL = 'finance-planner';

/** `finance-planner.service`, under ~/.config/systemd/user/. */
export function systemdUnitName(label: string): string {
  return `${label}.service`;
}

/** launchd wants reverse-DNS; the hyphen in the stem is legal and kept. */
export function launchdLabel(label: string): string {
  return `com.${label}.server`;
}

export function launchdPlistName(label: string): string {
  return `${launchdLabel(label)}.plist`;
}

/**
 * Quote a value for systemd's `Environment=` / `ExecStart=`.
 *
 * systemd splits unquoted values on whitespace, so a path with a space in it
 * silently becomes two arguments. Inside double quotes only backslash and
 * double quote need escaping.
 */
export function systemdQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** XML text escaping for the plist. `&` in a path is the realistic one. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** The environment both platforms hand the server. One list, one truth. */
export function serviceEnvironment(cfg: ServiceConfig): Array<[string, string]> {
  const nodeDir = cfg.nodeBin.replace(/\/[^/]*$/, '');
  return [
    ['FPLAN_DATA_DIR', cfg.dataDir],
    ['FPLAN_PORT', String(cfg.port)],
    ['FPLAN_HOST', cfg.host],
    ['FPLAN_NO_OPEN', '1'],
    ['FPLAN_APP_DIR', cfg.appDir],
    ['FPLAN_AUTO_UPDATE', cfg.autoUpdate ? '1' : '0'],
    ['PATH', `${nodeDir}:/usr/local/bin:/usr/bin:/bin`],
  ];
}

export function renderSystemdUnit(cfg: ServiceConfig): string {
  const env = serviceEnvironment(cfg)
    .map(([k, v]) => `Environment=${systemdQuote(`${k}=${v}`)}`)
    .join('\n');
  return `[Unit]
Description=Finance Planner (local-first retirement planner)
Documentation=file://${cfg.appDir}/README.md
After=network-online.target

[Service]
Type=simple
# NOT COSMETIC: simulation workers boot tsx by bare specifier, which Node
# resolves against the working directory. Point this anywhere else and the app
# starts, serves, and then fails every single run. See scripts/lib/service.ts.
WorkingDirectory=${systemdQuote(cfg.appDir)}
ExecStart=${systemdQuote(cfg.runScript)}
${env}
# on-failure, not always: 'always' fights systemctl stop, and with
# FPLAN_AUTO_UPDATE=1 it turns a bad commit into a rebuild loop.
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes

[Install]
WantedBy=default.target
`;
}

export function renderLaunchdPlist(cfg: ServiceConfig): string {
  const env = serviceEnvironment(cfg)
    .map(([k, v]) => `    <key>${escapeXml(k)}</key>\n    <string>${escapeXml(v)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(launchdLabel(cfg.label))}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(cfg.runScript)}</string>
  </array>
  <!-- Simulation workers resolve the tsx loader against the working directory;
       anywhere but the checkout and every run fails. -->
  <key>WorkingDirectory</key>
  <string>${escapeXml(cfg.appDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <!-- Restart on a crash, but let a clean stop stay stopped. -->
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(cfg.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(cfg.logFile)}</string>
</dict>
</plist>
`;
}

// ---------------------------------------------------------------------------
// CLI: `tsx scripts/lib/service.ts render <systemd|launchd> --app-dir ... `
// The installer shells out to this and redirects stdout into the unit file, so
// the shell never does any quoting of its own.
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq > -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      out[arg.slice(2)] = argv[i + 1] ?? '';
      i += 1;
    }
  }
  return out;
}

export function configFromArgs(args: Record<string, string>): ServiceConfig {
  const required = (name: string): string => {
    const value = args[name];
    if (!value) throw new Error(`Missing --${name}`);
    return value;
  };
  return {
    label: args.label || DEFAULT_LABEL,
    appDir: required('app-dir'),
    dataDir: required('data-dir'),
    port: Number(required('port')),
    host: args.host || '127.0.0.1',
    nodeBin: required('node-bin'),
    runScript: required('run-script'),
    logFile: args['log-file'] || '/dev/null',
    autoUpdate: args['auto-update'] === '1',
  };
}

// True only when this file IS the program, so importing it from a test (or
// from another module) never runs the CLI.
function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  const [command, platform, ...rest] = process.argv.slice(2);
  if (command !== 'render' || (platform !== 'systemd' && platform !== 'launchd')) {
    console.error('usage: service.ts render <systemd|launchd> --app-dir DIR --data-dir DIR --port N --node-bin PATH --run-script PATH [--host H] [--log-file PATH] [--label NAME] [--auto-update 0|1]');
    process.exit(2);
  }
  const cfg = configFromArgs(parseArgs(rest));
  process.stdout.write(platform === 'systemd' ? renderSystemdUnit(cfg) : renderLaunchdPlist(cfg));
}
