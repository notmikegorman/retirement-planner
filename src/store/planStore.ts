/**
 * THE PLAN (plan.json) — the one and only set of knobs, and the single place a
 * change to it is written.
 *
 * There is exactly one plan. No library, no dropdown, no dirty flag, no Save
 * button: the workbench PUTs on every committed edit, which is what makes
 * "pick up where I left off" true without ceremony. What that costs is the
 * previous version, and this module is where that debt is paid — every save
 * passes the DAILY GUARD first, so the plan as the day began is filed in
 * plan-history.json before the day's first change lands on top of it.
 *
 * THE GUARD LIVES HERE, not in the UI, and that is the whole point: a guard
 * the client can forget is not a guard. Every write the app serves — the
 * autosave, a search finalist opened into the workbench, a restore of an older
 * version — goes through `savePlan`, so there is one door and it is locked.
 *
 * THE ONE WRITE THAT DOES NOT PASS THROUGH HERE is the boot-time giving-split
 * migration (dataStore.migrateGivingSplitFiles), which rewrites plan.json raw
 * before anything is served. It cannot use this door: the file it is fixing is
 * by definition in a shape the current schema rejects, so the copy it would
 * file could not be stored as a history entry (an entry holds a plan the
 * engine could run). It also is not editing — it runs once per folder, before
 * anything is served.
 *
 * ENVIRONMENT-NEUTRAL since Phase 3 of the browser port: a factory over the
 * DataStore and PlanHistoryStore it writes through, with the serialized chain
 * and the guard moved as-is. The chain protects one realm, exactly as before;
 * what keeps the realm single in each environment is that environment's
 * writer guard (.writer.lock under node, Web Locks + the lease in the
 * browser).
 */
import type { z } from 'zod';
import type { PlanHistoryEntry, Person, Scenario } from '../shared/types';
import { parseOrThrow, scenarioSchema } from '../shared/schemas';
import { stableStringify } from '../shared/util';
// The editor's own pure plan helpers, reused verbatim so a seeded plan.json can
// never disagree with what the UI would have written. That module is free of
// React/DOM imports — it pulls only engine/household, shared/schemas and
// shared/util — so importing it here costs the store nothing in either
// environment.
import { defaultPlan, writePlan } from '../ui/components/scenarios/scenarioHelpers';
import { NotFoundError, ValidationError, type DataStore } from './dataStore';
import type { PlanHistoryStore } from './planHistoryStore';

/**
 * The plan carries no user-facing identity: it is never named, described,
 * listed, or chosen from. `name` stays on the record only because it is a
 * required field of the Scenario shape the engine consumes, so it is pinned to
 * this constant on every write and never shown or edited.
 */
export const PLAN_NAME = 'Plan';

/** parseOrThrow, rethrown as ValidationError so the server can map it to 400. */
function validate<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  try {
    return parseOrThrow(schema, data, label);
  } catch (err) {
    throw new ValidationError((err as Error).message);
  }
}

/**
 * The plan a fresh data folder starts with: the three plan decisions at their
 * defaults — each person stops working at 62, the household claims Social
 * Security at full retirement age, allocation unchanged — and NOTHING else.
 * Starting empty is the user's explicit choice: what-ifs are explored by
 * adding and removing events, so the app must not pre-load any.
 *
 * defaultPlan/writePlan are the editor's own helpers (see the import), so the
 * seeded file is byte-for-byte what the UI would have written for these people.
 */
export function defaultPlanScenario(people: readonly Person[]): Scenario {
  return { name: PLAN_NAME, events: writePlan([], defaultPlan(people), people) };
}

export interface PlanStore {
  loadPlan(): Promise<Scenario>;
  savePlan(scenario: Scenario, now?: Date): Promise<Scenario>;
  restorePlan(
    id: string,
    now?: Date,
  ): Promise<{ plan: Scenario; restoredFrom: PlanHistoryEntry }>;
}

