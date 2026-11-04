import { Writable } from 'node:stream';
import type { Express } from 'express';
import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { IncidentBundle, type AgentReport, type ContainerEvent, type HealthCheckResult, type HostContainer, type HostInventory } from '@shipyard/schema';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import type { ServiceDeps } from '../../src/deps.js';
import type { DeployCaller } from '../../src/deploys/service.js';
import { Bus } from '../../src/events.js';
import {
  readHealthBuckets,
  readRestartLoops,
  restartLoopKey,
  restartLoopOf,
  storeContainerEvents,
  storeHostInventory,
  type StartOrDie,
} from '../../src/host/index.js';
import { buildIncidentBundle } from '../../src/incident/index.js';
import { pruneContainerHistory } from '../../src/jobs/container-history-prune.js';
import { buildOverview } from '../../src/overview/index.js';
import { agentPost, container, enrol, makeKey, seedApp, seedStack, signIn, type Key } from './agent-work-fixtures.js';

/**
 * SHP-T-20.3: container history (SHP-ADR-013). Events are stored once however often a report is
 * re-sent and kept 30 days (SHP-REQ-222); each container's health is folded into 30-minute buckets
 * of worst health and failed checks, kept 7 days (SHP-REQ-223); probe output lives only in the
 * latest snapshot, never in history (SHP-REQ-224); three restarts in 15 minutes is a restart loop on
 * the app's banner (SHP-REQ-227); and the bundle carries the last 24 hours of events, the latest
 * probes and the exit state (SHP-REQ-228).
 */

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const config = loadConfig({ DATABASE_URL: databaseUrl, SESSION_SECRET: 'test-session-secret' });

const logged: string[] = [];
const sink = new Writable({
  write(chunk: Buffer | string, _encoding, callback) {
    logged.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    callback();
  },
});
const logger = pino({ level: 'trace' }, sink);

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
/** Five minutes into the 10:00 bucket. */
const T0 = new Date('2026-11-04T10:05:00.000Z');
const PROBE_OUTPUT = 'probe-output-marker-7f3a: connection refused to 10.0.0.5:5432';

const WEB = container('web-1', { tier: 'shipped', app: 'web', compose: { project: 'web', service: 'web' } });
const PG = container('pg', { tier: 'operated', app: 'pg-stack', compose: { project: 'pg-stack', service: 'pg' } });
const WATCHTOWER = container('watchtower');

let key: Key;
let agentId: string;
let deps: ServiceDeps;
let app: Express;

function inventory(containers: HostContainer[]): HostInventory {
  return {
    sampledAt: T0.toISOString(),
    containers,
    volumes: [],
    images: [],
    networks: [],
    builderCache: { bytes: 0, reclaimableBytes: 0 },
    disk: { dataRoot: { path: '/DATA', freeBytes: 10, totalBytes: 100 }, dockerRoot: null },
  };
}

function probe(start: string, exitCode: number, output = PROBE_OUTPUT): HealthCheckResult {
  return { start, end: start, exitCode, output };
}

function event(c: HostContainer, kind: ContainerEvent['kind'], at: Date, extra: Partial<ContainerEvent> = {}): ContainerEvent {
  return {
    kind,
    at: at.toISOString(),
    containerId: c.id,
    containerName: c.name,
    exitCode: kind === 'die' ? 1 : null,
    health: null,
    ...extra,
  };
}

/** `n` die-then-start pairs, the starts at the given minutes before `now`. */
function restarts(c: HostContainer, now: Date, minutesAgo: number[]): ContainerEvent[] {
  return minutesAgo.flatMap((m) => [
    event(c, 'die', new Date(now.getTime() - m * MIN - 1000), { exitCode: 137 }),
    event(c, 'start', new Date(now.getTime() - m * MIN)),
  ]);
}

