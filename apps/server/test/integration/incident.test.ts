import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { IncidentBundle, type HostContainer, type HostInventory, type LogLine, type LogsChunk, type PollResponse, type Refusal } from '@shipyard/schema';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import type { ServiceDeps } from '../../src/deps.js';
import type { DeployCaller } from '../../src/deploys/service.js';
import { Bus } from '../../src/events.js';
import { storeHostInventory } from '../../src/host/index.js';
import { buildIncidentBundle } from '../../src/incident/index.js';
import { logsHubFor } from '../../src/logs/index.js';
import { agentPost, container, enrol, issueToken, makeKey, poll, seedApp, seedStack, signIn, until, type Key } from './agent-work-fixtures.js';

/**
 * SHP-T-19.3: incident bundles (SHP-ADR-013; SHP-REQ-212, SHP-REQ-214, SHP-REQ-215, SHP-REQ-216,
 * SHP-REQ-243). `GET /api/containers/:id/incident` is for whoever may read the container's logs; a
 * token only inside its scope. The bundle carries the condition row, the snapshot's inspect state,
 * the owner's last change and the logs from the first error line, read through the agent's log
 * job; the agent being silent leaves the logs unavailable and the bundle standing. A read leaves
 * one `incident.read` audit row, and no line of the logs in any table or in anything logged.
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

const T0 = new Date('2026-11-02T10:00:00.000Z');
const DEPLOYED_AT = new Date('2026-11-02T09:30:00.000Z');
const SHA = 'abcdef0'.padEnd(40, '1');
const STACK_DIGEST = `sha256:${'b'.repeat(64)}`;

const WEB = container('web-1', {
  tier: 'shipped',
  app: 'web',
  compose: { project: 'web', service: 'web' },
  health: 'unhealthy',
  restartCount: 2,
  stats: { cpuPercent: 12.5, memoryBytes: 800, memoryLimitBytes: 1000 },
});
const WATCHTOWER = container('watchtower');
const PG = container('pg', { tier: 'operated', app: 'pg-stack', compose: { project: 'pg-stack', service: 'pg' } });

let bus: Bus;
let app: Express;
let deps: ServiceDeps;
let key: Key;
let agentId: string;

function err(res: { body: unknown }): Refusal {
  return (res.body as { error: Refusal }).error;
}

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

function logsOf(r: PollResponse) {
  return 'logs' in r ? r.logs : undefined;
}

function at(i: number): string {
  return new Date(T0.getTime() + i * 1000).toISOString();
}

/** Every base table's row count. */
async function rowCounts(): Promise<Map<string, number>> {
  const tables = await db.$queryRawUnsafe<{ name: string }[]>(
    `select table_name as name from information_schema.tables where table_schema = current_schema() and table_type = 'BASE TABLE'`,
  );
  const out = new Map<string, number>();
  for (const { name } of tables) {
    const rows = await db.$queryRawUnsafe<{ n: bigint }[]>(`select count(*) as n from "${name.replace(/"/g, '""')}"`);
    out.set(name, Number(rows[0]?.n ?? 0));
  }
  return out;
}

/** The tables holding `marker` anywhere in a row. */
async function tablesContaining(marker: string): Promise<string[]> {
  const tables = await db.$queryRawUnsafe<{ name: string }[]>(
    `select table_name as name from information_schema.tables where table_schema = current_schema() and table_type = 'BASE TABLE'`,
  );
  expect(tables.length).toBeGreaterThan(10);
  const hits: string[] = [];
  for (const { name } of tables) {
    const rows = await db.$queryRawUnsafe<{ n: bigint }[]>(`select count(*) as n from "${name.replace(/"/g, '""')}" t where t::text like $1`, `%${marker}%`);
    if (Number(rows[0]?.n ?? 0) > 0) hits.push(name);
  }
  return hits;
}

