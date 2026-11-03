import { createHash, randomUUID } from 'node:crypto';
import type { Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Overview, type HostContainer, type HostInventory } from '@shipyard/schema';
import { createApp } from '../../src/app.js';
import { SESSION_COOKIE, createSession } from '../../src/auth/index.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import { Bus } from '../../src/events.js';
import { storeHostInventory } from '../../src/host/index.js';
import { buildOverview } from '../../src/overview/index.js';
import { generateToken } from '../../src/tokens/tokens.js';

/**
 * GET /api/overview (SHP-T-19.2, SHP-REQ-207, SHP-REQ-209): assembled from the latest host
 * snapshot, the container conditions and the ledger; one incident banner per Deployed or Operated
 * app with a failing container and none for Observed; every signed-in role and any token may read
 * it, and it writes nothing.
 */

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const config = loadConfig({ DATABASE_URL: databaseUrl, SESSION_SECRET: 'test-session-secret' });

const SHA = 'abcdef0123456789abcdef0123456789abcdef01';
const SHA2 = '1234567890abcdef1234567890abcdef12345678';
const DIGEST = `sha256:${'d'.repeat(64)}`;
const HOUR = 60 * 60 * 1000;

function hex(seed: string, length: number): string {
  return createHash('sha256').update(seed).digest('hex').repeat(2).slice(0, length);
}

function container(name: string, extra: Partial<HostContainer> = {}): HostContainer {
  return {
    id: hex(name, 64),
    name,
    image: `${name}:latest`,
    imageId: `sha256:${hex(`${name}-image`, 64)}`,
    digest: null,
    state: 'running',
    health: 'none',
    restartCount: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    startedAt: '2026-10-01T00:00:01.000Z',
    compose: null,
    tier: 'observed',
    app: null,
    ports: [],
    mounts: [],
    stats: null,
    ...extra,
  };
}

function shipped(name: string, appName: string, extra: Partial<HostContainer> = {}): HostContainer {
  return container(name, { tier: 'shipped', app: appName, compose: { project: appName, service: name }, ...extra });
}

function inventory(containers: HostContainer[]): HostInventory {
  return {
    sampledAt: new Date().toISOString(),
    containers,
    volumes: [],
    images: [],
    networks: [],
    builderCache: { bytes: 0, reclaimableBytes: 0 },
    disk: { dataRoot: { path: '/DATA', freeBytes: 10, totalBytes: 100 }, dockerRoot: null },
  };
}

let agentId: string;
let app: Express;

async function signIn(role: 'admin' | 'operator' | 'deployer' | 'viewer'): Promise<string> {
  const user = await db.user.create({ data: { email: `${role}-${randomUUID()}@example.com`, displayName: role, role } });
  const session = await createSession(db, { userId: user.id, method: 'password' });
  return `${SESSION_COOKIE}=${session.token}`;
}

async function apiToken(): Promise<string> {
  const user = await db.user.create({ data: { email: `token-${randomUUID()}@example.com`, displayName: 'token', role: 'deployer' } });
  const { token, hash, prefix } = generateToken();
  await db.apiToken.create({ data: { userId: user.id, label: 'overview token', tokenHash: hash, prefix } });
  return token;
}

async function seedApp(name: string, extra: { retiredAt?: Date } = {}): Promise<string> {
  const row = await db.app.create({
    data: { name, agentId, manifestYaml: '{}', manifestSha256: '0'.repeat(64), reportedAt: new Date(), ...extra },
  });
  return row.id;
}

async function seedStack(name: string): Promise<string> {
  const row = await db.stack.create({
    data: { name, agentId, manifestJson: '{}', manifestSha256: '0'.repeat(64), composeProject: name, reportedAt: new Date() },
  });
  return row.id;
}

async function seedDeploy(
  appId: string,
  state: 'queued' | 'succeeded' | 'failed' | 'rolled_back' | 'pulling',
  opts: { sha?: string; dryRun?: boolean; endedAt?: Date | null; createdAt?: Date } = {},
): Promise<string> {
  const deploy = await db.deploy.create({
    data: { requestedSha: opts.sha ?? SHA, dryRun: opts.dryRun ?? false, requesterLabel: 'user matthew', ...(opts.createdAt ? { createdAt: opts.createdAt } : {}) },
  });
  await db.deployTarget.create({
    data: {
      deployId: deploy.id,
      appId,
      state,
      endedAt: opts.endedAt === undefined ? (state === 'queued' || state === 'pulling' ? null : new Date()) : opts.endedAt,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    },
  });
  return deploy.id;
}