function caller(userId: string): DeployCaller {
  return { actor: { type: 'user', id: userId, label: 'admin' }, role: 'admin', tokenApps: undefined, audit: () => Promise.resolve() };
}

/** Every row of both history tables, as text. */
async function historyText(): Promise<string> {
  return JSON.stringify([await db.containerEvent.findMany(), await db.containerHealth.findMany()]);
}

/** The base tables holding `marker` anywhere in a row. */
async function tablesContaining(marker: string): Promise<string[]> {
  const tables = await db.$queryRawUnsafe<{ name: string }[]>(
    `select table_name as name from information_schema.tables where table_schema = current_schema() and table_type = 'BASE TABLE'`,
  );
  const hits: string[] = [];
  for (const { name } of tables) {
    const rows = await db.$queryRawUnsafe<{ n: bigint }[]>(`select count(*) as n from "${name.replace(/"/g, '""')}" t where t::text like $1`, `%${marker}%`);
    if (Number(rows[0]?.n ?? 0) > 0) hits.push(name);
  }
  return hits.sort();
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "container_event", "container_health", "container_condition", "host_sample", "host_snapshot", "audit_event", "agent_nonce", "deploy_target", "deploy", "stack", "app", "agent", "session", "user" cascade',
  );
  logged.length = 0;
  key = makeKey();
  agentId = await enrol(db, key);
  await seedApp(db, 'web', agentId);
  await seedStack(db, 'pg-stack', agentId);
  deps = { db, logger, config, bus: new Bus() };
  app = createApp(deps);
});

afterAll(async () => {
  await db.$disconnect();
});

describe('container events (SHP-REQ-222)', () => {
  it('stores each event once however often the report is re-sent', async () => {
    const events = [event(WEB, 'die', T0, { exitCode: 2 }), event(WEB, 'start', new Date(T0.getTime() + 1000)), event(WEB, 'health_status', new Date(T0.getTime() + 2000), { health: 'unhealthy' })];
    await storeContainerEvents(db, agentId, events, 0, T0, logger);
    await storeContainerEvents(db, agentId, events, 0, new Date(T0.getTime() + MIN), logger);
    const rows = await db.containerEvent.findMany({ orderBy: { at: 'asc' } });
    expect(rows.map((r) => [r.kind, r.exitCode, r.health, r.containerId, r.containerName, r.receivedAt.toISOString()])).toEqual([
      ['die', 2, null, WEB.id, 'web-1', T0.toISOString()],
      ['start', null, null, WEB.id, 'web-1', T0.toISOString()],
      ['health_status', null, 'unhealthy', WEB.id, 'web-1', T0.toISOString()],
    ]);
  });

  it('logs dropped events as a warning and stores nothing for them', async () => {
    await storeContainerEvents(db, agentId, [], 4, T0, logger);
    expect(await db.containerEvent.count()).toBe(0);
    const warning = logged.map((l) => JSON.parse(l) as { level: number; droppedEvents?: number }).find((l) => l.droppedEvents === 4);
    expect(warning?.level).toBe(40);
  });

  it("are stored from the agent's report alongside its host inventory", async () => {
    const report: AgentReport = {
      agentVersion: '0.1.0',
      composeVersion: '5.0.1',
      engineApiVersion: '1.51',
      patExpiresAt: null,
      apps: [],
      host: inventory([{ ...WEB, health: 'unhealthy', healthLog: [probe(new Date().toISOString(), 1)] }]),
      events: [event(WEB, 'oom', new Date()), event(WEB, 'die', new Date(), { exitCode: 137 })],
      droppedEvents: 0,
    };
    const res = await agentPost(app, key, '/api/agent/report', report);
    expect(res.status).toBe(200);
    expect((await db.containerEvent.findMany()).map((r) => r.kind).sort()).toEqual(['die', 'oom']);
    expect(await db.containerHealth.count()).toBe(1);
    expect(await historyText()).not.toContain('probe-output-marker');
  });

  it('are deleted after 30 days, and health buckets after 7, by the prune', async () => {
    await storeContainerEvents(
      db,
      agentId,
      [event(WEB, 'start', new Date(T0.getTime() - 31 * DAY)), event(WEB, 'start', new Date(T0.getTime() - 29 * DAY))],
      0,
      T0,
    );
    await db.containerHealth.createMany({
      data: [
        { agentId, containerName: 'web-1', bucketStart: new Date(T0.getTime() - 8 * DAY), worstHealth: 'unhealthy', failedChecks: 3 },
        { agentId, containerName: 'web-1', bucketStart: new Date(T0.getTime() - 6 * DAY), worstHealth: 'healthy', failedChecks: 0 },
      ],
    });
    expect(await pruneContainerHistory(deps, T0)).toEqual({ events: 1, buckets: 1 });
    expect((await db.containerEvent.findMany()).map((r) => r.at.toISOString())).toEqual([new Date(T0.getTime() - 29 * DAY).toISOString()]);
    expect((await readHealthBuckets(db, agentId)).map((r) => r.bucketStart.toISOString())).toEqual([new Date(T0.getTime() - 6 * DAY).toISOString()]);
    expect(await pruneContainerHistory(deps, T0)).toEqual({ events: 0, buckets: 0 });
  });
});

