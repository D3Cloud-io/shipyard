import { generateKeyPairSync, randomUUID, sign, randomBytes } from 'node:crypto';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fingerprintOf, ResourcesResponse, signingString, type HostContainer, type HostInventory } from '@shipyard/schema';
import { createApp } from '../../src/app.js';
import { SESSION_COOKIE, createSession } from '../../src/auth/index.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import { Bus } from '../../src/events.js';
import { generateToken } from '../../src/tokens/tokens.js';

/**
 * GET /api/host/resources (SHP-T-20.4; SHP-REQ-225, SHP-REQ-226): use against the host's cores and
 * memory, the heaviest containers, those near a memory limit, and spikes computed on read from
 * `host_sample`. Read-only for every signed-in role and every token.
 */

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const config = loadConfig({ DATABASE_URL: databaseUrl, SESSION_SECRET: 'test-session-secret' });
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const NOW = Date.now();

function hex(seed: string): string {
  return Buffer.from(seed.repeat(64)).toString('hex').slice(0, 64);
}

function container(name: string, stats: HostContainer['stats'], extra: Partial<HostContainer> = {}): HostContainer {
  return {
    id: hex(name),
    name,
    image: `${name}:latest`,
    imageId: `sha256:${hex(`${name}-image`)}`,
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
    stats,
    ...extra,
  };
}

function inventory(containers: HostContainer[], extra: Partial<HostInventory> = {}): HostInventory {
  return {
    sampledAt: new Date(NOW).toISOString(),
    containers,
    volumes: [],
    images: [],
    networks: [],
    builderCache: { bytes: 0, reclaimableBytes: 0 },
    disk: { dataRoot: { path: '/DATA', freeBytes: 10, totalBytes: 100 }, dockerRoot: null },
    ...extra,
  };
}

let agentId: string;
let fingerprint: string;
let app: ReturnType<typeof createApp>;

async function newAgent(): Promise<{ id: string; fingerprint: string }> {
  const { publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const raw = Buffer.from(der.subarray(der.length - 32));
  const fp = fingerprintOf(raw);
  const row = await db.agent.create({ data: { publicKey: raw.toString('base64'), fingerprint: fp, confirmedAt: new Date() } });
  return { id: row.id, fingerprint: fp };
}

async function seedSnapshot(forAgent: string, inv: HostInventory): Promise<void> {
  await db.hostSnapshot.create({ data: { agentId: forAgent, inventory: inv as never, sampledAt: new Date(inv.sampledAt), reportedAt: new Date(NOW) } });
}

/** One sample a minute, the last one `values.length - 1` minutes after the first, ending now. */
async function seedSamples(forAgent: string, containerName: string, values: number[]): Promise<void> {
  const start = NOW - (values.length - 1) * 60_000;
  await db.hostSample.createMany({
    data: values.map((cpuPercent, i) => ({ agentId: forAgent, containerName, at: new Date(start + i * 60_000), cpuPercent, memoryBytes: 1n })),
  });
}

async function signIn(role: 'admin' | 'operator' | 'deployer' | 'viewer'): Promise<string> {
  const user = await db.user.create({ data: { email: `${role}-${randomUUID()}@example.com`, displayName: role, role } });
  const session = await createSession(db, { userId: user.id, method: 'password' });
  return `${SESSION_COOKIE}=${session.token}`;
}

async function read(cookie: string): Promise<ResourcesResponse> {
  const res = await request(app).get('/api/host/resources').set('Cookie', cookie);
  expect(res.status).toBe(200);
  return ResourcesResponse.parse(res.body);
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "host_sample", "host_snapshot", "audit_event", "agent_nonce", "api_token_app", "api_token", "session", "user", "app", "agent" cascade',
  );
  const a = await newAgent();
  agentId = a.id;
  fingerprint = a.fingerprint;
  app = createApp({ db, logger: pino({ enabled: false }), config, bus: new Bus() });
});

afterAll(async () => {
  await db.$disconnect();
});

