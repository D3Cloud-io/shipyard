import { createHash } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { HostContainer, HostInventory } from '@shipyard/schema';
import { createDb, type Db } from '../../src/db.js';
import { conditionOf, readContainerConditions, storeHostInventory } from '../../src/host/index.js';

/**
 * Container conditions (SHP-ADR-013, SHP-REQ-209): the agent's report keeps, per container name,
 * when it began failing — set on the first failing report, kept while it stays failing (even when
 * unhealthy turns into restarting), and dropped once it recovers or is gone.
 */

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}
const db: Db = createDb(databaseUrl);

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
    health: 'healthy',
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

const T0 = new Date('2026-11-02T22:00:00.000Z');
const T1 = new Date('2026-11-02T22:01:00.000Z');
const T2 = new Date('2026-11-02T22:02:00.000Z');

let agentId: string;

beforeEach(async () => {
  await db.$executeRawUnsafe('truncate table "container_condition", "host_sample", "host_snapshot", "agent" cascade');
  agentId = (await db.agent.create({ data: { publicKey: hex('k', 43), fingerprint: hex('f', 16), confirmedAt: new Date() } })).id;
});

afterAll(async () => {
  await db.$disconnect();
});

describe('conditionOf', () => {
  it('names restarting before unhealthy, and nothing for a healthy or plain running container', () => {
    expect(conditionOf({ state: 'restarting', health: 'unhealthy' })).toBe('restarting');
    expect(conditionOf({ state: 'running', health: 'unhealthy' })).toBe('unhealthy');
    expect(conditionOf({ state: 'running', health: 'none' })).toBeNull();
    expect(conditionOf({ state: 'exited', health: 'none' })).toBeNull();
  });
});

describe('storeHostInventory keeps container conditions', () => {
  it('records the first failing report, keeps its time while it stays failing, and drops it on recovery', async () => {
    await storeHostInventory(db, agentId, inventory([container('imap', { state: 'running', health: 'unhealthy' }), container('web')]), T0);
    expect(await readContainerConditions(db)).toEqual([{ agentId, containerName: 'imap', condition: 'unhealthy', since: T0 }]);

    await storeHostInventory(db, agentId, inventory([container('imap', { state: 'restarting', health: 'starting' }), container('web')]), T1);
    expect(await readContainerConditions(db)).toEqual([{ agentId, containerName: 'imap', condition: 'restarting', since: T0 }]);

    await storeHostInventory(db, agentId, inventory([container('imap'), container('web')]), T2);
    expect(await readContainerConditions(db)).toEqual([]);
  });

  it('drops a failing container the agent no longer reports, and orders the rest oldest first', async () => {
    await storeHostInventory(db, agentId, inventory([container('a', { health: 'unhealthy' })]), T0);
    await storeHostInventory(db, agentId, inventory([container('a', { health: 'unhealthy' }), container('b', { state: 'restarting' })]), T1);
    expect((await readContainerConditions(db)).map((r) => r.containerName)).toEqual(['a', 'b']);

    await storeHostInventory(db, agentId, inventory([container('b', { state: 'restarting' })]), T2);
    expect(await readContainerConditions(db)).toEqual([{ agentId, containerName: 'b', condition: 'restarting', since: T1 }]);
  });
});
