import type { ContainerEvent, ContainerHealth, HostContainer } from '@shipyard/schema';
import type { Logger } from 'pino';
import type { Db, Prisma } from '../db.js';

/**
 * Container history (SHP-ADR-013): the Engine events an agent reports, kept 30 days in
 * `container_event` (SHP-REQ-222), and per container a 30-minute health bucket — the worst health
 * seen and the failed checks — kept 7 days in `container_health` (SHP-REQ-223). Neither holds a
 * probe's output: that lives only on the latest snapshot, which each report replaces (SHP-REQ-224).
 *
 * Events are written by the agent's report (`storeContainerEvents`); buckets are folded inside
 * `storeHostInventory`'s transaction (`foldContainerHealth`). Restart loops (SHP-REQ-227) are
 * computed on read from the events, never stored.
 */

/** Events older than this are deleted by the container-history prune (SHP-REQ-222). */
export const CONTAINER_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Health buckets older than this are deleted by the container-history prune (SHP-REQ-223). */
export const CONTAINER_HEALTH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** One health bucket's width. */
export const HEALTH_BUCKET_MS = 30 * 60 * 1000;

/** Restarts this many or more within `RESTART_LOOP_WINDOW_MS` are a restart loop (SHP-REQ-227). */
export const RESTART_LOOP_RESTARTS = 3;

/** The window three restarts must fall within, ending within the last such window. */
export const RESTART_LOOP_WINDOW_MS = 15 * 60 * 1000;

/** The most events one incident bundle carries (`IncidentBundle.events`). */
export const BUNDLE_EVENTS_LIMIT = 500;

/** How far back a bundle's events reach (SHP-REQ-228). */
export const BUNDLE_EVENTS_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Stores the events of one report, skipping any already stored: a report re-sent after a failure
 * repeats its events, and (agent, container, kind, time) is unique. `dropped` — events the agent's
 * buffer could not hold — is logged as a warning and nothing else.
 */
export async function storeContainerEvents(
  db: Db,
  agentId: string,
  events: readonly ContainerEvent[],
  dropped: number,
  now: Date,
  logger?: Logger,
): Promise<void> {
  if (dropped > 0) logger?.warn({ agentId, droppedEvents: dropped }, 'the agent dropped container events its buffer could not hold');
  if (events.length === 0) return;
  await db.containerEvent.createMany({
    data: events.map((e) => ({
      agentId,
      containerId: e.containerId,
      containerName: e.containerName,
      kind: e.kind,
      at: new Date(e.at),
      exitCode: e.exitCode,
      health: e.health,
      receivedAt: now,
    })),
    skipDuplicates: true,
  });
}

/** Worst first is highest: a bucket keeps the highest rank it has seen. */
const HEALTH_RANK: Record<ContainerHealth, number> = { none: 0, healthy: 1, starting: 2, unhealthy: 3 };

function worse(a: string, b: ContainerHealth): ContainerHealth {
  const known = a in HEALTH_RANK ? (a as ContainerHealth) : 'none';
  return HEALTH_RANK[b] > HEALTH_RANK[known] ? b : known;
}

/** The start of the 30-minute UTC bucket `at` falls in. */
export function healthBucketOf(at: Date): Date {
  return new Date(Math.floor(at.getTime() / HEALTH_BUCKET_MS) * HEALTH_BUCKET_MS);
}

/**
 * Folds every container's health into its bucket for `now`, inside the caller's transaction: the
 * worse of the stored and the reported health, plus the failed checks (`exitCode !== 0`) in its
 * health log that started in the bucket after the newest check already counted. Writes only rows
 * that change, so a steady container costs one read per report for the whole inventory.
 */
export async function foldContainerHealth(
  tx: Prisma.TransactionClient,
  agentId: string,
  containers: readonly HostContainer[],
  now: Date,
): Promise<void> {
  if (containers.length === 0) return;
  const bucketStart = healthBucketOf(now);
  const bucketEnd = bucketStart.getTime() + HEALTH_BUCKET_MS;
  const stored = new Map(
    (await tx.containerHealth.findMany({ where: { agentId, bucketStart } })).map((r) => [r.containerName, r] as const),
  );

  const creates: Prisma.ContainerHealthCreateManyInput[] = [];
  const seen = new Set<string>();
  for (const c of containers) {
    // Two containers of one name cannot both run; the first reported wins, as a snapshot reads.
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    const row = stored.get(c.name);
    const watermark = row?.lastProbeStart?.getTime() ?? -Infinity;
    let failed = 0;
    let newest = watermark;
    for (const probe of c.healthLog ?? []) {
      const start = Date.parse(probe.start);
      if (Number.isNaN(start) || start <= watermark || start < bucketStart.getTime() || start >= bucketEnd) continue;
      if (probe.exitCode !== 0) failed += 1;
      if (start > newest) newest = start;
    }
    const lastProbeStart = newest === watermark ? (row?.lastProbeStart ?? null) : new Date(newest);

    if (row === undefined) {
      creates.push({ agentId, containerName: c.name, bucketStart, worstHealth: c.health, failedChecks: failed, lastProbeStart });
      continue;
    }
    const worstHealth = worse(row.worstHealth, c.health);
    if (worstHealth === row.worstHealth && failed === 0 && lastProbeStart === row.lastProbeStart) continue;
    await tx.containerHealth.update({
      where: { agentId_containerName_bucketStart: { agentId, containerName: c.name, bucketStart } },
      data: { worstHealth, failedChecks: { increment: failed }, lastProbeStart },
    });
  }
  if (creates.length > 0) await tx.containerHealth.createMany({ data: creates, skipDuplicates: true });
}

