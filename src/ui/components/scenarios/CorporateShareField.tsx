/**
 * The corporate-share percent input. ONE caller now — BondsAreSelect's
 * Custom box under the Investing module (2026-08-30); through the two-door
 * era it was shared with the assumption-overrides card, which is why the
 * label and the bound check (corporateShareErrorText) live here rather than
 * with a caller. Text state stays with the caller (parse-on-blur, like
 * every number field); the error is computed HERE from the current text.
 */
import { corporateShareErrorText } from './scenarioHelpers';

interface CorporateShareFieldProps {
  /** The caller-owned text state (committed on blur, not per keystroke). */
  value: string;
  placeholder?: string;
  onChange: (text: string) => void;
  /** Commit point; the caller decides what a valid or blank value writes. */
  onBlur: (text: string) => void;
}

export function CorporateShareField({
  value,
  placeholder,
  onChange,
  onBlur,
}: CorporateShareFieldProps) {
  const error = corporateShareErrorText(value);
  return (
    <label className="field">
      Corporate share of bonds (%)
      <input
        style={{ width: 100 }}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => onBlur(e.target.value)}
      />
      {error !== undefined && (
        <span className="bad" style={{ fontSize: 12 }}>
          {error}
        </span>
      )}
    </label>
  );
}