describe('health buckets (SHP-REQ-223)', () => {
  it('keeps the worst health and counts each failed check once, per container and 30-minute bucket', async () => {
    const quiet = container('quiet');
    const early = [probe('2026-11-04T09:59:00.000Z', 1), probe('2026-11-04T10:04:00.000Z', 1), probe('2026-11-04T10:04:30.000Z', 0)];
    await storeHostInventory(db, agentId, inventory([{ ...WEB, health: 'starting', healthLog: early }, quiet]), T0);
    let buckets = await readHealthBuckets(db, agentId);
    // The 09:59 check belongs to the previous bucket, so it is counted there and only the 10:04 failure here.
    expect(buckets).toEqual([
      { containerName: 'web-1', bucketStart: new Date('2026-11-04T09:30:00.000Z'), worstHealth: 'none', failedChecks: 1 },
      { containerName: 'quiet', bucketStart: new Date('2026-11-04T10:00:00.000Z'), worstHealth: 'none', failedChecks: 0 },
      { containerName: 'web-1', bucketStart: new Date('2026-11-04T10:00:00.000Z'), worstHealth: 'starting', failedChecks: 1 },
    ]);

    const later = [...early.slice(1), probe('2026-11-04T10:05:30.000Z', 1)];
    await storeHostInventory(db, agentId, inventory([{ ...WEB, health: 'unhealthy', healthLog: later }, quiet]), new Date(T0.getTime() + MIN));
    // The same checks again, and the container healthy: nothing counted twice, the worst kept.
    await storeHostInventory(db, agentId, inventory([{ ...WEB, health: 'healthy', healthLog: later }, quiet]), new Date(T0.getTime() + 2 * MIN));
    buckets = await readHealthBuckets(db, agentId);
    expect(buckets.find((b) => b.containerName === 'web-1' && b.bucketStart.toISOString() === '2026-11-04T10:00:00.000Z')).toMatchObject({ worstHealth: 'unhealthy', failedChecks: 2 });

    await storeHostInventory(db, agentId, inventory([{ ...WEB, health: 'healthy', healthLog: [] }, quiet]), new Date('2026-11-04T10:31:00.000Z'));
    buckets = await readHealthBuckets(db, agentId);
    expect(buckets.filter((b) => b.containerName === 'web-1')).toEqual([
      { containerName: 'web-1', bucketStart: new Date('2026-11-04T09:30:00.000Z'), worstHealth: 'none', failedChecks: 1 },
      { containerName: 'web-1', bucketStart: new Date('2026-11-04T10:00:00.000Z'), worstHealth: 'unhealthy', failedChecks: 2 },
      { containerName: 'web-1', bucketStart: new Date('2026-11-04T10:30:00.000Z'), worstHealth: 'healthy', failedChecks: 0 },
    ]);
  });

  it('counts a check that started before a boundary but first appears in the next report, in its own bucket', async () => {
    // Probes every 30 s, reports every 60 s, all failing: four checks start in the 10:00 bucket's last two minutes.
    const at = (t: string): string => `2026-11-04T${t}.000Z`;
    const first = [probe(at('10:28:05'), 1), probe(at('10:28:35'), 1), probe(at('10:29:05'), 1)];
    await storeHostInventory(db, agentId, inventory([{ ...WEB, health: 'unhealthy', healthLog: first }]), new Date(at('10:29:10')));
    const second = [...first, probe(at('10:29:35'), 1), probe(at('10:30:05'), 1)].slice(-5);
    await storeHostInventory(db, agentId, inventory([{ ...WEB, health: 'unhealthy', healthLog: second }]), new Date(at('10:30:10')));
    // Re-sent: nothing changes.
    await storeHostInventory(db, agentId, inventory([{ ...WEB, health: 'unhealthy', healthLog: second }]), new Date(at('10:30:40')));
    const buckets = (await readHealthBuckets(db, agentId)).filter((b) => b.containerName === 'web-1');
    expect(buckets).toEqual([
      { containerName: 'web-1', bucketStart: new Date(at('10:00:00')), worstHealth: 'unhealthy', failedChecks: 4 },
      { containerName: 'web-1', bucketStart: new Date(at('10:30:00')), worstHealth: 'unhealthy', failedChecks: 1 },
    ]);
  });
});

