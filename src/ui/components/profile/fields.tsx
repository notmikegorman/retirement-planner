/**
 * Small form primitives shared by the profile page's tabs and cards.
 *
 * Number inputs keep local string state and parse on blur (or Enter) so
 * typing isn't fought; commit handlers receive parsed numbers.
 *
 * ALIGNMENT (test-drive note 5): every field renders a fixed three-row grid —
 * label / control / helper — via the `.field` CSS primitives, so within a
 * `.row` all labels sit on one line, all inputs share a baseline, and helper
 * text hangs below WITHOUT shifting neighbors. CheckboxField reserves an
 * empty label row so its control aligns with adjacent inputs. Inline
 * annotations that should line up with the control row (unit notes, "sum"
 * indicators, flags) go in <FieldNote>.
 *
 * HELP TEXT COMES IN TWO SIZES. A hint short enough to read at a glance stays
 * inline (`help`) — hiding "Agent fees etc." behind a click would be more
 * friction than help. A paragraph goes in a `tip` instead, revealed by the "?"
 * beside the label, because a column of paragraphs is what made the panel long
 * enough to need scrolling past the controls that matter.
 */
import { useEffect, useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { AssetMix } from '../../../shared/types';
import { formatUSD } from '../../../shared/util';
import {
  PLACEHOLDER_TITLE,
  allocationOk,
  allocationSum,
  annualFromMonthly,
  parseNumberInput,
  pctDisplayValue,
} from './profileLogic';

export interface Option {
  value: string;
  label: string;
}

function blurOnEnter(e: KeyboardEvent<HTMLInputElement>): void {
  if (e.key === 'Enter') e.currentTarget.blur();
}

function Help({ text }: { text: string | undefined }) {
  return text ? <span className="field-help">{text}</span> : null;
}

/**
 * A field-shaped validation failure, rendered ON the field (the smplkit
 * standard): the wrapper gets `fieldHasError` (red border on the control, via
 * fieldClass below) and this line carries the words. The banner stays
 * reserved for whole-form failures.
 */
function FieldError({ error }: { error: string | null | undefined }) {
  return error ? (
    <span className="fieldErrorMessage" role="alert">
      {error}
    </span>
  ) : null;
}

function fieldClass(error: string | null | undefined): string {
  return error ? 'field fieldHasError' : 'field';
}

/**
 * The "?" beside a label: verbose help, out of the way until it is wanted.
 *
 * The reveal is pure CSS — `:hover` for the mouse, `:focus-within` for the
 * keyboard — so there is no open/closed state to get stuck and no library. Two
 * lines of JS only normalize two browser quirks: Safari does not focus a button
 * on click (so a click would open nothing there), and Escape has to close what
 * focus opened.
 *
 * Placement is the subtle part. The bubble is `position: fixed` with BOTH
 * offsets auto, which lays it out at its static position — directly under the
 * "?" — while making the viewport its containing block. That is what keeps the
 * Workbench panel, a 400px-wide scroll container with `overflow-x: hidden`,
 * from clipping a 300px bubble in half; an absolutely positioned one would be
 * cut off the moment its field sat right of centre. It is out of flow, so
 * showing it never moves anything on the page.
 *
 * `align="end"` right-aligns the bubble to the "?" instead, for tips close
 * enough to the right edge of a wide page that a left-aligned bubble would run
 * past the window.
 *
 * A SPAN with role="button", not a <button>, since the module overhaul: the
 * view/edit modules wrap their forms in a disabled <fieldset>, which switches
 * every real button off — and help is not an edit. A span stays focusable and
 * clickable in view mode, which is exactly when someone reads help.
 */
export function InfoTip(props: { label: string; text: ReactNode; align?: 'start' | 'end' }) {
  const id = useId();
  return (
    <span className={props.align === 'end' ? 'infotip infotip-end' : 'infotip'}>
      <span
        role="button"
        tabIndex={0}
        className="infotip-btn"
        aria-label={`More about ${props.label}`}
        aria-describedby={id}
        // Safari leaves controls unfocused on click, so :focus-within — the
        // only thing that opens the bubble for a keyboard user — would never
        // fire for a mouse user there. Focusing explicitly makes click work
        // everywhere without a second (stateful) reveal mechanism.
        onClick={(e) => e.currentTarget.focus()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') e.currentTarget.blur();
        }}
      >
        <span aria-hidden="true">?</span>
      </span>
      <span className="infotip-bubble" id={id} role="tooltip">
        {props.text}
      </span>
    </span>
  );
}