/** Plays the agent: takes the log job the bundle read opened and answers it with `lines`. */
async function answerLogs(lines: LogLine[]): Promise<void> {
  await until(() => logsHubFor(bus).size >= 1);
  const job = logsOf(await poll(app, key, ['logs']));
  expect(job?.tail).toBe(2000);
  const id = job?.logsId ?? '';
  const chunk: LogsChunk = { logsId: id, seq: 0, lines, done: true };
  const res = await agentPost(app, key, `/api/agent/logs/${id}/chunks`, chunk);
  expect(res.status).toBe(200);
}

function bundleOf(res: { body: unknown }): IncidentBundle {
  return IncidentBundle.parse(res.body);
}

async function adminCaller(): Promise<DeployCaller> {
  const { userId, email } = await signIn(db, 'admin');
  return {
    actor: { type: 'user', id: userId, label: email },
    role: 'admin',
    tokenApps: undefined,
    audit: async (event) => {
      await db.auditEvent.create({
        data: { actorType: 'user', actorUserId: userId, actorLabel: email, action: event.action, entityType: event.entityType, entityId: event.entityId ?? null, after: event.after as object },
      });
    },
  };
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "action", "stack_update", "stack", "container_condition", "host_sample", "host_snapshot", "audit_event", "agent_nonce", "api_token_app", "api_token", "deploy_target", "deploy", "app", "agent", "session", "user" cascade',
  );
  logged.length = 0;
  key = makeKey();
  agentId = await enrol(db, key);
  const webId = await seedApp(db, 'web', agentId);
  await seedStack(db, 'pg-stack', agentId);
  await storeHostInventory(db, agentId, inventory([WEB, WATCHTOWER, PG]), T0);
  // The last real deploy, and a later dry run that must not count as the last change.
  await db.deploy.create({
    data: {
      requestedSha: SHA,
      requesterLabel: 'matt (console)',
      targets: { create: { appId: webId, state: 'succeeded', startedAt: DEPLOYED_AT, endedAt: DEPLOYED_AT, createdAt: DEPLOYED_AT } },
    },
  });
  await db.deploy.create({
    data: { requestedSha: 'f'.repeat(40), requesterLabel: 'dry', dryRun: true, targets: { create: { appId: webId, state: 'succeeded', endedAt: T0 } } },
  });
  bus = new Bus();
  deps = { db, logger, config, bus };
  app = createApp(deps);
});

afterAll(async () => {
  await db.$disconnect();
});

const path = (id: string) => `/api/containers/${id}/incident`;

describe('GET /api/containers/:id/incident: who may read', () => {
  it('refuses an unauthenticated request 401, and a deployer and a viewer 403', async () => {
    const anon = await request(app).get(path(WEB.id));
    expect(anon.status).toBe(401);
    expect(err(anon).code).toBe('unauthenticated');
    for (const role of ['deployer', 'viewer'] as const) {
      const { cookie } = await signIn(db, role);
      const res = await request(app).get(path(WEB.id)).set('Cookie', cookie);
      expect(res.status).toBe(403);
      expect(err(res).code).toBe('forbidden');
    }
    expect(await db.auditEvent.count({ where: { action: 'incident.read' } })).toBe(0);
  });

  it('refuses a malformed ID 400 and an unknown one 404', async () => {
    const { cookie } = await signIn(db, 'admin');
    const bad = await request(app).get(path('not-a-container')).set('Cookie', cookie);
    expect(bad.status).toBe(400);
    expect(err(bad).code).toBe('invalid_request');
    const unknown = await request(app).get(path('f'.repeat(64))).set('Cookie', cookie);
    expect(unknown.status).toBe(404);
    expect(err(unknown).code).toBe('unknown_container');
  });

  it('lets a token scoped to the app read it; refuses another app, an Observed container and a token without can_read_logs (SHP-REQ-214)', async () => {
    const admin = await signIn(db, 'admin');
    const webToken = await issueToken(app, admin.cookie, ['web'], true);
    const stackToken = await issueToken(app, admin.cookie, ['pg-stack'], true);
    const plain = await issueToken(app, admin.cookie, ['web']);
    const as = (token: string, id: string) => request(app).get(path(id)).set('Authorization', `Bearer ${token}`);

    // The agent never polled: the logs are unavailable and the bundle still stands.
    const ok = await as(webToken.token, WEB.id);
    expect(ok.status).toBe(200);
    expect(bundleOf(ok).logs.unavailable?.code).toBe('agent_offline');

    const other = await as(stackToken.token, WEB.id);
    expect(other.status).toBe(403);
    expect(err(other)).toMatchObject({ code: 'forbidden', fix: 'Use the console, or a token scoped to web.' });
    for (const token of [webToken.token, stackToken.token]) {
      const observed = await as(token, WATCHTOWER.id);
      expect(observed.status).toBe(403);
      expect(err(observed).code).toBe('forbidden');
    }
    const noLogs = await as(plain.token, WEB.id);
    expect(noLogs.status).toBe(403);
    expect(err(noLogs).message).toBe('This token may not read container logs.');
    expect(await db.auditEvent.count({ where: { action: 'incident.read' } })).toBe(1);
  });
});

