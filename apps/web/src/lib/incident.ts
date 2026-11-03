// Types only, except `renderIncidentBundle`, which is imported on demand (see `renderBundle`).
import type { ContainerHealth, ContainerState, HostResponse, IncidentBundle } from '@shipyard/schema';
import { request } from './api';
import { LOGS_FOLLOW_SECONDS, resultWords, type ActionPhase } from './actions';
import { CONTAINER_STATE_WORDS, HEALTH_WORDS } from './words';

/**
 * Following a restart, and Copy for Claude (SHP-T-19.7, SHP-ADR-013, SHP-REQ-210/211/212/242).
 *
 * A restart that has been confirmed and sent is followed: the sheet turns the logs to follow
 * (SHP-ADR-011) and reads the host snapshot every few seconds. The agent reports once a minute, so
 * "healthy" is not one look: the container must be `running` and healthy (or have no healthcheck)
 * in three distinct reports in a row, all received after the restart finished — a report from
 * before it would count the old container. Anything else wrong in a report after the restart ends
 * the follow as "failing again", and so does nothing settling in the five minutes a log follow lasts.
 * `followRestart` is that rule as a pure function, so it is tested without timers.
 *
 * The bundle is built by the server on request and never stored (SHP-REQ-215); the console only
 * asks for it, renders it with the one shared renderer, and puts it on the clipboard.
 */

// ── The bundle ───────────────────────────────────────────────────────────

export const incidents = {
  bundle: (containerId: string, signal?: AbortSignal): Promise<IncidentBundle> =>
    request<IncidentBundle>(`/api/containers/${encodeURIComponent(containerId)}/incident`, signal === undefined ? {} : { signal }),
};

/**
 * The bundle as Markdown, by the one renderer `shipyard_incident` uses. Loaded on demand: the
 * schema package carries every zod schema, which the rest of the console deliberately never bundles.
 */
export async function renderBundle(bundle: IncidentBundle): Promise<string> {
  const { renderIncidentBundle } = await import('@shipyard/schema');
  return renderIncidentBundle(bundle);
}