async function get(headers: Record<string, string>) {
  return request(app).get('/api/overview').set(headers);
}

async function overviewFor(cookie: string): Promise<Overview> {
  const res = await get({ Cookie: cookie });
  expect(res.status).toBe(200);
  return Overview.parse(res.body);
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "container_condition", "host_sample", "host_snapshot", "build", "maintenance_job", "action", "stack_update", "stack", "target_image", "step", "outbox", "deploy_target", "deploy", "audit_event", "agent_nonce", "api_token_app", "api_token_stack", "api_token", "app", "agent", "session", "user" cascade',
  );
  agentId = (await db.agent.create({ data: { publicKey: hex('k', 43), fingerprint: hex('f', 16), confirmedAt: new Date() } })).id;
  app = createApp({ db, logger: pino({ enabled: false }), config, bus: new Bus() });
});

afterAll(async () => {
  await db.$disconnect();
});

describe('access (SHP-T-19.2)', () => {
  it('refuses a request with no session or token', async () => {
    const res = await get({});
    expect(res.status).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe('unauthenticated');
  });

  it('is empty but valid before anything has reported', async () => {
    const overview = await overviewFor(await signIn('viewer'));
    expect(overview.hostReportedAt).toBeNull();
    expect(overview.runs).toMatchObject({ deployedApps: 0, operatedStacks: 0, observedProjects: 0, containers: 0, running: 0, failing: 0, cpuPercent: null, memoryBytes: null, disk: null });
    expect(overview.apps).toEqual([]);
    expect(overview.projects).toEqual([]);
    expect(overview.incidents).toEqual([]);
  });

  it('answers a viewer, every other role and an API token with a body that parses as Overview', async () => {
    await storeHostInventory(db, agentId, inventory([container('pg')]));
    for (const role of ['admin', 'operator', 'deployer', 'viewer'] as const) {
      const res = await get({ Cookie: await signIn(role) });
      expect(res.status).toBe(200);
      expect(Overview.parse(res.body).runs.containers).toBe(1);
    }
    const res = await get({ Authorization: `Bearer ${await apiToken()}` });
    expect(res.status).toBe(200);
    expect(Overview.parse(res.body).runs.containers).toBe(1);
  });

  it('writes nothing: no audit event, no row changes', async () => {
    const web = await seedApp('web');
    await seedDeploy(web, 'succeeded');
    await storeHostInventory(db, agentId, inventory([shipped('web-1', 'web', { health: 'unhealthy' })]));
    const cookie = await signIn('viewer');
    const counts = async () => [
      await db.auditEvent.count(),
      await db.containerCondition.count(),
      await db.hostSample.count(),
      await db.deployTarget.count(),
      await db.session.count(),
    ];
    const before = await counts();
    await get({ Cookie: cookie });
    await get({ Cookie: cookie });
    expect(await counts()).toEqual(before);
  });
});