/**
 * A field's label row, with the "?" attached when the field carries a tip.
 * Every control below renders its label through this, so the affordance sits in
 * exactly the same place on every field in the app.
 */
export function FieldLabel(props: {
  label: string;
  tip?: ReactNode;
  tipAlign?: 'start' | 'end';
  /** Renders the standard red asterisk after the label text (fieldRequired). */
  required?: boolean;
}) {
  return (
    <span className="field-label">
      {props.required ? <span className="fieldRequired">{props.label}</span> : props.label}
      {props.tip !== undefined && props.tip !== null ? (
        <InfoTip label={props.label} text={props.tip} align={props.tipAlign} />
      ) : null}
    </span>
  );
}

export function NumberField(props: {
  label: string;
  value: number | undefined;
  onCommit: (value: number | undefined) => void;
  /** Display/parse as a percent: value 0.85 shows as "85", commits 0.85. */
  pct?: boolean;
  int?: boolean;
  /** Blank input commits undefined instead of reverting. */
  allowEmpty?: boolean;
  /** Short hint, shown inline under the control. */
  help?: string;
  /** Verbose help, shown behind the "?" beside the label. */
  tip?: ReactNode;
  /** What an empty box means (pairs with allowEmpty). */
  placeholder?: string;
  width?: number;
  /** Red asterisk on the label — for fields the profile schema requires. */
  required?: boolean;
  /** Field-shaped validation failure: red border + message under the control. */
  error?: string | null;
}) {
  const { label, value, onCommit, pct, int, allowEmpty, help, tip, placeholder, width } = props;
  const display = (v: number | undefined): string =>
    v == null ? '' : String(pct ? pctDisplayValue(v) : v);
  const [text, setText] = useState<string>(() => display(value));

  const commit = () => {
    const trimmed = text.trim();
    if (trimmed === '') {
      if (allowEmpty) {
        setText('');
        onCommit(undefined);
      } else {
        setText(display(value)); // revert
      }
      return;
    }
    const parsed = parseNumberInput(trimmed);
    if (parsed == null) {
      setText(display(value)); // unparseable -> revert
      return;
    }
    let v = pct ? parsed / 100 : parsed;
    if (int) v = Math.round(v);
    setText(display(v));
    onCommit(v);
  };

  return (
    <label className={fieldClass(props.error)} style={width ? { width } : undefined}>
      <FieldLabel label={label} tip={tip} required={props.required} />
      <input
        inputMode="decimal"
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={blurOnEnter}
      />
      <FieldError error={props.error} />
      <Help text={help} />
    </label>
  );
}

export function TextField(props: {
  label: string;
  value: string;
  onCommit: (value: string) => void;
  width?: number | 'full';
  help?: string;
  tip?: ReactNode;
  placeholder?: string;
  /** Red asterisk on the label — for fields the profile schema requires. */
  required?: boolean;
  /** Field-shaped validation failure: red border + message under the control. */
  error?: string | null;
}) {
  const [text, setText] = useState(props.value);
  const style =
    props.width === 'full'
      ? { width: '100%', marginTop: 8 }
      : props.width
        ? { width: props.width }
        : undefined;
  return (
    <label className={fieldClass(props.error)} style={style}>
      <FieldLabel label={props.label} tip={props.tip} required={props.required} />
      <input
        value={text}
        placeholder={props.placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text !== props.value) props.onCommit(text);
        }}
        onKeyDown={blurOnEnter}
      />
      <FieldError error={props.error} />
      <Help text={props.help} />
    </label>
  );
}