describe('probe output (SHP-REQ-224)', () => {
  it('is kept only on the latest snapshot: no history row holds it, and the next report without it leaves it nowhere', async () => {
    const log = [probe('2026-11-04T10:04:00.000Z', 1), probe('2026-11-04T10:04:30.000Z', 1)];
    await storeHostInventory(db, agentId, inventory([{ ...WEB, health: 'unhealthy', healthLog: log }]), T0);
    await storeContainerEvents(db, agentId, [event(WEB, 'health_status', T0, { health: 'unhealthy' }), ...restarts(WEB, T0, [3, 2, 1])], 0, T0);
    await storeHostInventory(db, agentId, inventory([{ ...WEB, health: 'unhealthy', healthLog: log }]), new Date(T0.getTime() + MIN));

    expect(await db.containerEvent.count()).toBeGreaterThan(0);
    expect(await db.containerHealth.count()).toBe(1);
    const history = await historyText();
    expect(history).not.toContain('probe-output-marker');
    expect(history).not.toContain(PROBE_OUTPUT);
    expect(await tablesContaining('probe-output-marker')).toEqual(['host_snapshot']);

    await storeHostInventory(db, agentId, inventory([{ ...WEB, health: 'healthy', healthLog: [] }]), new Date(T0.getTime() + 2 * MIN));
    expect(await tablesContaining('probe-output-marker')).toEqual([]);
  });
});