describe('incident banners (SHP-REQ-209)', () => {
  it('gives one banner for two failing containers of one app, oldest first, with the last deploy', async () => {
    const web = await seedApp('web');
    const deployId = await seedDeploy(web, 'succeeded', { sha: SHA2 });
    const t0 = new Date(Date.now() - 10 * 60_000);
    const t1 = new Date(Date.now() - 5 * 60_000);
    await storeHostInventory(db, agentId, inventory([shipped('web-worker', 'web', { state: 'running', health: 'healthy' }), shipped('web-api', 'web', { health: 'healthy' })]), new Date(t0.getTime() - 60_000));
    await storeHostInventory(db, agentId, inventory([shipped('web-worker', 'web', { health: 'unhealthy' }), shipped('web-api', 'web', { health: 'healthy' })]), t0);
    await storeHostInventory(db, agentId, inventory([shipped('web-worker', 'web', { health: 'unhealthy' }), shipped('web-api', 'web', { state: 'restarting', health: 'none', restartCount: 4 })]), t1);

    const overview = await overviewFor(await signIn('viewer'));
    expect(overview.incidents).toHaveLength(1);
    const banner = overview.incidents[0];
    expect(banner?.owner).toEqual({ kind: 'app', name: 'web' });
    expect(banner?.tier).toBe('shipped');
    expect(banner?.containers.map((c) => [c.name, c.condition])).toEqual([
      ['web-worker', 'unhealthy'],
      ['web-api', 'restarting'],
    ]);
    expect(banner?.containers[1]).toMatchObject({ state: 'restarting', restartCount: 4 });
    expect(banner?.since).toBe(t0.toISOString());
    expect(banner?.lastChange).toMatchObject({ kind: 'deploy', id: deployId, state: 'succeeded', sha: SHA2, digest: null });
  });

  it('gives no banner for an unhealthy Observed container, but counts it as failing and on its project chip', async () => {
    await storeHostInventory(
      db,
      agentId,
      inventory([
        container('grafana', { health: 'unhealthy', compose: { project: 'monitoring', service: 'grafana' } }),
        container('prom', { compose: { project: 'monitoring', service: 'prom' } }),
      ]),
    );
    const overview = await overviewFor(await signIn('viewer'));
    expect(overview.incidents).toEqual([]);
    expect(overview.runs).toMatchObject({ containers: 2, running: 2, failing: 1, observedProjects: 1 });
    expect(overview.projects).toEqual([{ project: 'monitoring', tier: 'observed', containers: 2, running: 2, failing: 1 }]);
  });

  it('gives a stack banner for an Operated stack, with its last update and first digest', async () => {
    const stackId = await seedStack('forgejo');
    const update = await db.stackUpdate.create({
      data: { stackId, stackName: 'forgejo', agentId, state: 'succeeded', requesterLabel: 'seed', digests: { server: DIGEST }, endedAt: new Date() },
    });
    await storeHostInventory(
      db,
      agentId,
      inventory([container('forgejo-server', { tier: 'operated', app: 'forgejo', health: 'unhealthy', compose: { project: 'forgejo', service: 'server' } })]),
    );
    const overview = await overviewFor(await signIn('viewer'));
    expect(overview.incidents).toHaveLength(1);
    expect(overview.incidents[0]).toMatchObject({
      owner: { kind: 'stack', name: 'forgejo' },
      tier: 'operated',
      lastChange: { kind: 'stack-update', id: update.id, state: 'succeeded', sha: null, digest: DIGEST },
    });
    expect(overview.projects).toEqual([{ project: 'forgejo', tier: 'operated', containers: 1, running: 1, failing: 1 }]);
    expect(overview.runs.operatedStacks).toBe(1);
  });

  it('orders banners oldest incident first and skips a condition whose container left the snapshot', async () => {
    await seedApp('a-app');
    await seedApp('b-app');
    const early = new Date(Date.now() - 20 * 60_000);
    const late = new Date(Date.now() - 2 * 60_000);
    await storeHostInventory(db, agentId, inventory([shipped('b-1', 'b-app', { health: 'unhealthy' }), shipped('a-1', 'a-app')]), early);
    await storeHostInventory(db, agentId, inventory([shipped('b-1', 'b-app', { health: 'unhealthy' }), shipped('a-1', 'a-app', { health: 'unhealthy' })]), late);
    // A stale row for a container no longer reported.
    await db.containerCondition.create({ data: { agentId, containerName: 'ghost', condition: 'unhealthy', since: new Date(early.getTime() - 1000) } });
    const overview = await overviewFor(await signIn('viewer'));
    expect(overview.incidents.map((i) => i.owner.name)).toEqual(['b-app', 'a-app']);
    expect(overview.incidents[0]?.lastChange).toBeNull();
  });
});

