/**
 * NODE FACE of the search statistics. The module moved whole to
 * src/store/search/stats.ts in Phase 5 of the browser port — it was always
 * environment-neutral (pure arithmetic on seed series); only its address
 * changed. Every WHY lives on the module itself.
 */
export * from '../../store/search/stats';