describe('restart loops (SHP-REQ-227)', () => {
  const now = T0;
  const seq = (pairs: [string, number][]): StartOrDie[] => pairs.map(([kind, m]) => ({ kind, at: new Date(now.getTime() - m * MIN) }));

  it('counts a start that follows a die, three within 15 minutes ending in the last 15', () => {
    expect(restartLoopOf(seq([['die', 12.1], ['start', 12], ['die', 8.1], ['start', 8], ['die', 2.1], ['start', 2]]), now)).toEqual({
      restarts: 3,
      since: new Date(now.getTime() - 12 * MIN),
    });
    expect(restartLoopOf(seq([['die', 9], ['start', 8], ['die', 6], ['start', 5], ['die', 4], ['start', 3], ['die', 2], ['start', 1]]), now)?.restarts).toBe(4);
  });

  it('is not a loop with two restarts, restarts spread over more than 15 minutes, or a run that ended over 15 minutes ago', () => {
    expect(restartLoopOf(seq([['die', 5], ['start', 4], ['die', 2], ['start', 1]]), now)).toBeNull();
    expect(restartLoopOf(seq([['die', 21], ['start', 20], ['die', 11], ['start', 10], ['die', 1], ['start', 0.5]]), now)).toBeNull();
    expect(restartLoopOf(seq([['die', 29], ['start', 28], ['die', 23], ['start', 22], ['die', 17], ['start', 16]]), now)).toBeNull();
  });

  it("does not count a start that follows no die, nor Docker's own restart event", () => {
    expect(restartLoopOf(seq([['start', 10], ['start', 8], ['start', 6], ['start', 4]]), now)).toBeNull();
    expect(
      restartLoopOf(seq([['die', 9], ['start', 8], ['restart', 8], ['die', 6], ['start', 5], ['restart', 5], ['die', 3], ['start', 2], ['restart', 2]]), now),
    ).toEqual({ restarts: 3, since: new Date(now.getTime() - 8 * MIN) });
  });

  it('reads the die before its window when the first start there follows one', async () => {
    await storeContainerEvents(
      db,
      agentId,
      [
        event(WEB, 'die', new Date(now.getTime() - 50 * MIN)),
        event(WEB, 'start', new Date(now.getTime() - 20 * MIN)),
        ...restarts(WEB, now, [11, 7]),
        // Three starts of the Operated stack, but none after a die.
        event(PG, 'start', new Date(now.getTime() - 9 * MIN)),
        event(PG, 'start', new Date(now.getTime() - 6 * MIN)),
        event(PG, 'start', new Date(now.getTime() - 3 * MIN)),
      ],
      0,
      now,
    );
    const loops = await readRestartLoops(db, [{ agentId, containerName: 'web-1' }, { agentId, containerName: 'pg' }], now);
    expect([...loops.keys()]).toEqual([restartLoopKey(agentId, 'web-1')]);
    expect(loops.get(restartLoopKey(agentId, 'web-1'))).toEqual({ restarts: 3, since: new Date(now.getTime() - 20 * MIN) });
  });

  it("shows a restart loop on its app's banner, outranking unhealthy; never for an Observed container", async () => {
    await storeHostInventory(db, agentId, inventory([{ ...WEB, health: 'unhealthy' }, PG, WATCHTOWER]), new Date(now.getTime() - 30 * MIN));
    await storeContainerEvents(db, agentId, [...restarts(WEB, now, [10, 6, 2]), ...restarts(PG, now, [9, 5]), ...restarts(WATCHTOWER, now, [8, 4, 1])], 0, now);

    const overview = await buildOverview(db, now);
    expect(overview.incidents).toHaveLength(1);
    expect(overview.incidents[0]).toMatchObject({
      owner: { kind: 'app', name: 'web' },
      since: new Date(now.getTime() - 10 * MIN).toISOString(),
      containers: [{ name: 'web-1', condition: 'restart-loop', failingSince: new Date(now.getTime() - 10 * MIN).toISOString() }],
    });
    expect(overview.runs.failing).toBe(1);

    // A third restart of the stack: its own banner, a Deployed app's first, oldest first.
    await storeContainerEvents(db, agentId, restarts(PG, now, [1]), 0, now);
    const again = await buildOverview(db, now);
    expect(again.incidents.map((b) => [b.owner.name, b.containers[0]?.condition])).toEqual([
      ['web', 'restart-loop'],
      ['pg-stack', 'restart-loop'],
    ]);

    // Fifteen minutes on with no more restarts, web is back to its stored condition.
    const later = await buildOverview(db, new Date(now.getTime() + 15 * MIN));
    expect(later.incidents.map((b) => [b.owner.name, b.containers[0]?.condition])).toEqual([['web', 'unhealthy']]);
  });
});

