import type { Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { HostResponse, type HealthCheckResult, type HostContainer, type HostInventory } from '@shipyard/schema';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import { Bus } from '../../src/events.js';
import { storeHostInventory } from '../../src/host/index.js';
import { container, enrol, issueToken, makeKey, seedApp, seedStack, signIn } from './agent-work-fixtures.js';

/**
 * SHP-T-20.3: health-check output on GET /api/host (SHP-ADR-011, SHP-REQ-224). A probe's output is
 * redacted command output like a log line, so only a caller who may read the container's logs sees
 * it — an admin or operator, or a `can_read_logs` token scoped to the container's app or stack.
 * Everyone else sees each check's times and exit code with the output blanked.
 */

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const config = loadConfig({ DATABASE_URL: databaseUrl, SESSION_SECRET: 'test-session-secret' });
const OUTPUT = 'curl: (7) Failed to connect to localhost port 8080';

const probe: HealthCheckResult = { start: '2026-11-04T10:00:00.000Z', end: '2026-11-04T10:00:01.000Z', exitCode: 1, output: OUTPUT };
const WEB = container('web-1', { tier: 'shipped', app: 'web', compose: { project: 'web', service: 'web' }, health: 'unhealthy', healthLog: [probe] });
const PG = container('pg', { tier: 'operated', app: 'pg-stack', compose: { project: 'pg-stack', service: 'pg' }, health: 'unhealthy', healthLog: [probe] });
const WATCHTOWER = container('watchtower', { health: 'unhealthy', healthLog: [probe] });

let app: Express;

function inventory(containers: HostContainer[]): HostInventory {
  return {
    sampledAt: '2026-11-04T10:00:02.000Z',
    containers,
    volumes: [],
    images: [],
    networks: [],
    builderCache: { bytes: 0, reclaimableBytes: 0 },
    disk: { dataRoot: { path: '/DATA', freeBytes: 10, totalBytes: 100 }, dockerRoot: null },
  };
}

/** Each container's probe outputs, by name, as GET /api/host returns them to `headers`. */
async function outputs(headers: Record<string, string>): Promise<Record<string, string[]>> {
  const res = await request(app).get('/api/host').set(headers);
  expect(res.status).toBe(200);
  const body = HostResponse.parse(res.body);
  const out: Record<string, string[]> = {};
  for (const c of body.hosts[0]?.inventory.containers ?? []) out[c.name] = (c.healthLog ?? []).map((h) => h.output);
  // Whoever reads, the check's times and exit code stand.
  expect(body.hosts[0]?.inventory.containers.map((c) => c.healthLog?.[0]?.exitCode)).toEqual([1, 1, 1]);
  return out;
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "container_event", "container_health", "container_condition", "host_sample", "host_snapshot", "audit_event", "api_token_app", "api_token", "stack", "app", "agent", "session", "user" cascade',
  );
  const agentId = await enrol(db, makeKey());
  await seedApp(db, 'web', agentId);
  await seedStack(db, 'pg-stack', agentId);
  await storeHostInventory(db, agentId, inventory([WEB, PG, WATCHTOWER]));
  app = createApp({ db, logger: pino({ enabled: false }), config, bus: new Bus() });
});

afterAll(async () => {
  await db.$disconnect();
});

describe('GET /api/host: probe output', () => {
  it('shows it to an admin and an operator, and blanks it for a deployer and a viewer', async () => {
    for (const role of ['admin', 'operator'] as const) {
      const { cookie } = await signIn(db, role);
      expect(await outputs({ Cookie: cookie })).toEqual({ 'web-1': [OUTPUT], pg: [OUTPUT], watchtower: [OUTPUT] });
    }
    for (const role of ['deployer', 'viewer'] as const) {
      const { cookie } = await signIn(db, role);
      expect(await outputs({ Cookie: cookie })).toEqual({ 'web-1': [''], pg: [''], watchtower: [''] });
    }
  });

  it("shows a can_read_logs token only its own app's output; a token without it sees none", async () => {
    const admin = await signIn(db, 'admin');
    const logs = await issueToken(app, admin.cookie, ['web'], true);
    const plain = await issueToken(app, admin.cookie, ['web']);
    expect(await outputs({ Authorization: `Bearer ${logs.token}` })).toEqual({ 'web-1': [OUTPUT], pg: [''], watchtower: [''] });
    expect(await outputs({ Authorization: `Bearer ${plain.token}` })).toEqual({ 'web-1': [''], pg: [''], watchtower: [''] });
  });
});
