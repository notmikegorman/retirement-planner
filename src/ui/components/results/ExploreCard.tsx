/**
 * Explore — the follow-up questions, answered against the plan as it stands.
 *
 * The plan answers one question: will this work? Explore answers the obvious
 * next four ("what is the earliest year we could stop working?", "how much
 * could we spend?", …) by attaching the matching sweep to a COPY of the plan
 * and running that. Nothing has to be configured and nothing is saved:
 * plan.json is never given a solver.
 *
 * Every sweep deliberately overrides part of the plan (a retirement-year sweep
 * replaces the retirement dates, and so on), so each answer states what it
 * ignored — solverOverrideNote.
 */
import { useEffect, useRef, useState } from 'react';
import type { RunMode, Scenario, SolverResult } from '../../../shared/types';
import { api, pollRun } from '../../api';
import { solverOverrideNote } from '../scenarios/scenarioHelpers';
import { SolverOutputView } from './SolverViews';
import {
  EXPLORE_QUESTIONS,
  exploreAnswerLine,
  exploreSpec,
  scenarioWithSolver,
  type ExploreQuestion,
} from './resultsData';

export interface ExploreRunParams {
  mode: RunMode;
  paths?: number;
  seed?: number;
}

export interface ExploreCardProps {
  /** The plan being viewed; sweeps run against a copy of it. */
  plan: Scenario;
  /** Success target the answers are phrased against. */
  target: number;
  /** Today's living + charitable spending, per year (sets the spending curve's range). */
  annualSpend: number;
  /** Mode / paths / seed from the run controls above. */
  runParams: ExploreRunParams;
  /** True while a normal run is in flight — one run at a time. */
  disabled?: boolean;
}

interface RunningState {
  question: ExploreQuestion;
  progress: number;
  message?: string;
}

interface AnswerState {
  question: ExploreQuestion;
  out: SolverResult;
}

export function ExploreCard({
  plan,
  target,
  annualSpend,
  runParams,
  disabled,
}: ExploreCardProps) {
  const [running, setRunning] = useState<RunningState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<AnswerState | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const explore = async (question: ExploreQuestion) => {
    setError(null);
    setAnswer(null);
    setRunning({ question, progress: 0 });
    try {
      const spec = exploreSpec(question.id, {
        currentYear: new Date().getFullYear(),
        annualSpend,
      });
      const { runId } = await api.startRun({
        scenario: scenarioWithSolver(plan, spec),
        mode: runParams.mode,
        ...(runParams.paths !== undefined ? { paths: runParams.paths } : {}),
        ...(runParams.seed !== undefined ? { seed: runParams.seed } : {}),
      });
      const done = await pollRun(runId, (p) => {
        if (alive.current) setRunning({ question, progress: p.progress, message: p.message });
      });
      if (done.status !== 'done' || !done.result) {
        throw new Error(done.error ?? 'The run failed');
      }
      const out = done.result.solverOutput;
      if (!out) throw new Error('The run finished but produced no answer.');
      if (alive.current) setAnswer({ question, out });
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setRunning(null);
    }
  };

  const busy = running != null || disabled === true;
  const progressPct = Math.round((running?.progress ?? 0) * 100);

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Explore</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Answers to the next questions, run against your plan exactly as it stands. Each one runs
        many full simulations — one per year, age or spending level — so it takes considerably
        longer than a single run, and nothing about the plan is changed.
      </p>

      <div className="explore-buttons">
        {EXPLORE_QUESTIONS.map((q) => (
          <button
            key={q.id}
            title={q.detail}
            disabled={busy}
            className={answer?.question.id === q.id ? 'primary' : undefined}
            onClick={() => void explore(q)}
          >
            {q.question}
          </button>
        ))}
      </div>

      {running && (
        <>
          <div className="row" style={{ marginTop: 12 }}>
            <div className="progress-outer">
              <div className="progress-inner" style={{ width: `${progressPct}%` }} />
            </div>
            <span className="muted" style={{ minWidth: 44, textAlign: 'right' }}>
              {progressPct}%
            </span>
          </div>
          <div className="muted" style={{ marginTop: 6 }}>
            {running.question.question}
            {running.message ? ` — ${running.message}` : ''}
          </div>
        </>
      )}

      {!running && disabled === true && (
        <div className="muted" style={{ marginTop: 10 }}>
          Waiting for the current run to finish.
        </div>
      )}

      {error && (
        <div className="error-banner" style={{ marginTop: 12, marginBottom: 0 }}>
          {error}
        </div>
      )}

      {answer && (
        <div style={{ marginTop: 18 }}>
          <h3 style={{ marginBottom: 4 }}>{answer.question.question}</h3>
          <div className={`explore-answer ${answer.out.answer !== undefined ? 'good' : 'warn'}`}>
            {exploreAnswerLine(answer.question.id, answer.out, target)}
          </div>
          <div className="field-help" style={{ marginTop: 8, marginBottom: 14 }}>
            {solverOverrideNote(answer.out.spec.type)}
          </div>
          <SolverOutputView out={answer.out} target={target} />
        </div>
      )}
    </div>
  );
}