describe('GET /api/host/resources (SHP-T-20.4)', () => {
  it('is empty until an agent reports an inventory', async () => {
    expect(await read(await signIn('viewer'))).toEqual({ hosts: [] });
  });

  it('returns use against cores and memory, the heaviest, containers near a limit, and spikes (SHP-REQ-225, SHP-REQ-226)', async () => {
    await seedSnapshot(
      agentId,
      inventory(
        [
          container('db', { cpuPercent: 30, memoryBytes: 900 * MiB, memoryLimitBytes: 1000 * MiB }, { tier: 'operated', app: 'data' }),
          container('web-1', { cpuPercent: 95, memoryBytes: 200 * MiB, memoryLimitBytes: null }, { tier: 'shipped', app: 'web' }),
          container('cache', { cpuPercent: 20, memoryBytes: 700 * MiB, memoryLimitBytes: 1000 * MiB }),
          container('blip', { cpuPercent: 4, memoryBytes: 10 * MiB, memoryLimitBytes: 1000 * MiB }),
          container('idle', { cpuPercent: 1, memoryBytes: 10 * MiB, memoryLimitBytes: null }),
          container('stopped', null, { state: 'exited' }),
        ],
        { cpuCores: 4, memoryBytes: 8 * GiB },
      ),
    );
    // A seeded two-sample spike on web-1, still running; a one-sample blip on another container.
    await seedSamples(agentId, 'web-1', [5, 5, 5, 5, 5, 5, 90, 95]);
    await seedSamples(agentId, 'blip', [2, 2, 2, 2, 2, 2, 80, 2]);
    // An idle container with a 3% pair is under the noise floor; samples for an absent container are ignored.
    await seedSamples(agentId, 'idle', [0, 0, 0, 0, 3, 3, 0, 0]);
    await seedSamples(agentId, 'removed', [1, 1, 1, 90, 90, 90]);
    // Outside the 24 h window: must not count towards a median or a spike.
    await db.hostSample.create({ data: { agentId, containerName: 'cache', at: new Date(NOW - 25 * 3_600_000), cpuPercent: 500, memoryBytes: 1n } });

    const body = await read(await signIn('viewer'));
    expect(body.hosts).toHaveLength(1);
    const host = body.hosts[0];
    expect(host?.agent).toEqual({ id: agentId });
    expect(host?.cpuCores).toBe(4);
    expect(host?.memoryBytes).toBe(8 * GiB);
    expect(host?.used).toEqual({ cpuPercent: 150, memoryBytes: 1820 * MiB });
    expect(host?.heaviestByCpu.map((c) => c.name)).toEqual(['web-1', 'db', 'cache', 'blip', 'idle']);
    expect(host?.heaviestByMemory.map((c) => c.name)).toEqual(['db', 'cache', 'web-1', 'blip', 'idle']);
    expect(host?.heaviestByCpu[0]).toMatchObject({ id: hex('web-1'), tier: 'shipped', app: 'web', memoryLimitBytes: null, limitFraction: null });
    expect(host?.nearLimit.map((c) => [c.name, c.limitFraction])).toEqual([['db', 0.9], ['cache', 0.7]]);

    expect(host?.spikes).toHaveLength(1);
    expect(host?.spikes[0]).toMatchObject({ containerName: 'web-1', tier: 'shipped', app: 'web', samples: 2, peakCpuPercent: 95, medianCpuPercent: 5, ongoing: true });
    expect(Date.parse(host?.spikes[0]?.to ?? '')).toBe(NOW);
    expect(Date.parse(host?.spikes[0]?.from ?? '')).toBe(NOW - 60_000);
  });

  it('reports null cores and memory for a snapshot from an older agent', async () => {
    await seedSnapshot(agentId, inventory([container('pg', { cpuPercent: 1.5, memoryBytes: 64 * MiB, memoryLimitBytes: null })]));
    const host = (await read(await signIn('admin'))).hosts[0];
    expect(host?.cpuCores).toBeNull();
    expect(host?.memoryBytes).toBeNull();
    expect(host?.used.memoryBytes).toBe(64 * MiB);
    expect(host?.spikes).toEqual([]);
  });

  it('keeps each agent apart', async () => {
    const other = await newAgent();
    await seedSnapshot(agentId, inventory([container('one', { cpuPercent: 1, memoryBytes: 1, memoryLimitBytes: null })]));
    await seedSnapshot(other.id, inventory([container('two', { cpuPercent: 1, memoryBytes: 1, memoryLimitBytes: null })]));
    await seedSamples(other.id, 'two', [1, 1, 1, 1, 60, 60]);
    const body = await read(await signIn('operator'));
    expect(body.hosts).toHaveLength(2);
    const byAgent = new Map(body.hosts.map((h) => [h.agent.id, h]));
    expect(byAgent.get(agentId)?.spikes).toEqual([]);
    expect(byAgent.get(other.id)?.spikes.map((s) => s.containerName)).toEqual(['two']);
  });

  it('is readable by every role and by a token, and writes nothing', async () => {
    await seedSnapshot(agentId, inventory([container('pg', { cpuPercent: 1, memoryBytes: 1, memoryLimitBytes: null })]));
    const samplesBefore = await db.hostSample.count();
    const auditBefore = await db.auditEvent.count();
    for (const role of ['admin', 'operator', 'deployer', 'viewer'] as const) {
      expect((await read(await signIn(role))).hosts).toHaveLength(1);
    }
    const user = await db.user.create({ data: { email: `token-${randomUUID()}@example.com`, displayName: 'token', role: 'deployer' } });
    const { token, hash, prefix } = generateToken();
    await db.apiToken.create({ data: { userId: user.id, label: 'host reader', tokenHash: hash, prefix } });
    const viaToken = await request(app).get('/api/host/resources').set('Authorization', `Bearer ${token}`);
    expect(viaToken.status).toBe(200);
    expect(await db.hostSample.count()).toBe(samplesBefore);
    expect(await db.auditEvent.count()).toBe(auditBefore);
  });

  it('refuses an unauthenticated read and an agent-signed one', async () => {
    const anonymous = await request(app).get('/api/host/resources');
    expect(anonymous.status).toBe(401);
    expect((anonymous.body as { error: { code: string } }).error.code).toBe('unauthenticated');

    const timestamp = String(Date.now());
    const nonce = randomBytes(16).toString('base64url');
    const data = signingString({ method: 'GET', path: '/api/host/resources', timestamp, nonce, body: Buffer.from('', 'utf8') });
    const { privateKey } = generateKeyPairSync('ed25519');
    const agentSigned = await request(app).get('/api/host/resources').set({
      'x-shipyard-key': fingerprint,
      'x-shipyard-timestamp': timestamp,
      'x-shipyard-nonce': nonce,
      'x-shipyard-signature': sign(null, Buffer.from(data, 'utf8'), privateKey).toString('base64'),
    });
    expect(agentSigned.status).toBe(401);
  });
});