export function createPlanStore(data: DataStore, history: PlanHistoryStore): PlanStore {
  const planPath = (): string => 'plan.json';

  /**
   * Every write to plan.json goes through here, one at a time.
   *
   * The guard is a read-then-write: it asks what the plan currently is,
   * decides whether today's restore point exists, and only then overwrites.
   * Both steps contain awaits, so two saves landing together could file the
   * same version twice — or, worse, file the SECOND one as "the day's start"
   * and lose the version the day actually began with. A serial chain costs
   * nothing here (a few dozen writes in a long editing session) and makes
   * that impossible rather than unlikely.
   *
   * A rejected link must not break the chain: the next writer runs either way.
   */
  let writes: Promise<unknown> = Promise.resolve();

  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = writes.then(work, work);
    writes = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** The stored plan, or null when the folder has none yet. Malformed throws. */
  async function readPlanFile(): Promise<Scenario | null> {
    const filePath = planPath();
    let raw: unknown;
    try {
      raw = await data.readJsonFile(filePath);
    } catch (err) {
      if (err instanceof NotFoundError) return null;
      throw err;
    }
    return validate(scenarioSchema, raw, `plan (${data.describeDataFile(filePath)})`);
  }

  /**
   * Write plan.json, filing the version it replaces if today has no restore
   * point yet. The UI saves on every committed edit, so this is the hot path:
   * guard, validate, pin the internal name, write pretty JSON. Validation also
   * strips unknown keys (e.g. a stray `id` left over from the old scenario
   * files).
   *
   * WHAT COUNTS AS A CHANGE HERE IS WIDER THAN PLAN IDENTITY. `planIdentityKey`
   * excludes `description` because two plans differing only in prose are one
   * plan TO THE ENGINE — but the description on a user's plan is a paragraph
   * of their own analysis, and rewriting it is exactly the kind of edit
   * history exists to undo. So the guard fires on any difference in what
   * would be stored, while `planHash` on the entry keeps answering the
   * narrower question about comparability.
   *
   * A write that changes nothing files nothing: the autosave path can fire a
   * PUT that matches disk byte for byte, and a no-op must be free.
   *
   * `now` is the clock seam — tests pin the day rather than faking global
   * time.
   */
  async function savePlan(scenario: Scenario, now: Date = new Date()): Promise<Scenario> {
    const valid = validate(scenarioSchema, { ...scenario, name: PLAN_NAME }, 'plan');
    return serialized(async () => {
      let previous: Scenario | null = null;
      try {
        previous = await readPlanFile();
      } catch {
        // An unreadable or schema-invalid plan.json cannot be filed as a
        // history entry (an entry holds a plan the engine could run), and it
        // must not block the write either: the user is saving a plan they can
        // see, and refusing would leave them unable to replace the broken
        // file at all.
        previous = null;
      }
      if (previous !== null && stableStringify(previous) !== stableStringify(valid)) {
        await history.recordDayStart(previous, now);
      }
      await data.writeJsonPretty(planPath(), valid);
      return valid;
    });
  }

  return {
    /**
     * Read plan.json, validated. A MISSING file is seeded (not an error): the
     * default plan for the profile's people is written and returned, so the
     * first launch lands on a working set of knobs. A file that exists but is
     * malformed or schema-invalid is reported with a message naming plan.json
     * — never silently replaced, since that would discard the user's only
     * plan.
     *
     * The seeding write does NOT file a history entry, and must not: there is
     * no previous version to keep, and an entry holding the plan a folder was
     * born with would offer to "restore" the state before the user had a plan
     * at all.
     */
    async loadPlan(): Promise<Scenario> {
      const existing = await readPlanFile();
      if (existing !== null) return existing;
      const { people } = await data.loadProfile();
      const seeded = defaultPlanScenario(people);
      await data.writeJsonPretty(planPath(), seeded);
      return seeded;
    },

    savePlan,

    /**
     * Make an older version the plan again.
     *
     * It is an ordinary save of a plan that happens to have come from history,
     * and that is what makes a restore undoable: the guard files the version
     * being replaced first, so restoring the wrong one costs nothing. Nothing
     * is consumed, removed or reordered — `entry.plan` is copied forward and
     * the entry stays exactly where it is.
     */
    async restorePlan(
      id: string,
      now: Date = new Date(),
    ): Promise<{ plan: Scenario; restoredFrom: PlanHistoryEntry }> {
      const entry = await history.getPlanHistoryEntry(id);
      const plan = await savePlan(entry.plan, now);
      return { plan, restoredFrom: entry };
    },
  };
}