describe('the bundle', () => {
  it("gives an operator the logs from the first error, the condition row, the snapshot's inspect state and the last deploy", async () => {
    await poll(app, key, ['logs']);
    const { cookie } = await signIn(db, 'operator');
    const pending = request(app).get(path(WEB.id)).set('Cookie', cookie).then((r) => r);
    const lines: LogLine[] = [
      { at: at(1), stream: 'stdout', text: 'listening on :3000' },
      { at: at(2), stream: 'stdout', text: 'GET /health 200' },
      { at: at(3), stream: 'stderr', text: 'Error: connect ECONNREFUSED 10.0.0.5:5432' },
      { at: at(4), stream: 'stderr', text: 'still trying' },
      { at: at(5), stream: 'stderr', text: 'fatal: giving up' },
    ];
    await answerLogs(lines);
    const res = await pending;
    expect(res.status).toBe(200);
    const bundle = bundleOf(res);

    expect(bundle.container).toEqual({ id: WEB.id, name: 'web-1', tier: 'shipped', owner: 'web', compose: { project: 'web', service: 'web' } });
    expect(bundle.condition).toBe('unhealthy');
    expect(bundle.failingSince).toBe(T0.toISOString());
    expect(bundle.logs).toEqual({ from: 'first-error', lines: lines.slice(2), unavailable: null });
    expect(bundle.inspect).toEqual({
      image: WEB.image,
      digest: null,
      state: 'running',
      health: 'unhealthy',
      restartCount: 2,
      createdAt: WEB.createdAt,
      startedAt: WEB.startedAt,
      memoryBytes: 800,
      memoryLimitBytes: 1000,
      cpuPercent: 12.5,
    });
    expect(JSON.stringify(bundle.inspect)).not.toMatch(/env/i);
    expect(bundle.lastChange).toMatchObject({ kind: 'deploy', at: DEPLOYED_AT.toISOString(), state: 'succeeded', sha: SHA, digest: null });

    // Docker last started it on Oct 1, so the restarts fact comes first.
    expect(bundle.facts.map((f) => f.kind)).toEqual(['restarts', 'last-change', 'failing', 'log-error', 'log-error', 'memory']);
    expect(bundle.facts[1]?.text).toBe('Last deploy abcdef0 succeeded at 2026-11-02T09:30:00.000Z, 30m before it began failing');
    expect(bundle.facts[4]?.text).toBe('2 lines look like errors');
    expect(bundle.facts[3]?.text).toBe('First error: Error: connect ECONNREFUSED 10.0.0.5:5432');
    expect(bundle.facts.at(-1)?.text).toBe('Memory at 80% of its limit');
  });

  it('keeps the last 200 lines when none looks like an error', async () => {
    await poll(app, key, ['logs']);
    const { cookie } = await signIn(db, 'admin');
    const pending = request(app).get(path(WEB.id)).set('Cookie', cookie).then((r) => r);
    await answerLogs(Array.from({ length: 300 }, (_, i) => ({ at: null, stream: 'stdout' as const, text: `ok ${String(i)}` })));
    const bundle = bundleOf(await pending);
    expect(bundle.logs.from).toBe('tail');
    expect(bundle.logs.lines).toHaveLength(200);
    expect(bundle.logs.lines[0]?.text).toBe('ok 100');
  });

  it('stands when a connected agent stays silent: logs unavailable (agent_offline), everything else present', async () => {
    await poll(app, key, ['logs']);
    const bundle = await buildIncidentBundle(deps, await adminCaller(), { containerName: 'web-1' }, { logsTimeoutMs: 50 });
    expect('code' in bundle).toBe(false);
    const b = bundle as IncidentBundle;
    expect(b.logs).toMatchObject({ from: 'tail', lines: [], unavailable: { code: 'agent_offline' } });
    expect(b.condition).toBe('unhealthy');
    expect(b.lastChange?.sha).toBe(SHA);
  });

  it("names an Operated container's stack update as its last change, and an Observed one has none", async () => {
    const stack = await db.stack.findUniqueOrThrow({ where: { name: 'pg-stack' } });
    const update = await db.stackUpdate.create({
      data: { stackId: stack.id, stackName: 'pg-stack', agentId, state: 'succeeded', digests: { pg: STACK_DIGEST }, requesterLabel: 'matt', endedAt: T0 },
    });
    const caller = await adminCaller();
    const pg = (await buildIncidentBundle(deps, caller, { containerId: PG.id }, { logsTimeoutMs: 50 })) as IncidentBundle;
    expect(pg.lastChange).toEqual({ kind: 'stack-update', id: update.id, at: T0.toISOString(), state: 'succeeded', sha: null, digest: STACK_DIGEST });
    expect(pg.condition).toBeNull();
    const observed = (await buildIncidentBundle(deps, caller, { containerId: WATCHTOWER.id }, { logsTimeoutMs: 50 })) as IncidentBundle;
    expect(observed.lastChange).toBeNull();
    expect(observed.container.owner).toBeNull();
    const unknown = await buildIncidentBundle(deps, caller, { containerName: 'nope' });
    expect(unknown).toMatchObject({ code: 'unknown_container', message: 'The agent does not report a container named nope.' });
  });
});

