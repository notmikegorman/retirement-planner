/** Asset-mix editor (stocks/bonds/bills weights) with a sum-to-1 check. */
import { useState } from 'react';
import type { AssetMix } from '../../../shared/types';
import { mixError, parseNumber } from './scenarioHelpers';

interface MixEditorProps {
  label: string;
  mix: AssetMix;
  onChange: (mix: AssetMix) => void;
}

export function MixEditor({ label, mix, onChange }: MixEditorProps) {
  const [text, setText] = useState({
    stocks: String(mix.stocks),
    bonds: String(mix.bonds),
    bills: String(mix.bills),
  });

  const commit = (key: keyof AssetMix, value: string) => {
    const n = parseNumber(value);
    if (n === null) {
      // Revert unparseable input to the last committed value.
      setText((t) => ({ ...t, [key]: String(mix[key]) }));
      return;
    }
    onChange({ ...mix, [key]: n });
  };

  const err = mixError(mix);

  return (
    <div style={{ margin: '6px 0' }}>
      <div className="muted">{label} — weights must sum to 1</div>
      <div className="row">
        {(['stocks', 'bonds', 'bills'] as const).map((k) => (
          <label className="field" key={k}>
            {k}
            <input
              style={{ width: 90 }}
              value={text[k]}
              onChange={(e) => setText({ ...text, [k]: e.target.value })}
              onBlur={(e) => commit(k, e.target.value)}
            />
          </label>
        ))}
      </div>
      {/* 12, matching OverridesCard's FieldError and CorporateShareField's —
          three inline validation lines, one size. */}
      {err && (
        <div className="bad" style={{ fontSize: 12, marginTop: 4 }}>
          {err}
        </div>
      )}
    </div>
  );
}