describe('tiles, chips and totals (SHP-REQ-207)', () => {
  it('lists Deployed apps alphabetically with health derived from their containers, and leaves retired ones out', async () => {
    for (const name of ['zeta', 'alpha', 'mid', 'idle', 'new', 'sick']) await seedApp(name);
    await seedApp('gone', { retiredAt: new Date() });
    const alphaId = (await db.app.findUniqueOrThrow({ where: { name: 'alpha' } })).id;
    await seedDeploy(alphaId, 'failed', { sha: SHA, createdAt: new Date(Date.now() - 3 * HOUR), endedAt: new Date(Date.now() - 3 * HOUR) });
    await seedDeploy(alphaId, 'succeeded', { sha: SHA2, createdAt: new Date(Date.now() - HOUR), endedAt: new Date(Date.now() - HOUR) });
    await seedDeploy(alphaId, 'succeeded', { sha: 'f'.repeat(40), dryRun: true });
    const stats = { cpuPercent: 2.5, memoryBytes: 1000, memoryLimitBytes: null };
    await storeHostInventory(
      db,
      agentId,
      inventory([
        shipped('alpha-1', 'alpha', { health: 'healthy', stats }),
        shipped('alpha-2', 'alpha', { health: 'healthy', stats }),
        shipped('mid-1', 'mid', { health: 'starting' }),
        shipped('zeta-1', 'zeta', { state: 'exited' }),
        shipped('sick-1', 'sick', { health: 'unhealthy', stats }),
      ]),
    );
    const overview = await overviewFor(await signIn('viewer'));
    expect(overview.apps.map((a) => [a.name, a.health])).toEqual([
      ['alpha', 'healthy'],
      ['idle', 'unknown'],
      ['mid', 'starting'],
      ['new', 'unknown'],
      ['sick', 'unhealthy'],
      ['zeta', 'stopped'],
    ]);
    const alpha = overview.apps[0];
    expect(alpha).toMatchObject({ containers: 2, running: 2, failing: 0, cpuPercent: 5, memoryBytes: 2000 });
    expect(alpha?.lastChange).toMatchObject({ kind: 'deploy', state: 'succeeded', sha: SHA2 });
    expect(overview.apps.find((a) => a.name === 'idle')?.lastChange).toBeNull();
    expect(overview.runs).toMatchObject({ deployedApps: 6, containers: 5, running: 4, failing: 1, cpuPercent: 7.5, memoryBytes: 3000 });
    expect(overview.runs.disk).toEqual({ dataRoot: { path: '/DATA', freeBytes: 10, totalBytes: 100 }, dockerRoot: null });
    expect(overview.hostReportedAt).not.toBeNull();
  });

  it('gives chips only for compose projects that are not a Deployed app, alphabetically', async () => {
    await seedApp('web');
    await storeHostInventory(
      db,
      agentId,
      inventory([
        shipped('web-1', 'web'),
        container('z-1', { compose: { project: 'zed', service: 'one' } }),
        container('a-1', { compose: { project: 'alpha-stack', service: 'one' }, state: 'exited' }),
        container('loose'),
      ]),
    );
    const overview = await overviewFor(await signIn('viewer'));
    expect(overview.projects).toEqual([
      { project: 'alpha-stack', tier: 'observed', containers: 1, running: 0, failing: 0 },
      { project: 'zed', tier: 'observed', containers: 1, running: 1, failing: 0 },
    ]);
    expect(overview.runs.observedProjects).toBe(2);
  });
});

