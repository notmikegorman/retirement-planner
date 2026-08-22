/**
 * DEFINING THE SPACE — which decisions to vary, and over what values.
 *
 * The user's sentence was "the fine-tune point for each scenario that yields
 * the highest score might require creating the SEPP or not, adjusting my
 * portfolio balance or not, and if so which year, and if all at once or glide,
 * and 100 other decisions". This editor is that sentence as a form: one row per
 * decision, off by default, and every row carries its own levels.
 *
 * THREE THINGS IT WILL NOT LET HAPPEN:
 *
 *  1. A LEVEL LIST THAT IS NOT WHAT YOU MEANT. Every numeric row echoes its
 *     parse back as chips. "2029-2035/2" becomes six visible years before a
 *     single simulation runs, and a percent entered as "0.6" is refused with
 *     the reason rather than silently searched as 0.6%.
 *  2. A SPACE WHOSE SIZE IS A SURPRISE. The multiplication is on screen and
 *     updates as you type: 4 x 3 x 2 x 2 is 48 plans, and 8 x 5 x 4 x 3 x 2 is
 *     960. The difference is minutes against an hour.
 *  3. A PRECISION NOBODY CHOSE. The three presets differ in seeds and paths —
 *     i.e. in how wide the report's intervals come back — and say so in their
 *     own words, because "quick" here does not mean a rougher answer, it means
 *     an answer that will more often be "we cannot tell yet".
 */
import { useState } from 'react';
import type { SearchBudget, SearchObjective } from '../../../shared/types';
import { InfoTip } from '../profile/fields';
import {
  BUDGET_PRESETS,
  choiceOptions,
  compileSpace,
  dimGroups,
  draftLevelLabels,
  presetSpec,
  shouldEnumerate,
  spaceSizeNote,
  SUCCESS_METRIC_WARNING,
  type AxisDraft,
  type BudgetPreset,
  type DimSpec,
} from './searchLogic';

const OBJECTIVE_TIP =
  'What the search maximises. SUSTAINABLE SPENDING is the default and should stay that way for ' +
  'this household: measured over twenty structurally different plans at your actual spending, ' +
  'six tied at exactly 100.00% success and the whole spread across the space was 2.57 percentage ' +
  'points — retiring five years earlier and buying a $1.35M house cost 0.05pp. A metric that ' +
  'cannot separate those decisions would be maximising the random number generator. Dollars of ' +
  'sustainable spending move by hundreds to thousands over the same space, comfortably above the ' +
  'noise. Choose probability of success only for a plan that is genuinely tight.';

const FLOOR_TIP =
  'The difference below which two plans are reported as THE SAME PLAN. Statistical significance ' +
  'is cheap — buy enough seeds and a $12/yr difference becomes "real" — so this is the other, ' +
  'more important bar: worth rearranging your life over. A result is only called a win when the ' +
  'bottom of its confidence interval clears this. Blank uses $500/yr, which is half the ' +
  'bisection’s own stopping interval.';

const LABEL_TIP =
  'A name for this search, so the history list is readable a week later. The space itself is ' +
  'hashed, so two searches of the same space are linkable whatever you call them.';

const SEED_TIP =
  'Two DISJOINT seed sets. One is used to choose the finalists, the other to measure them, and ' +
  'they never overlap — which is what stops the report quoting the same luck that won the race. ' +
  'More report seeds means narrower intervals: the 95% half-width on a paired delta falls as ' +
  '1/sqrt(n), so 8 seeds is about 1.6x wider than 20.';

export interface SpaceEditorProps {
  drafts: AxisDraft[];
  onDraftsChange: (next: AxisDraft[]) => void;
  label: string;
  onLabelChange: (next: string) => void;
  metric: SearchObjective['metric'];
  onMetricChange: (next: SearchObjective['metric']) => void;
  practicalFloorText: string;
  onPracticalFloorChange: (next: string) => void;
  preset: BudgetPreset;
  onPresetChange: (next: BudgetPreset) => void;
  overrides: Partial<SearchBudget>;
  onOverridesChange: (next: Partial<SearchBudget>) => void;
  onStart: () => void;
  starting: boolean;
  /** A search is already running; starting another would fight it for CPU. */
  busyElsewhere: boolean;
  error: string | null;
}