export function SelectField(props: {
  label: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  width?: number;
  help?: string;
  tip?: ReactNode;
  /** Red asterisk on the label — for fields the profile schema requires. */
  required?: boolean;
  /** Field-shaped validation failure: red border + message under the control. */
  error?: string | null;
}) {
  return (
    <label className={fieldClass(props.error)} style={props.width ? { width: props.width } : undefined}>
      <FieldLabel label={props.label} tip={props.tip} required={props.required} />
      <select value={props.value} onChange={(e) => props.onChange(e.target.value)}>
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <FieldError error={props.error} />
      <Help text={props.help} />
    </label>
  );
}

export function CheckboxField(props: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  help?: string;
  tip?: ReactNode;
}) {
  return (
    <label className="field field-checkbox">
      {/* Empty label row so the control lines up with neighboring inputs. */}
      <span className="field-label" aria-hidden="true" />
      <span className="field-control">
        <input
          type="checkbox"
          checked={props.checked}
          onChange={(e) => props.onChange(e.target.checked)}
        />
        <span>{props.label}</span>
        {/* The tip hangs off the control row here: a checkbox's label row is
            deliberately empty so the box lines up with neighbouring inputs. */}
        {props.tip !== undefined && props.tip !== null ? (
          <InfoTip label={props.label} text={props.tip} />
        ) : null}
      </span>
      <Help text={props.help} />
    </label>
  );
}

/**
 * A "YYYY-MM" month picker in the standard three-row field grid.
 *
 * Unlike the number fields it commits on CHANGE rather than on blur: a native
 * month input is chosen from a picker, not typed, so there is no half-finished
 * state to protect and waiting for a blur just makes the control feel stuck.
 * An empty value commits `undefined`, which every caller reads as "the default"
 * — never as a date.
 */
export function MonthField(props: {
  label: string;
  value: string | undefined;
  onCommit: (value: string | undefined) => void;
  help?: string;
  tip?: ReactNode;
  width?: number;
}) {
  return (
    <label className="field" style={props.width ? { width: props.width } : undefined}>
      <FieldLabel label={props.label} tip={props.tip} />
      <input
        type="month"
        value={props.value ?? ''}
        onChange={(e) => props.onCommit(e.target.value === '' ? undefined : e.target.value)}
      />
      <Help text={props.help} />
    </label>
  );
}

/**
 * Inline annotation that vertically aligns with the CONTROL row of adjacent
 * fields in the same `.row` (replaces the old `alignSelf: 'flex-end'` +
 * padding hacks). `className` is appended to the container — e.g. 'muted'
 * (default look), 'warn' for emphasized warnings; wrap a `.flag` chip in a
 * plain FieldNote to align it.
 */
export function FieldNote(props: { children: ReactNode; className?: string }) {
  return (
    <span className={props.className ? `field-note ${props.className}` : 'field-note'}>
      {props.children}
    </span>
  );
}

/**
 * The "placeholder" marker (note 6). A chip with a title tooltip so it can't
 * be misread as part of an account/person name.
 */
export function PlaceholderChip() {
  return (
    <span className="flag" title={PLACEHOLDER_TITLE}>
      placeholder value
    </span>
  );
}

/**
 * A monthly-dollar input that shows its ×12 annual equivalent inline (note
 * 12). The annual figure sits in a FieldNote so it lines up with the control
 * row of its neighbors.
 */
export function MonthlyMoneyField(props: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  help?: string;
  tip?: ReactNode;
  width?: number;
}) {
  return (
    <>
      <NumberField
        label={props.label}
        value={props.value}
        width={props.width ?? 190}
        help={props.help}
        tip={props.tip}
        onCommit={(v) => props.onCommit(v ?? 0)}
      />
      <FieldNote className="muted">= {formatUSD(annualFromMonthly(props.value))}/yr</FieldNote>
    </>
  );
}

// ---------------------------------------------------------------------------
// Table cells
// ---------------------------------------------------------------------------

