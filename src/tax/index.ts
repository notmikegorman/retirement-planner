/**
 * Public entry point for the tax module (SPEC §7).
 *
 * The engine calls computeYear(...) and nothing else; the submodule functions
 * are re-exported for tests and the UI's detail views.
 */

export { computeYear } from './computeYear';
export {
  bracketTax,
  bracketsFor,
  computeFederal,
  computeFederalIncomePieces,
  homeSaleExclusionFor,
  indexAmount,
  ltcgBreakpointsFor,
  niitThresholdFor,
  nonItemizerCharitableCap,
  saltCap,
  ssTaxableWorksheet,
  ssThresholdsFor,
  standardDeductionParts,
} from './federal';
export type { FederalIncomePieces, FederalResult } from './federal';
export { computeStateTax } from './states';
export type { FederalSummaryForState } from './states';
export { computeAca, computeMedicare } from './acaMedicare';
export * from './socialSecurity';
