import type { ContainerEvent, ContainerHealth, HostContainer } from '@shipyard/schema';
import type { Logger } from 'pino';
import { Prisma, type Db } from '../db.js';

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

/** The start of the 30-minute UTC bucket `at` falls in. */
export function healthBucketOf(at: Date): Date {
  return new Date(Math.floor(at.getTime() / HEALTH_BUCKET_MS) * HEALTH_BUCKET_MS);
}

/**
 * Folds every container's health into the health buckets, inside the caller's transaction, in one
 * statement. The bucket for `now` takes the worse of the stored and the reported health. Each failed
 * check (`exitCode !== 0`) not counted before goes into the bucket its own start falls in — the
 * current one or the one before, since a report can first show a check that started before a
 * boundary — so none is lost or counted twice (SHP-REQ-223). "Counted before" is the newest check
 * start stored on the container's current or previous bucket, so the watermark crosses boundaries.
 * The database keeps the worse health and the newer watermark, so a re-sent report changes nothing.
 */
export async function foldContainerHealth(
  tx: Prisma.TransactionClient,
  agentId: string,
  containers: readonly HostContainer[],
  now: Date,
): Promise<void> {
  if (containers.length === 0) return;
  const current = healthBucketOf(now);
  const previous = new Date(current.getTime() - HEALTH_BUCKET_MS);
  const watermarks = new Map<string, number>();
  for (const r of await tx.containerHealth.findMany({
    where: { agentId, bucketStart: { in: [previous, current] }, lastProbeStart: { not: null } },
    select: { containerName: true, lastProbeStart: true },
  })) {
    const at = r.lastProbeStart?.getTime() ?? -Infinity;
    if (at > (watermarks.get(r.containerName) ?? -Infinity)) watermarks.set(r.containerName, at);
  }

  type Row = { name: string; bucket: Date; health: ContainerHealth; failed: number; lastProbe: Date | null };
  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const c of containers) {
    // Two containers of one name cannot both run; the first reported wins, as a snapshot reads.
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    const watermark = watermarks.get(c.name) ?? -Infinity;
    let newest = watermark;
    let failedNow = 0;
    let failedBefore = 0;
    for (const probe of c.healthLog ?? []) {
      const start = Date.parse(probe.start);
      if (Number.isNaN(start) || start <= watermark || start < previous.getTime()) continue;
      if (start > newest) newest = start;
      if (probe.exitCode === 0) continue;
      if (start < current.getTime()) failedBefore += 1;
      else failedNow += 1;
    }
    const lastProbe = newest === watermark ? null : new Date(newest);
    rows.push({ name: c.name, bucket: current, health: c.health, failed: failedNow, lastProbe });
    // `none` ranks lowest, so a late check never changes the earlier bucket's worst state.
    if (failedBefore > 0) rows.push({ name: c.name, bucket: previous, health: 'none', failed: failedBefore, lastProbe: null });
  }

  // Worst first is highest: a bucket keeps the highest rank it has seen (none < healthy < starting < unhealthy).
  const rank = (column: Prisma.Sql): Prisma.Sql =>
    Prisma.sql`(CASE ${column} WHEN 'unhealthy' THEN 3 WHEN 'starting' THEN 2 WHEN 'healthy' THEN 1 ELSE 0 END)`;
  await tx.$executeRaw`
    INSERT INTO container_health (agent_id, container_name, bucket_start, worst_health, failed_checks, last_probe_start)
    VALUES ${Prisma.join(rows.map((r) => Prisma.sql`(${agentId}::uuid, ${r.name}, ${r.bucket}, ${r.health}, ${r.failed}, ${r.lastProbe})`))}
    ON CONFLICT (agent_id, container_name, bucket_start) DO UPDATE SET
      worst_health = CASE WHEN ${rank(Prisma.sql`EXCLUDED.worst_health`)} > ${rank(Prisma.sql`container_health.worst_health`)}
        THEN EXCLUDED.worst_health ELSE container_health.worst_health END,
      failed_checks = container_health.failed_checks + EXCLUDED.failed_checks,
      last_probe_start = GREATEST(container_health.last_probe_start, EXCLUDED.last_probe_start)`;
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
