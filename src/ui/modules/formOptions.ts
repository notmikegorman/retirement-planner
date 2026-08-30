/**
 * The select-option lists the modules share, derived once from the label
 * maps in profileLogic so a label edit lands everywhere at once.
 */
import type { StateCode, WithdrawalPolicy } from '../../shared/types';
import {
  MONTH_NAMES,
  PRETAX_PREFERENCE_LABELS,
  STATE_LABELS,
} from '../components/profile/profileLogic';

export const STATE_OPTIONS = (Object.keys(STATE_LABELS) as StateCode[]).map((value) => ({
  value,
  label: STATE_LABELS[value],
}));

export const MONTH_OPTIONS = MONTH_NAMES.map((name, i) => ({
  value: String(i + 1),
  label: name,
}));

export const PRETAX_OPTIONS = (
  Object.keys(PRETAX_PREFERENCE_LABELS) as WithdrawalPolicy['pretaxPreference'][]
).map((value) => ({ value, label: PRETAX_PREFERENCE_LABELS[value] }));