export function SpaceEditor(props: SpaceEditorProps) {
  const { drafts, onDraftsChange } = props;
  const compiled = compileSpace(drafts);
  const budget = { ...presetSpec(props.preset).budget, ...props.overrides };
  const candidates = budget.candidates ?? 512;
  const enumerate = shouldEnumerate(compiled.combinations, candidates);
  const errorList = Object.entries(compiled.errors);

  const setDraft = (dim: string, patch: Partial<AxisDraft>) =>
    onDraftsChange(drafts.map((d) => (d.dim === dim ? { ...d, ...patch } : d)));

  return (
    <div>
      {dimGroups().map((group) => (
        <div className="card" key={group.group}>
          <h2 style={{ marginTop: 0 }}>{group.group}</h2>
          {group.dims.map((spec) => {
            const draft = drafts.find((d) => d.dim === spec.dim);
            if (!draft) return null;
            return (
              <AxisRow
                key={spec.dim}
                spec={spec}
                draft={draft}
                error={compiled.errors[spec.dim] ?? null}
                onChange={(patch) => setDraft(spec.dim, patch)}
              />
            );
          })}
        </div>
      ))}

      {/* ----------------------- how big is this? ------------------------- */}
      <div className="card">
        <h2 style={{ marginTop: 0 }}>The space</h2>
        {compiled.axes.length === 0 ? (
          <div className="muted">
            No dimensions turned on yet. A search over nothing is a plain run — turn on at least
            one decision above.
          </div>
        ) : (
          <>
            <div className="explore-answer">
              {compiled.axes.map((a) => a.levels.length).join(' × ')} ={' '}
              {compiled.combinations.toLocaleString('en-US')} combination
              {compiled.combinations === 1 ? '' : 's'}
            </div>
            <div className="muted" style={{ marginTop: 6 }}>
              {spaceSizeNote(compiled.combinations, candidates, enumerate)}
            </div>
          </>
        )}

        {errorList.length > 0 && (
          <div className="error-banner" style={{ marginTop: 12, marginBottom: 0 }}>
            {errorList.map(([dim, message]) => (
              <div key={dim}>
                <strong>{dim}</strong>: {message}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ------------------------- what to maximise ----------------------- */}
      <div className="card">
        <h2 style={{ marginTop: 0 }}>
          What counts as better
          <InfoTip label="the objective" text={OBJECTIVE_TIP} />
        </h2>
        <div className="row">
          <label className="field" style={{ width: 260 }}>
            <span className="field-label">Maximise</span>
            <select
              value={props.metric}
              onChange={(e) => props.onMetricChange(e.target.value as SearchObjective['metric'])}
            >
              <option value="sustainable_spend">Sustainable annual spending</option>
              <option value="success">Probability of success</option>
            </select>
          </label>
          <label className="field" style={{ width: 220 }}>
            <span className="field-label">
              Difference worth acting on
              <InfoTip label="the practical floor" text={FLOOR_TIP} />
            </span>
            <input
              value={props.practicalFloorText}
              inputMode="decimal"
              placeholder={props.metric === 'sustainable_spend' ? '500 ($/yr)' : '0.5 (points)'}
              onChange={(e) => props.onPracticalFloorChange(e.target.value)}
            />
          </label>
        </div>
        {props.metric === 'success' && (
          <div className="lib-warning warn" style={{ marginTop: 8 }}>
            {SUCCESS_METRIC_WARNING}
          </div>
        )}
      </div>

      {/* ---------------------------- precision --------------------------- */}
      <div className="card">
        <h2 style={{ marginTop: 0 }}>
          How hard to look
          <InfoTip label="seeds and paths" text={SEED_TIP} />
        </h2>
        <div className="explore-buttons">
          {BUDGET_PRESETS.map((p) => (
            <button
              key={p.id}
              className={p.id === props.preset ? 'primary' : undefined}
              onClick={() => {
                props.onPresetChange(p.id);
                props.onOverridesChange({});
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="muted" style={{ marginTop: 8 }}>
          {presetSpec(props.preset).note}
        </div>
        <AdvancedBudget
          budget={budget}
          overrides={props.overrides}
          onChange={props.onOverridesChange}
        />
      </div>

      {/* ------------------------------ start ----------------------------- */}
      <div className="card">
        <label className="field" style={{ width: '100%' }}>
          <span className="field-label">
            Name this search
            <InfoTip label="the search label" text={LABEL_TIP} />
          </span>
          <input
            value={props.label}
            placeholder="e.g. retire-or-work-two-more-years"
            onChange={(e) => props.onLabelChange(e.target.value)}
          />
        </label>

        {props.error && (
          <div className="error-banner" role="alert" style={{ marginTop: 12 }}>
            {props.error}
          </div>
        )}

        {props.busyElsewhere && (
          <div className="lib-warning warn" style={{ marginTop: 12 }}>
            A search is already running. Starting a second one splits the same cores between them
            and makes both slower — stop the first one if you want this instead.
          </div>
        )}

        <div className="row" style={{ marginTop: 12 }}>
          <button
            className="primary"
            disabled={props.starting || compiled.axes.length === 0 || errorList.length > 0}
            onClick={props.onStart}
          >
            {props.starting ? 'Starting…' : 'Run the search'}
          </button>
          <span className="muted">
            It runs on the server: leaving this page, or closing the tab, does not stop it.
          </span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One dimension
// ---------------------------------------------------------------------------

function AxisRow({
  spec,
  draft,
  error,
  onChange,
}: {
  spec: DimSpec;
  draft: AxisDraft;
  error: string | null;
  onChange: (patch: Partial<AxisDraft>) => void;
}) {
  const labels = draft.enabled ? draftLevelLabels(draft) : [];

  return (
    <div className={draft.enabled ? 'axis-row is-on' : 'axis-row'}>
      <label className="axis-head">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => onChange({ enabled: e.target.checked })}
        />
        <span className="axis-title">{spec.title}</span>
        <InfoTip label={spec.title} text={spec.tip} />
        <span className="spacer" />
        {draft.enabled && (
          <span className="muted">
            {labels.length} level{labels.length === 1 ? '' : 's'}
          </span>
        )}
      </label>

      {draft.enabled && (
        <div className="axis-body">
          {spec.kind === 'numbers' ? (
            <>
              <input
                value={draft.text}
                placeholder={spec.placeholder}
                onChange={(e) => onChange({ text: e.target.value })}
                style={{ width: '100%' }}
              />
              {spec.help && <div className="field-help">{spec.help}</div>}
              {spec.keywords && spec.keywords.length > 0 && (
                <div className="field-help">
                  Words allowed: {spec.keywords.map((k) => `“${k.token}” (${k.label})`).join(', ')}.
                </div>
              )}
            </>
          ) : (
            <div className="axis-choices">
              {choiceOptions(spec.dim).map((option) => (
                <label key={option.key} className="axis-choice">
                  <input
                    type="checkbox"
                    checked={draft.chosen.includes(option.key)}
                    onChange={(e) =>
                      onChange({
                        chosen: e.target.checked
                          ? [...draft.chosen, option.key]
                          : draft.chosen.filter((k) => k !== option.key),
                      })
                    }
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          )}

          {error ? (
            <div className="axis-error">{error}</div>
          ) : (
            spec.kind === 'numbers' &&
            labels.length > 0 && (
              <div className="chip-list" style={{ marginTop: 6 }}>
                {labels.map((l) => (
                  <span key={l} className="badge">
                    {l}
                  </span>
                ))}
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Advanced budget
// ---------------------------------------------------------------------------

/**
 * The knobs behind the presets. Folded away because nobody should have to
 * choose a path count to run a search — and present because the one number
 * worth overriding by hand, the report seed count, is the one that decides
 * whether a near-tie comes back resolved or "not measured well enough".
 */
function AdvancedBudget({
  budget,
  overrides,
  onChange,
}: {
  budget: Partial<SearchBudget>;
  overrides: Partial<SearchBudget>;
  onChange: (next: Partial<SearchBudget>) => void;
}) {
  const [open, setOpen] = useState(false);
  const set = (patch: Partial<SearchBudget>) => onChange({ ...overrides, ...patch });
  const num = (v: number | undefined) => (v === undefined ? '' : String(v));

  if (!open) {
    return (
      <button className="link-button" style={{ marginTop: 10 }} onClick={() => setOpen(true)}>
        Show the individual settings
      </button>
    );
  }

  return (
    <div style={{ marginTop: 10 }}>
      <div className="row">
        <NumberBox
          label="Candidates"
          value={num(budget.candidates)}
          onCommit={(v) => set({ candidates: v })}
        />
        <NumberBox
          label="Finalists"
          value={num(budget.finalists)}
          onCommit={(v) => set({ finalists: v })}
        />
        <NumberBox
          label="Report seeds"
          value={num(budget.reportSeedCount)}
          onCommit={(v) => set({ reportSeedCount: v })}
        />
        <NumberBox
          label="Report paths"
          value={num(budget.reportPaths)}
          onCommit={(v) => set({ reportPaths: v })}
        />
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <label className="row" style={{ gap: 6 }}>
          <input
            type="checkbox"
            checked={budget.attribution !== false}
            onChange={(e) => set({ attribution: e.target.checked })}
          />
          <span>Attribution — measure what each decision was worth</span>
        </label>
      </div>
      <div className="row" style={{ marginTop: 4 }}>
        <label className="row" style={{ gap: 6 }}>
          <input
            type="checkbox"
            checked={budget.polish !== false}
            onChange={(e) => set({ polish: e.target.checked })}
          />
          <span>Polish — check no single knob improves the winner</span>
        </label>
      </div>
      <div className="row" style={{ marginTop: 4 }}>
        <label className="row" style={{ gap: 6 }}>
          <input
            type="checkbox"
            checked={budget.widowProbe !== false}
            onChange={(e) => set({ widowProbe: e.target.checked })}
          />
          <span>Survivor probe — score each finalist for an early death</span>
        </label>
      </div>
      <button className="link-button" style={{ marginTop: 10 }} onClick={() => setOpen(false)}>
        Hide them
      </button>
    </div>
  );
}

function NumberBox({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: string;
  onCommit: (value: number | undefined) => void;
}) {
  const [text, setText] = useState(value);
  return (
    <label className="field" style={{ width: 130 }}>
      <span className="field-label">{label}</span>
      <input
        value={text}
        inputMode="numeric"
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const trimmed = text.trim();
          if (trimmed === '') {
            onCommit(undefined);
            return;
          }
          const parsed = Number(trimmed);
          if (Number.isFinite(parsed) && parsed > 0) onCommit(Math.round(parsed));
          else setText(value);
        }}
      />
    </label>
  );
}
