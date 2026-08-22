/**
 * Engine entry point. The server's simWorker imports `execute`, which
 * dispatches on the scenario: a scenario with a solver spec runs the solver
 * sweep (runSolver); a plain scenario runs a single simulation
 * (runSimulation). Both are pure and deterministic given input + seed.
 */

import type { ProgressFn, RunResult, SimulationInput } from '../shared/types';
import { runSimulation } from './simulate';
import { runSolver } from './solvers';

export function execute(input: SimulationInput, onProgress?: ProgressFn): RunResult {
  return input.scenario.solver ? runSolver(input, onProgress) : runSimulation(input, onProgress);
}

export { runSimulation } from './simulate';
export { runSolver, scenarioWithDeath } from './solvers';
