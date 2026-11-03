import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Express } from 'express';
import pino from 'pino';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  IncidentBundle,
  renderIncidentBundle,
  type HostContainer,
  type HostInventory,
  type LogLine,
  type LogsChunk,
  type LogsJob,
  type PollResponse,
  type Refusal,
} from '@shipyard/schema';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import { Bus } from '../../src/events.js';
import { storeHostInventory } from '../../src/host/index.js';
import { generateToken } from '../../src/tokens/tokens.js';
import { agentPost, container, enrol, hex64, makeKey, poll, seedApp, seedStack, until, type Key } from './agent-work-fixtures.js';

/**
 * `shipyard_incident` (SHP-T-19.4; SHP-ADR-013; SHP-REQ-213, SHP-REQ-214, SHP-REQ-243). A token
 * scoped to a container's app or stack, issued with logs allowed, gets the bundle as Markdown with
 * the same bundle as structured data; any other container is refused with the refusals
 * `shipyard_logs` gives. A successful call leaves one `incident.read` audit row. The fake agent
 * answers the log job as in `mcp-actions.test.ts`.
 */

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const config = loadConfig({ DATABASE_URL: databaseUrl, SESSION_SECRET: 'test-session-secret' });
const logger = pino({ enabled: false });

const T0 = new Date('2026-11-02T10:00:00.000Z');
const DEPLOYED_AT = new Date('2026-11-02T09:30:00.000Z');
const SHA = 'abcdef0'.padEnd(40, '1');

const WEB = container('web-1', {
  tier: 'shipped',
  app: 'web',
  compose: { project: 'web', service: 'web' },
  health: 'unhealthy',
  restartCount: 2,
});
const API = container('api-1', { tier: 'shipped', app: 'api', compose: { project: 'api', service: 'api' } });
const PG = container('pg', { tier: 'operated', app: 'pg-stack', compose: { project: 'pg-stack', service: 'pg' } });
const WATCHTOWER = container('watchtower');

let bus: Bus;
let app: Express;
let server: Server;
let baseUrl: string;
let key: Key;
let agentId: string;
let appIds: Map<string, string>;
const clients: Client[] = [];

interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
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

async function listen(): Promise<void> {
  // 127.0.0.1 explicitly: see test/setup/loopback.ts for why an unqualified listen can be dialled wrong.
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      resolve(s);
    });
  });
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

interface TokenOptions {
  role?: 'operator' | 'viewer';
  canReadLogs?: boolean;
  stacks?: string[];
}

/** A token scoped to `apps` (and `options.stacks`), owned by a user of `options.role`. */
async function tokenFor(label: string, apps: string[], options: TokenOptions = {}): Promise<string> {
  const { role = 'operator', canReadLogs = false, stacks = [] } = options;
  const user = await db.user.create({ data: { email: `${label}-${randomUUID()}@example.com`, displayName: label, role } });
  const { token, hash, prefix } = generateToken();
  const stackRows = await db.stack.findMany({ where: { name: { in: stacks } }, select: { id: true } });
  expect(stackRows).toHaveLength(stacks.length);
  await db.apiToken.create({
    data: {
      userId: user.id,
      label,
      tokenHash: hash,
      prefix,
      canReadLogs,
      apps: { create: apps.map((a) => ({ appId: appIds.get(a) ?? '' })) },
      stacks: { create: stackRows.map((r) => ({ stackId: r.id })) },
    },
  });
  return token;
}

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'mcp-incident-test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport as Transport);
  clients.push(client);
  return client;
}

async function call(client: Client, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name: 'shipyard_incident', arguments: args })) as ToolResult;
}

function refusalOf(result: ToolResult): Refusal {
  expect(result.isError).toBe(true);
  return (result.structuredContent as { error: Refusal }).error;
}

function logsOf(r: PollResponse): LogsJob | undefined {
  return 'logs' in r ? r.logs : undefined;
}

function at(i: number): string {
  return new Date(T0.getTime() + i * 1000).toISOString();
}

const ERROR_LINES: LogLine[] = [
  { at: at(1), stream: 'stdout', text: 'listening on :3000' },
  { at: at(2), stream: 'stderr', text: 'Error: connect ECONNREFUSED 10.0.0.5:5432' },
  { at: at(3), stream: 'stderr', text: 'still trying' },
];