describe('the incident bundle (SHP-REQ-228)', () => {
  it('carries the last 24 hours of events oldest first, the latest probes, the exit state and the restart-loop facts', async () => {
    const failing: HostContainer = {
      ...WEB,
      health: 'unhealthy',
      restartCount: 3,
      healthLog: [probe('2026-11-04T10:04:00.000Z', 1)],
      exitCode: 137,
      oomKilled: true,
      restartPolicy: 'unless-stopped',
    };
    await storeHostInventory(db, agentId, inventory([failing]), T0);
    await storeContainerEvents(
      db,
      agentId,
      [event(WEB, 'start', new Date(T0.getTime() - 25 * 60 * MIN)), event(WEB, 'oom', new Date(T0.getTime() - 10.5 * MIN)), ...restarts(WEB, T0, [10, 6, 2])],
      0,
      T0,
    );
    const { userId } = await signIn(db, 'admin');
    const bundle = await buildIncidentBundle(deps, caller(userId), { containerId: WEB.id }, { now: T0, logsTimeoutMs: 100 });
    if ('code' in bundle) throw new Error(bundle.message);
    IncidentBundle.parse(bundle);

    expect(bundle.condition).toBe('restart-loop');
    expect(bundle.failingSince).toBe(new Date(T0.getTime() - 10 * MIN).toISOString());
    expect(bundle.events.map((e) => e.kind)).toEqual(['oom', 'die', 'start', 'die', 'start', 'die', 'start']);
    expect(bundle.events[0]).toEqual({ kind: 'oom', at: new Date(T0.getTime() - 10.5 * MIN).toISOString(), containerId: WEB.id, containerName: 'web-1', exitCode: null, health: null });
    expect(bundle.probes).toEqual([probe('2026-11-04T10:04:00.000Z', 1)]);
    expect(bundle.inspect).toMatchObject({ exitCode: 137, oomKilled: true, restartPolicy: 'unless-stopped' });

    const byKind = new Map(bundle.facts.map((f) => [f.kind, f]));
    expect(byKind.get('restart-loop')).toEqual({ kind: 'restart-loop', at: bundle.failingSince, text: 'Restarted 3 times in 15 minutes.' });
    expect(byKind.get('failing')?.text).toBe(`In a restart loop since ${bundle.failingSince ?? ''}`);
    expect(byKind.get('exit')).toEqual({ kind: 'exit', at: new Date(T0.getTime() - 2 * MIN - 1000).toISOString(), text: 'Exited with code 137' });
    expect(byKind.get('oom')).toEqual({ kind: 'oom', at: new Date(T0.getTime() - 10.5 * MIN).toISOString(), text: 'Killed for running out of memory' });
  });

  it('keeps the newest 500 events, oldest first, and none of another container', async () => {
    await storeHostInventory(db, agentId, inventory([WEB, PG]), T0);
    const many = Array.from({ length: 600 }, (_, i) => event(WEB, 'health_status', new Date(T0.getTime() - (600 - i) * MIN), { health: 'unhealthy' }));
    await storeContainerEvents(db, agentId, [...many, event(PG, 'die', T0)], 0, T0);
    const { userId } = await signIn(db, 'admin');
    const bundle = await buildIncidentBundle(deps, caller(userId), { containerId: WEB.id }, { now: T0, logsTimeoutMs: 100 });
    if ('code' in bundle) throw new Error(bundle.message);
    expect(bundle.events).toHaveLength(500);
    expect(bundle.events[0]?.at).toBe(new Date(T0.getTime() - 500 * MIN).toISOString());
    expect(bundle.events.at(-1)?.at).toBe(new Date(T0.getTime() - MIN).toISOString());
    expect(bundle.events.every((e) => e.containerName === 'web-1')).toBe(true);
    expect(bundle.condition).toBeNull();
  });
});