/**
 * The two primitives a TABLE row is built from.
 *
 * The `.field` grid above cannot be used in a table and never should be: its
 * reserved label track exists so that every control in a `.row` shares one
 * baseline, and in a table the label is the COLUMN HEADING — one per column,
 * not one per cell. Repeating it forty times down a budget is exactly the noise
 * the heading removes.
 *
 * Everything else is deliberately identical to the fields above: local text
 * state so typing is not fought, commit on blur or Enter, and an unparseable
 * entry reverts rather than being stored. They re-sync when the value changes
 * underneath them (a category retype, a seed, a discard), which a table needs
 * and a remounted form does not.
 */
export function MoneyCell(props: {
  value: number | undefined;
  /**
   * What the empty box means — the INHERITED figure, rendered muted and italic
   * by the stylesheet. An empty cell must never read as $0 or as "unfilled".
   */
  placeholder: string;
  onCommit: (value: number | undefined) => void;
  ariaLabel: string;
  title?: string;
}) {
  const { value, onCommit } = props;
  const [text, setText] = useState(value === undefined ? '' : String(value));

  useEffect(() => {
    setText(value === undefined ? '' : String(value));
  }, [value]);

  const commit = () => {
    const trimmed = text.trim();
    if (trimmed === '') {
      // Clearing is how a cell goes BACK to inherited, so an empty box commits
      // undefined rather than 0 — the one distinction this editor exists for.
      setText('');
      if (value !== undefined) onCommit(undefined);
      return;
    }
    const parsed = parseNumberInput(trimmed);
    if (parsed == null || parsed < 0) {
      setText(value === undefined ? '' : String(value)); // revert
      return;
    }
    setText(String(parsed));
    if (parsed !== value) onCommit(parsed);
  };

  return (
    <input
      className="cell-money"
      inputMode="decimal"
      aria-label={props.ariaLabel}
      title={props.title}
      value={text}
      placeholder={props.placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={blurOnEnter}
    />
  );
}

export function TextCell(props: {
  value: string;
  onCommit: (value: string) => void;
  ariaLabel: string;
  placeholder?: string;
  /** Blank reverts instead of committing — for fields the schema requires. */
  required?: boolean;
}) {
  const { value, onCommit } = props;
  const [text, setText] = useState(value);

  useEffect(() => {
    setText(value);
  }, [value]);

  return (
    <input
      className="cell-text"
      aria-label={props.ariaLabel}
      value={text}
      placeholder={props.placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        // An empty label would make the whole profile fail the server's schema
        // on save, which is a confusing way to learn you deleted a word.
        if (props.required && text.trim() === '') {
          setText(value);
          return;
        }
        if (text !== value) onCommit(text);
      }}
      onKeyDown={blurOnEnter}
    />
  );
}

/** Three decimal weights (stocks/bonds/bills) with a sum-must-be-1 indicator. */
export function AllocationEditor(props: {
  mix: AssetMix;
  onChange: (mix: AssetMix) => void;
  /** Extra helper line under the row (e.g. the target-date-fund blend note). */
  help?: string;
}) {
  const sum = allocationSum(props.mix);
  const ok = allocationOk(props.mix);
  const set = (key: keyof AssetMix) => (v: number | undefined) =>
    props.onChange({ ...props.mix, [key]: v ?? 0 });
  return (
    <div>
      <div className="row">
        <FieldNote className="muted">Allocation</FieldNote>
        <NumberField label="Stocks" width={80} value={props.mix.stocks} onCommit={set('stocks')} />
        <NumberField label="Bonds" width={80} value={props.mix.bonds} onCommit={set('bonds')} />
        <NumberField label="Bills" width={80} value={props.mix.bills} onCommit={set('bills')} />
        <FieldNote className={ok ? 'muted' : 'warn'}>
          sum {sum.toFixed(2)}
          {ok ? '' : ' — weights must sum to 1'}
        </FieldNote>
      </div>
      {props.help ? (
        <div className="field-help" style={{ marginTop: 2 }}>
          {props.help}
        </div>
      ) : null}
    </div>
  );
}
