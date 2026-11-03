import { IncidentBundle, refusal, type HostContainer, type IncidentLogs, type LastChange, type LogLine, type Refusal } from '@shipyard/schema';
import type { Db } from '../db.js';
import type { ServiceDeps } from '../deps.js';
import type { DeployCaller } from '../deploys/service.js';
import { readContainerConditions, snapshotContainers } from '../host/index.js';
import { MAX_TAIL_WAIT_MS, logsViewerOf, readLogsTail, tokenLogsScopeRefusal } from '../logs/service.js';
import { firstErrorIndex, incidentFacts } from './facts.js';

/**
 * One container's incident bundle, built on request (SHP-ADR-013; SHP-REQ-212, SHP-REQ-214,
 * SHP-REQ-215, SHP-REQ-216, SHP-REQ-243): the facts from fixed rules, its redacted logs since the
 * first error, its inspect state from the latest report (never its environment), and its owner's
 * last change. `GET /api/containers/:id/incident` and `shipyard_incident` both build it here.
 *
 * Who may read it is who may read the container's logs (SHP-ADR-011), because it carries them: an
 * admin or operator, or a `can_read_logs` token scoped to the container's app or stack. Nothing is
 * stored — the logs come through the agent's ordinary log job and are dropped once returned; the
 * only rows a read leaves are its audit events (`logs.view` from the log read, `incident.read`).
 */

/** The most log lines asked of the agent, and the most a bundle carries. */
export const INCIDENT_LOG_LINES = 2000;

/** Kept when no line looks like an error. */
export const INCIDENT_TAIL_LINES = 200;

export interface IncidentRef {
  containerId?: string;
  containerName?: string;
}

