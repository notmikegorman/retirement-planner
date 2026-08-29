/**
 * The scoring-intent machinery's WIRING, pinned by reading both backends —
 * the same idiom as snapshotScore.test.ts's route scans (there is no route
 * harness in this repo; importing server.ts starts a listener on the owner's
 * port). What the store-level suite (tests/store/scoringIntent.test.ts)
 * cannot see is whether each backend actually composes and calls the shared
 * machinery, and these are exactly the lines that would rot silently: a
 * backend that forgot to heal at boot would pass every unit test and leave
 * every orphaned intent undecided forever.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const server = read('../../src/server/server.ts');
const localBackend = read('../../src/ui/local/localBackend.ts');
const apiClient = read('../../src/ui/api.ts');

describe('both backends heal orphaned intents at boot, before serving anything', () => {
  it('the server heals after initDataDir and before Fastify exists', () => {
    const init = server.indexOf('await initDataDir()');
    const heal = server.indexOf('await healScoringIntents()');
    const fastify = server.indexOf('Fastify({');
    expect(init).toBeGreaterThan(-1);
    expect(heal).toBeGreaterThan(init);
    expect(fastify).toBeGreaterThan(heal);
  });

  it('the local backend heals after initDataDir and before composing its api object', () => {
    // 'initDataDir(' rather than 'initDataDir()': zero-start made the call
    // carry its seeding declaration ({ seedStarterProfile: demo }); the
    // ordering pinned here is unchanged.
    const init = localBackend.indexOf('initDataDir(');
    const heal = localBackend.indexOf('await services.scoringIntents.heal()');
    const firstMethod = localBackend.indexOf('meta: async ()');
    expect(init).toBeGreaterThan(-1);
    expect(heal).toBeGreaterThan(init);
    expect(firstMethod).toBeGreaterThan(heal);
  });
});

describe('the two routes exist on both backends, shapes matching the client', () => {
  it('the server registers GET /api/scoring/intents and POST /api/scoring/finish', () => {
    expect(server).toContain("app.get('/api/scoring/intents'");
    expect(server).toContain("app.post('/api/scoring/finish'");
    expect(server).toContain('finishScoringRequestSchema');
  });

  it('the client names the same paths, and the local facade delegates both', () => {
    expect(apiClient).toContain("'/api/scoring/intents'");
    expect(apiClient).toContain("'/api/scoring/finish'");
    expect(apiClient).toContain('getScoringIntents: () => b().then');
    expect(apiClient).toContain('finishScoring: (body) => b().then');
  });
});

describe('the unload guard is wired in the browser and only there', () => {
  it('the local backend hands the scoring-flight hook to the composed services', () => {
    expect(localBackend).toContain('onScoringInFlightChange: setScoringInFlight');
  });

  it('the node services pass no hook — the server outlives every tab', () => {
    const nodeServices = read('../../src/server/services.ts');
    expect(nodeServices).not.toContain('onScoringInFlightChange');
  });
});