function count(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** What was copied, so nobody has to open the clipboard to know (SHP-REQ-212). */
export function copiedWords(bundle: Pick<IncidentBundle, 'facts' | 'logs'>): string {
  const facts = count(bundle.facts.length, 'fact', 'facts');
  const { logs } = bundle;
  if (logs.unavailable !== null) {
    return `Copied ${facts} for Claude — logs unavailable: ${logs.unavailable.message.replace(/[.\s]+$/, '')}. Built just now, stored nowhere.`;
  }
  const from = logs.from === 'first-error' ? 'since the first error' : 'latest lines';
  return `Copied ${facts} and ${count(logs.lines.length, 'log line', 'log lines')} (${from}) for Claude — built just now, stored nowhere.`;
}

// ── Following a restart ──────────────────────────────────────────────────

/** Healthy reports in a row that end the follow (SHP-REQ-211). */
export const HEALTHY_REPORTS_NEEDED = 3;

/** How often the snapshot is read while following; the agent itself reports every 60 s. */
export const FOLLOW_POLL_MS = 5_000;

/** The restart action, reduced to what the follow needs. Times are epoch ms on the server's clock. */
export type RestartAction =
  /** The request is on its way or queued. */
  | { kind: 'sending' }
  | { kind: 'running'; startedAt: number | null }
  | { kind: 'succeeded'; startedAt: number | null; endedAt: number; words: string }
  /** Refused, lost, or failed on the host. */
  | { kind: 'failed'; message: string; fix: string | null };

/** One agent report, seen through this container; `state` is null when the report did not list it. */
export interface Report {
  at: number;
  state: ContainerState | null;
  health: ContainerHealth | null;
}

export function restartActionOf(phase: ActionPhase): RestartAction {
  switch (phase.kind) {
    case 'idle':
    case 'starting':
      return { kind: 'sending' };
    case 'running':
      return { kind: 'running', startedAt: phase.status.startedAt === null ? null : Date.parse(phase.status.startedAt) };
    case 'refused':
      return { kind: 'failed', message: phase.error.message, fix: phase.error.fix };
    case 'done': {
      const { status } = phase;
      if (status.state === 'succeeded') {
        const endedAt = Date.parse(status.endedAt ?? status.createdAt);
        return {
          kind: 'succeeded',
          startedAt: status.startedAt === null ? null : Date.parse(status.startedAt),
          endedAt,
          words: resultWords(status),
        };
      }
      return status.refusal === null
        ? { kind: 'failed', message: resultWords(status), fix: null }
        : { kind: 'failed', message: status.refusal.message, fix: status.refusal.fix };
    }
  }
}

/** The container's state in one agent report; null when the response holds no report at all. */
export function reportFrom(res: HostResponse, name: string): Report | null {
  const host = res.hosts.find((h) => h.inventory.containers.some((c) => c.name === name)) ?? res.hosts[0];
  if (host === undefined) return null;
  const at = Date.parse(host.reportedAt);
  if (Number.isNaN(at)) return null;
  const found = host.inventory.containers.find((c) => c.name === name);
  return { at, state: found?.state ?? null, health: found?.health ?? null };
}

/** Adds a report unless that report (by its time) is already held: a poll between reports sees the same one. */
export function withReport(reports: readonly Report[], report: Report | null): readonly Report[] {
  if (report === null || reports.some((r) => r.at === report.at)) return reports;
  return [...reports, report].sort((a, b) => a.at - b.at);
}

export type FollowStatus =
  /** Not finished restarting yet. */
  | 'restarting'
  /** Restarted; counting healthy reports. */
  | 'checking'
  | 'healthy'
  | 'failing'
  | 'not-sent'
  | 'unsettled';

export type StepMark = 'done' | 'active' | 'pending' | 'failed';

export interface FollowStep {
  id: 'stopped' | 'started' | 'health' | 'result';
  label: string;
  /** Epoch ms, when it is known. */
  at: number | null;
  mark: StepMark;
}

export interface FollowView {
  status: FollowStatus;
  headline: string;
  detail: string | null;
  /** The refusal's fix when the restart did not go through. */
  fix: string | null;
  steps: FollowStep[];
  /** Consecutive healthy reports so far. */
  passed: number;
  /** The follow has ended: stop polling. */
  done: boolean;
}

export interface FollowInput {
  name: string;
  action: RestartAction;
  /** Every distinct report seen, oldest first. */
  reports: readonly Report[];
  now: number;
}

/** A report that says the container is failing: Docker restarting it, or its healthcheck failing. */
function isFailing(r: Report): boolean {
  return r.state === 'restarting' || r.state === 'exited' || r.state === 'dead' || r.health === 'unhealthy';
}

function isHealthy(r: Report): boolean {
  return r.state === 'running' && (r.health === 'healthy' || r.health === 'none');
}

/** "Running · starting", "Exited"; what the last report said. */
export function lastSeenWords(r: Report): string {
  if (r.state === null) return 'not in the last report';
  const health = r.health === null ? '' : HEALTH_WORDS[r.health];
  return health === '' ? CONTAINER_STATE_WORDS[r.state] : `${CONTAINER_STATE_WORDS[r.state]} · ${health}`;
}

const WINDOW_WORDS = `${String(LOGS_FOLLOW_SECONDS / 60)} minutes`;

export function followRestart({ name, action, reports, now }: FollowInput): FollowView {
  const pending = (id: FollowStep['id'], label: string): FollowStep => ({ id, label, at: null, mark: 'pending' });
  const health = pending('health', `Health check passed (0 of ${String(HEALTHY_REPORTS_NEEDED)})`);
  const result = pending('result', 'Healthy again');

  if (action.kind === 'failed') {
    return {
      status: 'not-sent',
      headline: 'The restart did not go through',
      detail: action.message,
      fix: action.fix,
      steps: [{ id: 'result', label: 'The restart did not go through', at: null, mark: 'failed' }],
      passed: 0,
      done: true,
    };
  }
  if (action.kind === 'sending' || action.kind === 'running') {
    const startedAt = action.kind === 'running' ? action.startedAt : null;
    return {
      status: 'restarting',
      headline: `Restarting ${name}`,
      detail: 'Shipyard has the request; the agent is carrying it out.',
      fix: null,
      steps: [
        startedAt === null ? { id: 'stopped', label: `Stopping ${name}`, at: null, mark: 'active' } : { id: 'stopped', label: `Stopped ${name}`, at: startedAt, mark: 'done' },
        { id: 'started', label: `Starting ${name}`, at: null, mark: startedAt === null ? 'pending' : 'active' },
        health,
        result,
      ],
      passed: 0,
      done: false,
    };
  }

  // Only reports received after the restart finished describe the new container.
  const after = reports.filter((r) => r.at > action.endedAt);
  const stopped: FollowStep = { id: 'stopped', label: `Stopped ${name}`, at: action.startedAt, mark: 'done' };
  const started: FollowStep = { id: 'started', label: action.words, at: action.endedAt, mark: 'done' };
  const last = after.at(-1);
  const healthLabel = (n: number) =>
    `${last?.health === 'none' ? 'Reported running' : 'Health check passed'} (${String(n)} of ${String(HEALTHY_REPORTS_NEEDED)})`;

  let passed = 0;
  for (const r of after) {
    if (isFailing(r)) {
      return {
        status: 'failing',
        headline: 'Failing again',
        detail: `${name} reported ${lastSeenWords(r).toLowerCase()} after the restart.`,
        fix: null,
        steps: [stopped, started, { id: 'health', label: healthLabel(passed), at: r.at, mark: 'failed' }, { id: 'result', label: 'The same error is back', at: r.at, mark: 'failed' }],
        passed,
        done: true,
      };
    }
    passed = isHealthy(r) ? passed + 1 : 0;
    if (passed >= HEALTHY_REPORTS_NEEDED) {
      return {
        status: 'healthy',
        headline: 'Healthy again',
        detail: `${name} has reported ${r.health === 'none' ? 'running' : 'healthy'} ${String(HEALTHY_REPORTS_NEEDED)} times in a row.`,
        fix: null,
        steps: [stopped, started, { id: 'health', label: healthLabel(passed), at: r.at, mark: 'done' }, { id: 'result', label: 'Healthy again', at: r.at, mark: 'done' }],
        passed,
        done: true,
      };
    }
  }

  const deadline = action.endedAt + LOGS_FOLLOW_SECONDS * 1000;
  const seen = last === undefined ? 'It has not been in a report since the restart.' : `Last seen: ${lastSeenWords(last)}.`;
  if (now >= deadline) {
    return {
      status: 'unsettled',
      headline: `Still not settled after ${WINDOW_WORDS}`,
      detail: seen,
      fix: null,
      steps: [stopped, started, { id: 'health', label: healthLabel(passed), at: last?.at ?? null, mark: 'failed' }, { id: 'result', label: `Not settled after ${WINDOW_WORDS}`, at: deadline, mark: 'failed' }],
      passed,
      done: true,
    };
  }
  return {
    status: 'checking',
    headline: `Following ${name} until it is healthy again`,
    detail: `${seen} The agent reports about once a minute.`,
    fix: null,
    steps: [stopped, started, { id: 'health', label: healthLabel(passed), at: last?.at ?? null, mark: 'active' }, result],
    passed,
    done: false,
  };
}