/** The fake agent: takes the next log read it is handed and answers it with `lines`. */
async function agentSends(lines: LogLine[]): Promise<LogsJob> {
  let job: LogsJob | undefined;
  await until(async () => {
    job = logsOf(await poll(app, key, ['logs']));
    return job !== undefined;
  });
  if (job === undefined) throw new Error('no log read was handed to the agent');
  const chunk: LogsChunk = { logsId: job.logsId, seq: 0, lines, done: true };
  const res = await agentPost(app, key, `/api/agent/logs/${job.logsId}/chunks`, chunk);
  expect(res.status).toBe(200);
  return job;
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "action", "stack_update", "stack", "container_condition", "host_sample", "host_snapshot", "target_image", "step", "outbox", "deploy_target", "deploy", "audit_event", "agent_nonce", "api_token_app", "api_token", "app", "agent", "session", "user" cascade',
  );
  key = makeKey();
  agentId = await enrol(db, key);
  appIds = new Map<string, string>([
    ['web', await seedApp(db, 'web', agentId)],
    ['api', await seedApp(db, 'api', agentId)],
  ]);
  await seedStack(db, 'pg-stack', agentId);
  await storeHostInventory(db, agentId, inventory([WEB, API, PG, WATCHTOWER]), T0);
  await db.deploy.create({
    data: {
      requestedSha: SHA,
      requesterLabel: 'matt (console)',
      targets: { create: { appId: appIds.get('web') ?? '', state: 'succeeded', startedAt: DEPLOYED_AT, endedAt: DEPLOYED_AT, createdAt: DEPLOYED_AT } },
    },
  });
  bus = new Bus();
  app = createApp({ db, logger, config, bus });
  // The server only queues log work for an agent it has heard advertise the capability.
  await poll(app, key, ['logs']);
  await listen();
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

afterAll(async () => {
  await db.$disconnect();
});

describe('tools/list', () => {
  it('lists shipyard_incident as read-only, taking only a container', async () => {
    const client = await connect(await tokenFor('a', ['web']));
    const tool = (await client.listTools()).tools.find((t) => t.name === 'shipyard_incident');
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.description).toContain('never stored');
    expect(JSON.stringify(tool?.inputSchema)).toContain('"container"');
  });
});

