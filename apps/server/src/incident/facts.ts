import type { ContainerEvent, HostContainer, IncidentCondition, IncidentFact, LastChange, LogLine } from '@shipyard/schema';

/**
 * An incident's facts from fixed rules (SHP-ADR-013; SHP-REQ-216): log errors, the failing
 * condition, Docker's restart count and state, memory against its limit, and the last change — in
 * time order, undated facts last. Pure: no model, no network, nothing read but its arguments.
 * From the events the server keeps (SHP-P-20): a restart loop (SHP-REQ-227), the last non-zero exit
 * code and an OOM kill in the last 24 hours.
 */

/** A line that looks like an error. A fixed rule, so the same logs always give the same facts. */
export const ERROR_LINE = /\b(error|err|fatal|panic|exception|failed|failure|refused|denied|timed? ?out|unhealthy)\b/i;

/** Memory at or above this share of the container's limit is a fact worth stating. */
export const MEMORY_FACT_RATIO = 0.7;

const FIRST_ERROR_CHARS = 300;
const FACT_CHARS = 500;
const CONDITION_VERB: Record<IncidentCondition, string> = { unhealthy: 'Unhealthy', restarting: 'Restarting', 'restart-loop': 'In a restart loop' };

const STATES_WORTH_STATING = new Set(['exited', 'dead', 'restarting', 'paused']);

export function looksLikeError(line: Pick<LogLine, 'text'>): boolean {
  return ERROR_LINE.test(line.text);
}

/** The index of the first line that looks like an error, or -1. */
export function firstErrorIndex(lines: readonly LogLine[]): number {
  return lines.findIndex(looksLikeError);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** "3d 4h", "2h 5m", "4m", "30s": the two largest units, enough to read at a glance. */
export function formatDuration(ms: number): string {
  const s = Math.floor(Math.abs(ms) / 1000);
  const units: [number, string][] = [
    [Math.floor(s / 86_400), 'd'],
    [Math.floor((s % 86_400) / 3600), 'h'],
    [Math.floor((s % 3600) / 60), 'm'],
    [s % 60, 's'],
  ];
  const first = units.findIndex(([n]) => n > 0);
  if (first < 0) return '0s';
  return units
    .slice(first, first + 2)
    .filter(([n]) => n > 0)
    .map(([n, u]) => `${String(n)}${u}`)
    .join(' ');
}

export interface FactsInput {
  container: Pick<HostContainer, 'state' | 'restartCount' | 'startedAt' | 'stats' | 'exitCode' | 'oomKilled'>;
  /** Why the container is failing and since when — a restart loop, else its stored condition row. */
  condition: { condition: IncidentCondition; since: Date } | null;
  /** Its restart loop, when it is in one (SHP-REQ-227). */
  restartLoop?: { restarts: number; since: Date } | null;
  /** Its events in the last 24 hours, oldest first. */
  events?: readonly ContainerEvent[];
  /** Every line read for the bundle (the whole tail, not only those kept). */
  lines: readonly LogLine[];
  lastChange: LastChange | null;
}

function lastChangeText(change: LastChange, failingSince: Date | null): string {
  const what = change.kind === 'deploy' ? `Last deploy${change.sha === null ? '' : ` ${change.sha.slice(0, 7)}`}` : 'Last update';
  const base = `${what} ${change.state} at ${change.at}`;
  if (failingSince === null) return base;
  const delta = failingSince.getTime() - new Date(change.at).getTime();
  return `${base}, ${formatDuration(delta)} ${delta >= 0 ? 'before' : 'after'} it began failing`;
}

/** The facts for one container, dated ones in ascending time, undated ones last in rule order. */
export function incidentFacts(input: FactsInput): IncidentFact[] {
  const { container, condition, lines, lastChange } = input;
  const events = input.events ?? [];
  const facts: IncidentFact[] = [];

  if (condition !== null) {
    facts.push({ kind: 'failing', at: condition.since.toISOString(), text: `${CONDITION_VERB[condition.condition]} since ${condition.since.toISOString()}` });
  }
  const loop = input.restartLoop ?? null;
  if (loop !== null) {
    facts.push({ kind: 'restart-loop', at: loop.since.toISOString(), text: `Restarted ${String(loop.restarts)} times in 15 minutes.` });
  }

  // The last die's code is dated; Docker's State.ExitCode stands in when no die was kept.
  const lastDie = events.filter((e) => e.kind === 'die' && e.exitCode !== null).at(-1);
  if (lastDie !== undefined && lastDie.exitCode !== null && lastDie.exitCode !== 0) {
    facts.push({ kind: 'exit', at: lastDie.at, text: `Exited with code ${String(lastDie.exitCode)}` });
  } else if (lastDie === undefined && container.exitCode !== undefined && container.exitCode !== 0) {
    facts.push({ kind: 'exit', at: null, text: `Docker reports its last exit code as ${String(container.exitCode)}` });
  }

  const ooms = events.filter((e) => e.kind === 'oom');
  const lastOom = ooms.at(-1);
  if (lastOom !== undefined) {
    const times = ooms.length === 1 ? '' : ` ${String(ooms.length)} times in 24 hours`;
    facts.push({ kind: 'oom', at: lastOom.at, text: `Killed for running out of memory${times}` });
  } else if (container.oomKilled === true) {
    facts.push({ kind: 'oom', at: null, text: 'Docker reports its last run was killed for running out of memory' });
  }
  if (container.restartCount > 0) {
    const times = container.restartCount === 1 ? 'once' : `${String(container.restartCount)} times`;
    facts.push({ kind: 'restarts', at: container.startedAt, text: `Docker has restarted it ${times}` });
  }
  if (STATES_WORTH_STATING.has(container.state)) {
    facts.push({ kind: 'state', at: null, text: `Docker reports it ${container.state}` });
  }

  const errors = lines.filter(looksLikeError);
  const first = errors[0];
  if (first !== undefined) {
    facts.push({ kind: 'log-error', at: first.at, text: `First error: ${truncate(first.text.trim(), FIRST_ERROR_CHARS)}` });
    if (errors.length > 1) {
      facts.push({ kind: 'log-error', at: null, text: `${String(errors.length)} lines look like errors` });
    }
  }

  const stats = container.stats;
  if (stats !== null && stats.memoryLimitBytes !== null && stats.memoryLimitBytes > 0) {
    const ratio = stats.memoryBytes / stats.memoryLimitBytes;
    if (ratio >= MEMORY_FACT_RATIO) {
      facts.push({ kind: 'memory', at: null, text: `Memory at ${String(Math.round(ratio * 100))}% of its limit` });
    }
  }

  if (lastChange !== null) {
    facts.push({ kind: 'last-change', at: lastChange.at, text: lastChangeText(lastChange, condition?.since ?? null) });
  }

  const keyed = facts.map((fact, i) => ({ fact: { ...fact, text: truncate(fact.text, FACT_CHARS) }, i, t: fact.at === null ? NaN : Date.parse(fact.at) }));
  keyed.sort((a, b) => {
    const aDated = !Number.isNaN(a.t);
    const bDated = !Number.isNaN(b.t);
    if (aDated && bDated) return a.t - b.t || a.i - b.i;
    if (aDated !== bDated) return aDated ? -1 : 1;
    return a.i - b.i;
  });
  return keyed.map((k) => k.fact);
}