export interface HealthBucketRow {
  containerName: string;
  bucketStart: Date;
  worstHealth: string;
  failedChecks: number;
}

/** One agent's health buckets, oldest first. Reads only. */
export async function readHealthBuckets(db: Db, agentId: string): Promise<HealthBucketRow[]> {
  return db.containerHealth.findMany({
    where: { agentId },
    orderBy: [{ bucketStart: 'asc' }, { containerName: 'asc' }],
    select: { containerName: true, bucketStart: true, worstHealth: true, failedChecks: true },
  });
}

/** The fields of a stored event that restart loops read. */
export interface StartOrDie {
  kind: string;
  at: Date;
}

export interface RestartLoop {
  /** The most restarts within any 15 minutes ending in the last 15. */
  restarts: number;
  /** The first restart counted. */
  since: Date;
}

/**
 * Whether a container is in a restart loop (SHP-REQ-227), from its events oldest first. A restart
 * is a `start` that follows a `die` of the same container: that counts a policy restart and a
 * `docker restart` exactly once each, and Docker's own `restart` event is not counted again. A
 * loop is three or more restarts within any 15 minutes that ends within the 15 minutes before
 * `now`; it reports the busiest such window, the earliest of equals. Pure.
 */
export function restartLoopOf(events: readonly StartOrDie[], now: Date): RestartLoop | null {
  const starts: number[] = [];
  let previous: string | null = null;
  for (const e of events) {
    if (e.kind !== 'start' && e.kind !== 'die') continue;
    if (e.kind === 'start' && previous === 'die' && e.at.getTime() <= now.getTime()) starts.push(e.at.getTime());
    previous = e.kind;
  }
  starts.sort((a, b) => a - b);

  const recent = now.getTime() - RESTART_LOOP_WINDOW_MS;
  let best: RestartLoop | null = null;
  let first = 0;
  for (let last = 0; last < starts.length; last++) {
    const end = starts[last] ?? 0;
    while ((starts[first] ?? end) < end - RESTART_LOOP_WINDOW_MS) first += 1;
    if (end < recent) continue;
    const restarts = last - first + 1;
    if (restarts >= RESTART_LOOP_RESTARTS && (best === null || restarts > best.restarts)) {
      best = { restarts, since: new Date(starts[first] ?? end) };
    }
  }
  return best;
}

/** One container a reader asks about, by agent and name. */
export interface ContainerKey {
  agentId: string;
  containerName: string;
}

const loopKey = (agentId: string, containerName: string): string => `${agentId}\u0000${containerName}`;

/**
 * The restart loops among `containers` at `now`, keyed by `restartLoopKey`. Reads the starts and
 * dies of only those containers in the last 30 minutes, and for a container whose earliest one there
 * is a start, the single event before it — enough to tell whether that start followed a die.
 */
export async function readRestartLoops(db: Db, containers: readonly ContainerKey[], now: Date): Promise<Map<string, RestartLoop>> {
  const loops = new Map<string, RestartLoop>();
  if (containers.length === 0) return loops;
  const since = new Date(now.getTime() - 2 * RESTART_LOOP_WINDOW_MS);
  const rows = await db.containerEvent.findMany({
    where: {
      OR: containers.map((c) => ({ agentId: c.agentId, containerName: c.containerName })),
      kind: { in: ['start', 'die'] },
      at: { gte: since, lte: now },
    },
    orderBy: [{ at: 'asc' }, { kind: 'asc' }],
    select: { agentId: true, containerName: true, kind: true, at: true },
  });
  const byContainer = new Map<string, StartOrDie[]>();
  for (const r of rows) {
    const k = loopKey(r.agentId, r.containerName);
    let list = byContainer.get(k);
    if (list === undefined) {
      list = [];
      byContainer.set(k, list);
    }
    list.push({ kind: r.kind, at: r.at });
  }
  for (const c of containers) {
    const k = loopKey(c.agentId, c.containerName);
    const list = byContainer.get(k);
    // Fewer than three starts in the window cannot be a loop; no further read is needed.
    if (list === undefined || list.filter((e) => e.kind === 'start').length < RESTART_LOOP_RESTARTS) continue;
    if (list[0]?.kind === 'start') {
      const before = await db.containerEvent.findFirst({
        where: { agentId: c.agentId, containerName: c.containerName, kind: { in: ['start', 'die'] }, at: { lt: since } },
        orderBy: { at: 'desc' },
        select: { kind: true, at: true },
      });
      if (before !== null) list.unshift(before);
    }
    const loop = restartLoopOf(list, now);
    if (loop !== null) loops.set(k, loop);
  }
  return loops;
}

/** The key `readRestartLoops` files a container under. */
export function restartLoopKey(agentId: string, containerName: string): string {
  return loopKey(agentId, containerName);
}

/**
 * One container's events in the 24 hours before `now`, oldest first, for its incident bundle
 * (SHP-REQ-228): the newest 500 when there are more.
 */
export async function readBundleEvents(db: Db, agentId: string, containerName: string, now: Date): Promise<ContainerEvent[]> {
  const rows = await db.containerEvent.findMany({
    where: { agentId, containerName, at: { gte: new Date(now.getTime() - BUNDLE_EVENTS_WINDOW_MS), lte: now } },
    orderBy: [{ at: 'desc' }, { id: 'desc' }],
    take: BUNDLE_EVENTS_LIMIT,
    select: { kind: true, at: true, containerId: true, containerName: true, exitCode: true, health: true },
  });
  return rows.reverse().map((r) => ({
    kind: r.kind as ContainerEvent['kind'],
    at: r.at.toISOString(),
    containerId: r.containerId,
    containerName: r.containerName,
    exitCode: r.exitCode,
    health: r.health as ContainerEvent['health'],
  }));
}
