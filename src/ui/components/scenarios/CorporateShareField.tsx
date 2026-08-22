/**
 * The corporate-share percent input — ONE component, two doors.
 *
 * The OverridesCard's "Corporate share of bonds (%)" field and the Plan
 * card's "Bonds are: Custom" box edit the SAME override
 * (assumption_overrides.market.bondComposition.corporateFraction), so they
 * share the input itself: same label, same width, same bound check
 * (corporateShareErrorText) rendered the same way. A control that looked
 * different in its two homes would read as two settings, and "which one
 * wins?" is a question this app must never make the user ask.
 *
 * Text state stays with the caller (parse-on-blur, like every number field):
 * the OverridesCard folds it into its OverrideFields, the Plan card keeps a
 * local typing buffer. The error, though, is computed HERE from the current
 * text — both doors show the identical message at the identical moment.
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