export interface IncidentOptions {
  logsTimeoutMs?: number;
  now?: Date;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** The first `sha256:…` string anywhere in a stack update's `digests` JSON, or null. */
function firstDigest(value: unknown): string | null {
  if (typeof value === 'string') return DIGEST.test(value) ? value : null;
  if (Array.isArray(value)) {
    for (const v of value) {
      const found = firstDigest(v);
      if (found !== null) return found;
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) {
      const found = firstDigest(v);
      if (found !== null) return found;
    }
  }
  return null;
}

/**
 * States in which a deploy or stack update never touched the host: held, refused, denied or
 * cancelled before it ran. "The last change" is the last one that ran, so these are skipped — a
 * refused deploy named beside an incident would point at a change that never happened.
 */
const NEVER_RAN_DEPLOY = ['queued', 'awaiting_approval', 'refused', 'cancelled'] as const;
const NEVER_RAN_UPDATE = ['queued', 'awaiting_approval', 'refused', 'denied', 'cancelled'] as const;

/** The newest deploy of a Deployed app that ran, or the newest update of an Operated stack that ran. */
export async function lastChangeOf(db: Db, container: Pick<HostContainer, 'tier' | 'app'>): Promise<LastChange | null> {
  const owner = container.app;
  if (owner === null) return null;
  if (container.tier === 'shipped') {
    const target = await db.deployTarget.findFirst({
      where: { app: { name: owner }, deploy: { dryRun: false }, state: { notIn: [...NEVER_RAN_DEPLOY] } },
      orderBy: { createdAt: 'desc' },
      select: { state: true, endedAt: true, createdAt: true, deploy: { select: { id: true, requestedSha: true } } },
    });
    if (target === null) return null;
    return {
      kind: 'deploy',
      id: target.deploy.id,
      at: (target.endedAt ?? target.createdAt).toISOString(),
      state: target.state,
      sha: target.deploy.requestedSha,
      digest: null,
    };
  }
  if (container.tier === 'operated') {
    const update = await db.stackUpdate.findFirst({
      where: { stackName: owner, state: { notIn: [...NEVER_RAN_UPDATE] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, state: true, endedAt: true, createdAt: true, digests: true },
    });
    if (update === null) return null;
    return {
      kind: 'stack-update',
      id: update.id,
      at: (update.endedAt ?? update.createdAt).toISOString(),
      state: update.state,
      sha: null,
      digest: firstDigest(update.digests),
    };
  }
  return null;
}

/** The lines a bundle keeps: from the first error to the end, else the last 200. */
export function incidentLogsOf(lines: readonly LogLine[]): Pick<IncidentLogs, 'from' | 'lines'> {
  const recent = lines.slice(-INCIDENT_LOG_LINES);
  const first = firstErrorIndex(recent);
  if (first >= 0) return { from: 'first-error', lines: recent.slice(first) };
  return { from: 'tail', lines: recent.slice(-INCIDENT_TAIL_LINES) };
}

export async function buildIncidentBundle(
  deps: ServiceDeps,
  caller: DeployCaller,
  ref: IncidentRef,
  options: IncidentOptions = {},
): Promise<IncidentBundle | Refusal> {
  const viewer = await logsViewerOf(deps, caller);
  if ('code' in viewer) return viewer;

  const containers = await snapshotContainers(deps.db);
  let found;
  if (ref.containerId !== undefined) {
    found = containers.find((c) => c.container.id === ref.containerId);
    if (found === undefined) return refusal('unknown_container', 'The agent does not report a container with that ID.');
  } else if (ref.containerName !== undefined) {
    const name = ref.containerName;
    const named = containers.filter((c) => c.container.name === name);
    const only = named[0];
    if (only === undefined) return refusal('unknown_container', `The agent does not report a container named ${name}.`);
    // Two hosts can each run a container of one name; reading the first would be a guess about whose logs.
    if (named.length > 1) return refusal('invalid_request', `More than one host reports a container named ${name}.`, 'Use its full 64-character ID from shipyard_host.');
    found = only;
  } else {
    return refusal('invalid_request', 'Name a container by its ID or its name.');
  }
  const { agentId, container } = found;

  // SHP-REQ-214: a token reads only containers of the apps and stacks it names, never Observed ones.
  if (viewer.type === 'token') {
    const outside = tokenLogsScopeRefusal(caller, container);
    if (outside !== null) return outside;
  }

  const read = await readLogsTail(deps, caller, { containerId: container.id, tail: INCIDENT_LOG_LINES }, options.logsTimeoutMs ?? MAX_TAIL_WAIT_MS);
  const allLines: LogLine[] = Array.isArray(read) ? read : [];
  const logs: IncidentLogs = Array.isArray(read) ? { ...incidentLogsOf(read), unavailable: null } : { from: 'tail', lines: [], unavailable: read };

  const row = (await readContainerConditions(deps.db)).find((c) => c.agentId === agentId && c.containerName === container.name);
  const condition = row === undefined ? null : { condition: row.condition, since: row.since };
  const lastChange = await lastChangeOf(deps.db, container);
  const facts = incidentFacts({ container, condition, lines: allLines.slice(-INCIDENT_LOG_LINES), lastChange });

  const bundle = IncidentBundle.parse({
    builtAt: (options.now ?? new Date()).toISOString(),
    container: { id: container.id, name: container.name, tier: container.tier, owner: container.app, compose: container.compose },
    condition: condition?.condition ?? null,
    failingSince: condition?.since.toISOString() ?? null,
    facts,
    inspect: {
      image: container.image,
      digest: container.digest,
      state: container.state,
      health: container.health,
      restartCount: container.restartCount,
      createdAt: container.createdAt,
      startedAt: container.startedAt,
      memoryBytes: container.stats?.memoryBytes ?? null,
      memoryLimitBytes: container.stats?.memoryLimitBytes ?? null,
      cpuPercent: container.stats?.cpuPercent ?? null,
    },
    logs,
    lastChange,
  });

  // SHP-REQ-243: who read which container's bundle. Counts only — never a line of the logs.
  await caller.audit({
    action: 'incident.read',
    entityType: 'container',
    entityId: container.id,
    after: {
      viewer: caller.actor?.label ?? null,
      containerName: container.name,
      app: container.app,
      tier: container.tier,
      condition: bundle.condition,
      logLines: bundle.logs.lines.length,
      logsUnavailable: bundle.logs.unavailable?.code ?? null,
    },
  });
  deps.logger.info({ containerId: container.id, logLines: bundle.logs.lines.length, facts: bundle.facts.length }, 'incident bundle built');
  return bundle;
}