describe('now and the last 24 hours', () => {
  it('shows in-flight work oldest first and leaves out dry runs and finished work', async () => {
    const web = await seedApp('web');
    const stackId = await seedStack('forgejo');
    await seedDeploy(web, 'pulling', { sha: SHA2 });
    await seedDeploy(web, 'queued', { sha: SHA, dryRun: true });
    const action = await db.action.create({ data: { targetKind: 'app', targetName: 'web', agentId, verb: 'restart', state: 'running', requesterLabel: 'seed' } });
    await db.action.create({ data: { targetKind: 'app', targetName: 'web', agentId, verb: 'stop', state: 'succeeded', requesterLabel: 'seed', endedAt: new Date() } });
    await db.stackUpdate.create({ data: { stackId, stackName: 'forgejo', agentId, state: 'queued', requesterLabel: 'seed' } });
    const job = await db.maintenanceJob.create({
      data: { agentId, kind: 'volume-backup', state: 'running', volume: 'web_data', job: {}, requesterKind: 'system', requesterLabel: 'nightly' },
    });
    await db.build.create({ data: { appId: web, sha: SHA, trigger: 'manual', requesterLabel: 'seed', state: 'queued' } });

    const overview = await overviewFor(await signIn('viewer'));
    expect(overview.now.map((w) => w.kind).sort()).toEqual(['action', 'build', 'deploy', 'maintenance', 'stack-update']);
    const times = overview.now.map((w) => w.at);
    expect([...times].sort()).toEqual(times);
    expect(overview.now.find((w) => w.kind === 'action')).toMatchObject({ id: action.id, subject: 'web', label: 'restart', state: 'running' });
    expect(overview.now.find((w) => w.kind === 'deploy')).toMatchObject({ subject: 'web', label: SHA2.slice(0, 7), state: 'pulling' });
    expect(overview.now.find((w) => w.kind === 'maintenance')).toMatchObject({ id: job.id, subject: 'web_data', label: 'volume-backup' });
    expect(overview.now.find((w) => w.kind === 'stack-update')).toMatchObject({ subject: 'forgejo', label: 'update', state: 'queued' });
    expect(overview.now.find((w) => w.kind === 'build')).toMatchObject({ subject: 'web', label: SHA.slice(0, 7), state: 'queued' });
  });

  it('counts what ended in the last 24 hours and not what ended before', async () => {
    const web = await seedApp('web');
    const stackId = await seedStack('forgejo');
    const recent = new Date(Date.now() - 2 * HOUR);
    const old = new Date(Date.now() - 30 * HOUR);
    const twoHoursAgo = await db.action.create({ data: { targetKind: 'app', targetName: 'web', agentId, verb: 'restart', state: 'succeeded', requesterLabel: 'seed', endedAt: recent } });
    await db.action.create({ data: { targetKind: 'app', targetName: 'web', agentId, verb: 'start', state: 'succeeded', requesterLabel: 'seed', endedAt: old } });
    await seedDeploy(web, 'succeeded', { endedAt: recent });
    await seedDeploy(web, 'failed', { endedAt: recent });
    await seedDeploy(web, 'rolled_back', { endedAt: recent });
    await seedDeploy(web, 'succeeded', { endedAt: old });
    await seedDeploy(web, 'succeeded', { endedAt: recent, dryRun: true });
    await db.stackUpdate.create({ data: { stackId, stackName: 'forgejo', agentId, state: 'succeeded', requesterLabel: 'seed', endedAt: recent } });
    await db.stackUpdate.create({ data: { stackId, stackName: 'forgejo', agentId, state: 'rolled_back', requesterLabel: 'seed', endedAt: recent } });
    await db.stackUpdate.create({ data: { stackId, stackName: 'forgejo', agentId, state: 'failed', requesterLabel: 'seed', endedAt: old } });
    for (const [state, finishedAt] of [['succeeded', recent], ['failed', recent], ['succeeded', old]] as const) {
      await db.maintenanceJob.create({ data: { agentId, kind: 'volume-backup', state, volume: 'web_data', job: {}, requesterKind: 'system', requesterLabel: 'nightly', finishedAt } });
    }

    const { last24h } = await overviewFor(await signIn('viewer'));
    expect(last24h.deploys).toEqual({ succeeded: 1, failed: 1, rolledBack: 1 });
    expect(last24h.stackUpdates).toEqual({ succeeded: 1, failed: 1 });
    expect(last24h.actions).toBe(1);
    expect(last24h.backups).toEqual({ succeeded: 1, failed: 1 });
    expect(last24h.recent).toHaveLength(8);
    expect(last24h.recent.find((w) => w.id === twoHoursAgo.id)).toMatchObject({ kind: 'action', at: recent.toISOString() });
    expect(last24h.recent.every((w) => w.at >= new Date(Date.now() - 24 * HOUR).toISOString())).toBe(true);
    const ats = last24h.recent.map((w) => w.at);
    expect([...ats].sort().reverse()).toEqual(ats);
  });

  it('caps recent at twenty, newest first, and takes its clock from the argument of buildOverview', async () => {
    const base = new Date('2026-11-02T12:00:00.000Z');
    for (let i = 0; i < 25; i += 1) {
      await db.action.create({
        data: { targetKind: 'app', targetName: 'web', agentId, verb: 'restart', state: 'succeeded', requesterLabel: 'seed', endedAt: new Date(base.getTime() - i * 60_000) },
      });
    }
    const overview = await buildOverview(db, new Date(base.getTime() + 60_000));
    expect(overview.last24h.actions).toBe(25);
    expect(overview.last24h.recent).toHaveLength(20);
    expect(overview.last24h.recent[0]?.at).toBe(base.toISOString());
    expect(overview.generatedAt).toBe('2026-11-02T12:01:00.000Z');
  });
});
