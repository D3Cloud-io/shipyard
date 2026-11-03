import { Alert, Spinner } from '@d3cloud/ui';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { LOGS_FOLLOW_SECONDS, logTime, type ActionPhase } from '../../lib/actions';
import { host } from '../../lib/host';
import {
  FOLLOW_POLL_MS,
  followRestart,
  reportFrom,
  restartActionOf,
  withReport,
  type FollowStatus,
  type FollowStep,
  type Report,
} from '../../lib/incident';
import './incident.css';

/**
 * A confirmed restart, followed (SHP-T-19.7, SHP-ADR-013, SHP-REQ-211/242): a short checklist that
 * ends in "Healthy again", "The same error is back" or "The restart did not go through", and says
 * which. The rule is `followRestart`; this reads the host snapshot while it applies and tells the
 * sheet when the restart has finished (to follow the logs) and when the follow has ended (to stop).
 * It reads only after the action succeeded: before that the old container is still what reports.
 */

const MARK: Record<FollowStep['mark'], string> = { done: '✓', active: '…', pending: '○', failed: '✕' };

function stepTime(at: number | null): string | null {
  return at === null ? null : logTime(new Date(at).toISOString());
}

export interface RestartFollowProps {
  /** The container's name: a restart keeps its ID, a recreate would not, and the name survives both. */
  name: string;
  phase: ActionPhase;
  /** The restart finished: follow its logs. */
  onRestarted?: () => void;
  /** The follow ended, one way or another. */
  onSettled?: (status: FollowStatus) => void;
  /** Offered beside the outcome (Copy for Claude): always in this one place while a follow is on screen, so it never shows twice. */
  actions?: ReactNode;
  pollMs?: number;
}

export function RestartFollow({ name, phase, onRestarted, onSettled, actions, pollMs = FOLLOW_POLL_MS }: RestartFollowProps) {
  const action = useMemo(() => restartActionOf(phase), [phase]);
  const [reports, setReports] = useState<readonly Report[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const view = followRestart({ name, action, reports, now });

  const endedAt = action.kind === 'succeeded' ? action.endedAt : null;
  const polling = endedAt !== null && !view.done;

  useEffect(() => {
    if (!polling) return;
    let live = true;
    const read = () => {
      host
        .snapshot()
        .then((res) => {
          if (!live) return;
          setReports((prev) => withReport(prev, reportFrom(res, name)));
          setNow(Date.now());
        })
        .catch(() => {
          // One failed read is one missed look; the next poll tries again.
          if (live) setNow(Date.now());
        });
    };
    read();
    const timer = setInterval(read, pollMs);
    // The five minutes end even if no read lands after them.
    const deadline = setTimeout(
      () => {
        setNow(Date.now());
      },
      Math.max(0, endedAt + LOGS_FOLLOW_SECONDS * 1000 - Date.now()) + 50,
    );
    return () => {
      live = false;
      clearInterval(timer);
      clearTimeout(deadline);
    };
  }, [polling, name, pollMs, endedAt]);

  const restarted = useRef(onRestarted);
  const settled = useRef(onSettled);
  useEffect(() => {
    restarted.current = onRestarted;
    settled.current = onSettled;
  });
  const fired = useRef({ restarted: false, settled: false });
  useEffect(() => {
    if (action.kind === 'succeeded' && !fired.current.restarted) {
      fired.current.restarted = true;
      restarted.current?.();
    }
  }, [action.kind]);
  useEffect(() => {
    if (view.done && !fired.current.settled) {
      fired.current.settled = true;
      settled.current?.(view.status);
    }
  }, [view.done, view.status]);

  const output = phase.kind === 'done' ? phase.status.output : null;

  return (
    <section className="shp-inc-follow" aria-label="Restart progress">
      <div className="shp-inc-follow__head" role="status" aria-live="polite">
        {view.done ? null : <Spinner size="sm" />}
        <span>{view.headline}</span>
      </div>
      {view.status === 'not-sent' ? (
        <Alert tone="danger" title={view.detail ?? undefined}>
          {view.fix ?? 'Nothing was restarted.'}
        </Alert>
      ) : view.detail === null ? null : (
        <p className="shp-inc-follow__detail">{view.detail}</p>
      )}
      {view.status === 'not-sent' ? null : (
        <ol className="shp-inc-steps">
          {view.steps.map((step) => {
            const time = stepTime(step.at);
            return (
              <li key={step.id} className="shp-inc-step" data-mark={step.mark}>
                <span className="shp-inc-step__mark" aria-hidden="true">
                  {MARK[step.mark]}
                </span>
                <span className="shp-inc-step__label">{step.label}</span>
                {time === null ? null : <span className="shp-inc-step__time">{time}</span>}
              </li>
            );
          })}
        </ol>
      )}
      {output === null || output.trim() === '' ? null : (
        <details className="shp-disclosure">
          <summary>Compose output</summary>
          <pre className="shp-action-output">{output}</pre>
        </details>
      )}
      {actions === undefined || actions === null ? null : <div className="shp-inc-follow__actions">{actions}</div>}
    </section>
  );
}