describe('the no-store rule (SHP-REQ-215, SHP-REQ-243)', () => {
  it('adds one incident.read audit row and no other row but audit events; no log line reaches a table or the logger', async () => {
    const marker = `SHIPYARD-INCIDENT-MARKER-${randomUUID()}`;
    await poll(app, key, ['logs']);
    const { cookie, email } = await signIn(db, 'operator');
    const before = await rowCounts();

    const pending = request(app).get(path(WEB.id)).set('Cookie', cookie).then((r) => r);
    await answerLogs([
      { at: at(1), stream: 'stderr', text: `error: password=${marker}` },
      { at: at(2), stream: 'stderr', text: `${marker} again` },
    ]);
    const res = await pending;
    expect(res.status).toBe(200);
    // The marker did reach the reader, so the checks below are not vacuous.
    expect(JSON.stringify(res.body)).toContain(marker);

    const after = await rowCounts();
    const grew = [...after].filter(([name, n]) => n !== (before.get(name) ?? 0)).map(([name]) => name);
    // agent_nonce is the replay guard of the agent's own signed poll and chunk, not the read's.
    expect(grew.filter((name) => name !== 'agent_nonce')).toEqual(['audit_event']);

    const reads = await db.auditEvent.findMany({ where: { action: 'incident.read' } });
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ actorLabel: email, entityType: 'container', entityId: WEB.id });
    expect(reads[0]?.after).toEqual({
      viewer: email,
      containerName: 'web-1',
      app: 'web',
      tier: 'shipped',
      condition: 'unhealthy',
      logLines: 2,
      logsUnavailable: null,
    });
    expect(await db.auditEvent.count({ where: { action: 'logs.view', entityId: WEB.id } })).toBe(1);

    expect(await tablesContaining(marker)).toEqual([]);
    expect(logged.join('')).toContain('incident bundle built');
    expect(logged.join('')).not.toContain(marker);
  });
});