describe('shipyard_incident', () => {
  it("returns the bundle as Markdown and as data for a container of the token's app, by name (SHP-REQ-213, SHP-REQ-243)", async () => {
    const client = await connect(await tokenFor('claude', ['web'], { canReadLogs: true }));
    const sent = agentSends(ERROR_LINES);
    const result = await call(client, { container: 'web-1' });
    const job = await sent;
    expect(result.isError ?? false).toBe(false);
    expect(job).toMatchObject({ containerId: WEB.id, tail: 2000 });

    const text = result.content[0]?.text ?? '';
    expect(text).toContain('# Incident: web-1');
    expect(text).toContain('## What Shipyard sees');
    expect(text).toContain('First error: Error: connect ECONNREFUSED 10.0.0.5:5432');
    expect(text).toContain('Last deploy abcdef0 succeeded');
    expect(text).toContain('## Logs (since the first error, redacted)');
    expect(text).not.toContain('listening on :3000');

    const bundle = IncidentBundle.parse(result.structuredContent);
    expect(text).toBe(renderIncidentBundle(bundle));
    expect(bundle.container).toEqual({ id: WEB.id, name: 'web-1', tier: 'shipped', owner: 'web', compose: { project: 'web', service: 'web' } });
    expect(bundle.logs).toEqual({ from: 'first-error', lines: ERROR_LINES.slice(1), unavailable: null });
    expect(bundle.lastChange).toMatchObject({ kind: 'deploy', sha: SHA });

    // One incident.read row, naming the container; the log read under it is audited as a log view.
    const audit = await db.auditEvent.findMany({ where: { action: 'incident.read' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.entityId).toBe(WEB.id);
    expect(JSON.stringify(audit[0]?.after)).toContain('web-1');
    expect(JSON.stringify(audit[0]?.after)).not.toContain('ECONNREFUSED');
  });

  it('takes a full 64-hex ID as it is', async () => {
    const client = await connect(await tokenFor('claude', ['web'], { canReadLogs: true }));
    const sent = agentSends(ERROR_LINES);
    const result = await call(client, { container: WEB.id });
    expect((await sent).containerId).toBe(WEB.id);
    expect(result.isError ?? false).toBe(false);
    expect(result.content[0]?.text).toContain('# Incident: web-1');
    expect(await db.auditEvent.count({ where: { action: 'incident.read' } })).toBe(1);
  });

  it("reads an Operated container with a token scoped to its stack", async () => {
    const client = await connect(await tokenFor('claude', [], { canReadLogs: true, stacks: ['pg-stack'] }));
    const sent = agentSends([{ at: at(1), stream: 'stdout', text: 'ready' }]);
    const result = await call(client, { container: 'pg' });
    expect((await sent).containerId).toBe(PG.id);
    expect(result.content[0]?.text).toContain('# Incident: pg');
    expect(IncidentBundle.parse(result.structuredContent).logs.from).toBe('tail');
  });

  it("refuses another app's container, and an unscoped stack's, as forbidden (SHP-REQ-214)", async () => {
    const client = await connect(await tokenFor('claude', ['web'], { canReadLogs: true }));
    for (const name of ['api-1', API.id, 'pg']) {
      expect(refusalOf(await call(client, { container: name })).code).toBe('forbidden');
    }
    expect(await db.auditEvent.count({ where: { action: 'incident.read' } })).toBe(0);
  });

  it('never reads an Observed container, even one named by its full ID', async () => {
    const client = await connect(await tokenFor('claude', ['web'], { canReadLogs: true, stacks: ['pg-stack'] }));
    for (const name of ['watchtower', WATCHTOWER.id]) {
      const refusal = refusalOf(await call(client, { container: name }));
      expect(refusal.code).toBe('forbidden');
      expect(refusal.message).toContain('only observes');
    }
    expect(await db.auditEvent.count({ where: { action: 'incident.read' } })).toBe(0);
  });

  it("is refused for a token without logs allowed with shipyard_logs' own message, before any name is checked", async () => {
    const client = await connect(await tokenFor('claude', ['web']));
    for (const name of ['web-1', 'no-such-container']) {
      const refusal = refusalOf(await call(client, { container: name }));
      expect(refusal.code).toBe('forbidden');
      expect(refusal.message).toBe("This token can't read logs.");
      expect(refusal.fix).toBe('Issue a token with logs allowed in Settings › Claude & tokens.');
    }
    expect(await db.auditEvent.count({ where: { action: 'incident.read' } })).toBe(0);
  });

  it('is refused when the token may read logs but its owner no longer can', async () => {
    const client = await connect(await tokenFor('claude', ['web'], { role: 'viewer', canReadLogs: true }));
    expect(refusalOf(await call(client, { container: 'web-1' })).code).toBe('forbidden');
  });

  it('refuses a container the host does not report, by name and by ID', async () => {
    const client = await connect(await tokenFor('claude', ['web'], { canReadLogs: true }));
    for (const name of ['ghost', 'f'.repeat(64)]) {
      expect(refusalOf(await call(client, { container: name })).code).toBe('unknown_container');
    }
  });

  it('refuses a name two agents both report, and points at the full ID', async () => {
    const other = await db.agent.create({ data: { publicKey: 'other-key', fingerprint: `fp-${randomUUID()}`, confirmedAt: new Date() } });
    await storeHostInventory(db, other.id, inventory([container('web-1', { id: hex64('web-1 on the other host'), tier: 'shipped', app: 'web', compose: { project: 'web', service: 'web' } })]), T0);
    const client = await connect(await tokenFor('claude', ['web'], { canReadLogs: true }));
    const refusal = refusalOf(await call(client, { container: 'web-1' }));
    expect(refusal).toMatchObject({
      code: 'invalid_request',
      message: 'More than one host reports a container named web-1.',
      fix: 'Use its full 64-character ID from shipyard_host.',
    });
    expect(await db.auditEvent.count({ where: { action: 'incident.read' } })).toBe(0);

    // The full ID is unambiguous: the one in the token's scope is read.
    const sent = agentSends(ERROR_LINES);
    const byId = await call(client, { container: WEB.id });
    expect((await sent).containerId).toBe(WEB.id);
    expect(byId.isError ?? false).toBe(false);
  });

  it('refuses an out-of-scope name as forbidden even when two hosts report it, so the token learns no more', async () => {
    const other = await db.agent.create({ data: { publicKey: 'other-key', fingerprint: `fp-${randomUUID()}`, confirmedAt: new Date() } });
    await storeHostInventory(db, other.id, inventory([container('web-1', { id: hex64('web-1 on the other host'), tier: 'shipped', app: 'web', compose: { project: 'web', service: 'web' } })]), T0);
    const client = await connect(await tokenFor('claude', ['api'], { canReadLogs: true }));
    expect(refusalOf(await call(client, { container: 'web-1' })).code).toBe('forbidden');
  });

  it('reads the one same-named container the token may read when the other host\'s is outside its scope', async () => {
    const other = await db.agent.create({ data: { publicKey: 'other-key', fingerprint: `fp-${randomUUID()}`, confirmedAt: new Date() } });
    await storeHostInventory(db, other.id, inventory([container('web-1', { id: hex64('observed web-1 elsewhere') })]), T0);
    const client = await connect(await tokenFor('claude', ['web'], { canReadLogs: true }));
    const sent = agentSends(ERROR_LINES);
    const result = await call(client, { container: 'web-1' });
    expect((await sent).containerId).toBe(WEB.id);
    expect(result.isError ?? false).toBe(false);
  });

  it('rejects input that is not a container string', async () => {
    const client = await connect(await tokenFor('claude', ['web'], { canReadLogs: true }));
    for (const args of [{}, { container: '' }, { container: 'web-1', extra: true }]) {
      const result = await call(client, args);
      expect(result.isError).toBe(true);
    }
  });
});
