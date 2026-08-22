/**
 * THE SERVICE DEFINITIONS (scripts/lib/service.ts).
 *
 * A unit file is not code anyone runs in a loop, so nothing catches a mistake
 * in one except the machine failing to start weeks later, usually after a
 * reboot nobody was watching. These tests hold still the handful of lines that
 * are load-bearing, and the reason each one is:
 *
 *   WorkingDirectory — simulation workers spawn with `--import tsx`, and Node
 *   resolves that bare specifier against the WORKING DIRECTORY. Get this wrong
 *   and the app starts, serves its interface, reads and writes the data folder,
 *   and fails every single simulation with a module-not-found error naming a
 *   directory nobody chose. It is the most expensive line in either file
 *   because the failure looks like nothing at all until you press Run.
 *
 *   PATH — the launcher is node_modules/.bin/tsx, whose shebang is
 *   `#!/usr/bin/env node`. A service gets a minimal PATH, and an nvm/fnm/asdf
 *   node is not on it.
 *
 *   FPLAN_NO_OPEN and FPLAN_DATA_DIR — without the first, a headless service
 *   shells out looking for a browser. Without the second, the data folder is
 *   `os.homedir()/finance-planner-data` where homedir is whatever the service
 *   manager decided HOME means, which is not reliably anything.
 *
 *   FPLAN_AUTO_UPDATE — must default to 0. It is opt-in for good reasons that
 *   scripts/service-run.sh sets out at length.
 *
 * And the quoting, which is the other half: a home directory with a space in
 * it is ordinary on macOS, and an unquoted systemd `Environment=` line splits
 * on it silently.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LABEL,
  type ServiceConfig,
  configFromArgs,
  escapeXml,
  launchdLabel,
  parseArgs,
  renderLaunchdPlist,
  renderSystemdUnit,
  serviceEnvironment,
  systemdQuote,
  systemdUnitName,
} from '../../scripts/lib/service';

const cfg: ServiceConfig = {
  label: DEFAULT_LABEL,
  appDir: '/opt/finance-planner',
  dataDir: '/var/lib/finance-planner',
  port: 5599,
  host: '127.0.0.1',
  nodeBin: '/usr/local/bin/node',
  runScript: '/opt/finance-planner/scripts/service-run.sh',
  logFile: '/home/alex/.local/state/finance-planner/finance-planner.log',
  autoUpdate: false,
};

describe('names', () => {
  it('are the ones the shell helpers look for', () => {
    expect(systemdUnitName('finance-planner')).toBe('finance-planner.service');
    expect(launchdLabel('finance-planner')).toBe('com.finance-planner.server');
  });
});

describe('serviceEnvironment', () => {
  it('puts the node binary\'s own directory first on PATH', () => {
    const env = new Map(serviceEnvironment(cfg));
    expect(env.get('PATH')).toBe('/usr/local/bin:/usr/local/bin:/usr/bin:/bin');
    const nvm = new Map(serviceEnvironment({ ...cfg, nodeBin: '/home/alex/.nvm/versions/node/v22.11.0/bin/node' }));
    expect(nvm.get('PATH')).toMatch(/^\/home\/alex\/\.nvm\/versions\/node\/v22\.11\.0\/bin:/);
  });

  it('sets the data folder explicitly rather than leaving it to homedir', () => {
    expect(new Map(serviceEnvironment(cfg)).get('FPLAN_DATA_DIR')).toBe('/var/lib/finance-planner');
  });

  it('disables the browser open', () => {
    expect(new Map(serviceEnvironment(cfg)).get('FPLAN_NO_OPEN')).toBe('1');
  });

  it('defaults auto-update OFF, and carries it only when asked', () => {
    expect(new Map(serviceEnvironment(cfg)).get('FPLAN_AUTO_UPDATE')).toBe('0');
    expect(new Map(serviceEnvironment({ ...cfg, autoUpdate: true })).get('FPLAN_AUTO_UPDATE')).toBe('1');
  });

  it('never sets FPLAN_VITE_URL', () => {
    // Setting it replaces static serving entirely with a 307 to a vite dev
    // server that is not running in production — the UI would simply vanish.
    expect(serviceEnvironment(cfg).map(([k]) => k)).not.toContain('FPLAN_VITE_URL');
  });
});

describe('renderSystemdUnit', () => {
  const unit = renderSystemdUnit(cfg);

  it('sets WorkingDirectory to the checkout', () => {
    expect(unit).toContain('WorkingDirectory="/opt/finance-planner"');
  });

  it('execs the wrapper, not node directly', () => {
    expect(unit).toContain('ExecStart="/opt/finance-planner/scripts/service-run.sh"');
  });

  it('restarts on failure but not always', () => {
    // Restart=always fights `systemctl stop`, and with auto-update on it turns
    // a bad commit into a rebuild loop instead of a stopped service.
    expect(unit).toContain('Restart=on-failure');
    expect(unit).not.toContain('Restart=always');
  });

  it('starts at boot for a lingering user', () => {
    expect(unit).toContain('WantedBy=default.target');
  });

  it('quotes every environment value', () => {
    for (const line of unit.split('\n').filter((l) => l.startsWith('Environment='))) {
      expect(line, line).toMatch(/^Environment="[^"]*"$/);
    }
  });

  it('survives a path with a space in it', () => {
    const spaced = renderSystemdUnit({
      ...cfg,
      appDir: '/Users/Alex Smith/finance planner',
      dataDir: '/Users/Alex Smith/planner data',
    });
    expect(spaced).toContain('WorkingDirectory="/Users/Alex Smith/finance planner"');
    expect(spaced).toContain('Environment="FPLAN_DATA_DIR=/Users/Alex Smith/planner data"');
  });

  it('escapes a quote rather than ending the value early', () => {
    expect(systemdQuote('a"b')).toBe('"a\\"b"');
    expect(systemdQuote('a\\b')).toBe('"a\\\\b"');
  });
});

describe('renderLaunchdPlist', () => {
  const plist = renderLaunchdPlist(cfg);

  it('is a plist launchd will parse', () => {
    expect(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(plist).toContain('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"');
    expect(plist.trimEnd().endsWith('</plist>')).toBe(true);
  });

  it('names itself in reverse-DNS and runs the wrapper', () => {
    expect(plist).toContain('<string>com.finance-planner.server</string>');
    expect(plist).toContain('<string>/opt/finance-planner/scripts/service-run.sh</string>');
  });

  it('sets the working directory for the same reason systemd does', () => {
    expect(plist).toContain('<key>WorkingDirectory</key>\n  <string>/opt/finance-planner</string>');
  });

  it('runs at load and restarts only after a failure', () => {
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(plist).toContain('<key>SuccessfulExit</key>\n    <false/>');
  });

  it('sends output to the configured log file', () => {
    expect(plist).toContain('<key>StandardOutPath</key>');
    expect(plist).toContain(cfg.logFile);
  });

  it('escapes XML so an ampersand in a path cannot break the file', () => {
    const odd = renderLaunchdPlist({ ...cfg, dataDir: '/Users/a&b/<data>' });
    expect(odd).toContain('/Users/a&amp;b/&lt;data&gt;');
    expect(odd).not.toContain('/Users/a&b/<data>');
    expect(escapeXml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&apos;');
  });
});

describe('the CLI argument layer', () => {
  it('reads both --flag value and --flag=value', () => {
    expect(parseArgs(['--port', '5600', '--host=0.0.0.0'])).toEqual({
      port: '5600',
      host: '0.0.0.0',
    });
  });

  it('builds a config, defaulting the optional half', () => {
    const built = configFromArgs(
      parseArgs([
        '--app-dir', '/opt/app',
        '--data-dir', '/var/data',
        '--port', '5599',
        '--node-bin', '/usr/bin/node',
        '--run-script', '/opt/app/scripts/service-run.sh',
      ]),
    );
    expect(built.label).toBe(DEFAULT_LABEL);
    expect(built.host).toBe('127.0.0.1');
    expect(built.autoUpdate).toBe(false);
  });

  it('refuses to render half a unit when a path is missing', () => {
    expect(() => configFromArgs(parseArgs(['--port', '5599']))).toThrow(/--app-dir/);
  });
});
