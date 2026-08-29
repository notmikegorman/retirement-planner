/**
 * NODE FACE of the candidate compiler. The module moved whole to
 * src/store/search/compile.ts in Phase 5 of the browser port — it was always
 * environment-neutral (a pure JSON transform over the public Scenario
 * contract); only its address changed, so the browser bundle can import it
 * without reaching under src/server. Every WHY lives on the module itself.
 */
export * from '../../store/search/compile';
