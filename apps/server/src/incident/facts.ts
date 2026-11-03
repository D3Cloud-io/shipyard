import type { HostContainer, IncidentCondition, IncidentFact, LastChange, LogLine } from '@shipyard/schema';

/**
 * An incident's facts from fixed rules (SHP-ADR-013; SHP-REQ-216): log errors, the failing
 * condition, Docker's restart count and state, memory against its limit, and the last change — in
 * time order, undated facts last. Pure: no model, no network, nothing read but its arguments.
 * Exit codes and OOM kills join these rules once the server keeps container events (SHP-P-20).
 */

/** A line that looks like an error. A fixed rule, so the same logs always give the same facts. */
export const ERROR_LINE = /\b(error|err|fatal|panic|exception|failed|failure|refused|denied|timed? ?out|unhealthy)\b/i;

/** Memory at or above this share of the container's limit is a fact worth stating. */
export const MEMORY_FACT_RATIO = 0.7;

const FIRST_ERROR_CHARS = 300;
const FACT_CHARS = 500;
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
  container: Pick<HostContainer, 'state' | 'restartCount' | 'startedAt' | 'stats'>;
  /** The stored condition row for the container, when it is failing. */
  condition: { condition: IncidentCondition; since: Date } | null;
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
  const facts: IncidentFact[] = [];

  if (condition !== null) {
    const verb = condition.condition === 'unhealthy' ? 'Unhealthy' : 'Restarting';
    facts.push({ kind: 'failing', at: condition.since.toISOString(), text: `${verb} since ${condition.since.toISOString()}` });
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
