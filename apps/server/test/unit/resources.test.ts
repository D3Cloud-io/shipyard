import { describe, expect, it } from 'vitest';
import type { HostContainer, HostInventory } from '@shipyard/schema';
import { computeHostResources, findSpike, median, type CpuSample } from '../../src/resources/service.js';

/** The pure Host › Resources computation (SHP-REQ-225, SHP-REQ-226); no database. */

const T0 = Date.parse('2026-11-01T12:00:00.000Z');
const MiB = 1024 * 1024;

/** Samples one minute apart starting at T0, with the given CPU values. */
function series(values: number[]): CpuSample[] {
  return values.map((cpuPercent, i) => ({ at: new Date(T0 + i * 60_000), cpuPercent }));
}

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
    sampledAt: '2026-11-01T12:00:00.000Z',
    containers,
    volumes: [],
    images: [],
    networks: [],
    builderCache: { bytes: 0, reclaimableBytes: 0 },
    disk: { dataRoot: { path: '/DATA', freeBytes: 10, totalBytes: 100 }, dockerRoot: null },
    ...extra,
  };
}

describe('median', () => {
  it('handles odd, even and empty', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe('findSpike (SHP-REQ-225)', () => {
  it('finds a seeded two-sample spike', () => {
    const run = findSpike(series([10, 10, 10, 10, 80, 90, 10, 10, 10, 10]));
    expect(run).not.toBeNull();
    expect(run?.samples).toBe(2);
    expect(run?.from.getTime()).toBe(T0 + 4 * 60_000);
    expect(run?.to.getTime()).toBe(T0 + 5 * 60_000);
    expect(run?.peakCpuPercent).toBe(90);
    expect(run?.medianCpuPercent).toBe(10);
    expect(run?.ongoing).toBe(false);
  });

  it('does not flag a one-sample blip', () => {
    expect(findSpike(series([10, 10, 10, 200, 10, 10, 10]))).toBeNull();
  });

  it('does not flag two non-adjacent blips', () => {
    expect(findSpike(series([10, 200, 10, 200, 10, 10, 10]))).toBeNull();
  });

  it('does not flag an idle container (median 0) over a 3% blip, however long', () => {
    expect(findSpike(series([0, 0, 0, 3, 3, 3, 0, 0]))).toBeNull();
  });

  it('flags an idle container once the blip reaches a tenth of a core', () => {
    expect(findSpike(series([0, 0, 0, 12, 15, 0, 0]))?.samples).toBe(2);
  });

  it('needs strictly more than five times the median', () => {
    expect(findSpike(series([10, 10, 10, 50, 50, 10, 10]))).toBeNull();
    expect(findSpike(series([10, 10, 10, 50.1, 50.1, 10, 10]))?.samples).toBe(2);
  });

  it('reports a run that includes the latest sample as ongoing', () => {
    const run = findSpike(series([10, 10, 10, 10, 10, 90, 95, 99]));
    expect(run?.samples).toBe(3);
    expect(run?.ongoing).toBe(true);
    expect(run?.peakCpuPercent).toBe(99);
  });

  it('reports only the newest run', () => {
    const run = findSpike(series([10, 10, 80, 80, 10, 10, 10, 10, 10, 10, 10, 90, 90, 90, 10, 10]));
    expect(run?.samples).toBe(3);
    expect(run?.from.getTime()).toBe(T0 + 11 * 60_000);
  });

  it('has no spikes with fewer than three samples, and tolerates unordered input', () => {
    expect(findSpike(series([1, 100]))).toBeNull();
    expect(findSpike(series([10, 10, 10, 80, 90, 10, 10]).toReversed())?.from.getTime()).toBe(T0 + 3 * 60_000);
  });
});

describe('computeHostResources (SHP-REQ-226)', () => {
  const GiB = 1024 * MiB;
  const inv = inventory(
    [
      container('a', { cpuPercent: 50, memoryBytes: 100 * MiB, memoryLimitBytes: null }),
      container('b', { cpuPercent: 150, memoryBytes: 70 * MiB, memoryLimitBytes: 100 * MiB }),
      container('c', { cpuPercent: 5, memoryBytes: 69 * MiB, memoryLimitBytes: 100 * MiB }),
      container('d', { cpuPercent: 1, memoryBytes: 95 * MiB, memoryLimitBytes: 100 * MiB }),
      container('stopped', null),
      container('web-1', { cpuPercent: 2, memoryBytes: 10 * MiB, memoryLimitBytes: null }, { tier: 'shipped', app: 'web' }),
    ],
    { cpuCores: 4, memoryBytes: 8 * GiB },
  );
  const samples = new Map<string, CpuSample[]>([
    ['web-1', series([2, 2, 2, 2, 60, 70])],
    ['gone', series([1, 1, 1, 90, 90, 90])],
  ]);
  const res = computeHostResources('00000000-0000-4000-8000-000000000001', inv, samples);

  it('reports the host totals and sums use over containers with stats', () => {
    expect(res.cpuCores).toBe(4);
    expect(res.memoryBytes).toBe(8 * GiB);
    expect(res.used).toEqual({ cpuPercent: 208, memoryBytes: 344 * MiB });
  });

  it('lists the heaviest by CPU and by memory, heaviest first, without stopped containers', () => {
    expect(res.heaviestByCpu.map((c) => c.name)).toEqual(['b', 'a', 'c', 'web-1', 'd']);
    expect(res.heaviestByMemory.map((c) => c.name)).toEqual(['a', 'd', 'b', 'c', 'web-1']);
  });

  it('caps the heaviest lists at ten', () => {
    const many = inventory(Array.from({ length: 15 }, (_, i) => container(`c${String(i)}`, { cpuPercent: i, memoryBytes: i, memoryLimitBytes: null })));
    const out = computeHostResources('00000000-0000-4000-8000-000000000001', many, new Map());
    expect(out.heaviestByCpu).toHaveLength(10);
    expect(out.heaviestByCpu[0]?.name).toBe('c14');
    expect(out.heaviestByMemory).toHaveLength(10);
  });

  it('puts containers at or over 70% of a memory limit in nearLimit, nearest first; exactly 70% counts, 69% does not', () => {
    expect(res.nearLimit.map((c) => c.name)).toEqual(['d', 'b']);
    expect(res.nearLimit.map((c) => c.limitFraction)).toEqual([0.95, 0.7]);
    expect(res.heaviestByCpu.find((c) => c.name === 'a')?.limitFraction).toBeNull();
  });

  it('computes spikes from samples with tier and app, and ignores samples for containers no longer present', () => {
    expect(res.spikes).toHaveLength(1);
    expect(res.spikes[0]).toMatchObject({ containerName: 'web-1', tier: 'shipped', app: 'web', samples: 2, peakCpuPercent: 70, medianCpuPercent: 2, ongoing: true });
  });

  it('reports null cores and memory from an older agent', () => {
    const out = computeHostResources('00000000-0000-4000-8000-000000000001', inventory([]), new Map());
    expect(out).toMatchObject({ cpuCores: null, memoryBytes: null, used: { cpuPercent: 0, memoryBytes: 0 }, heaviestByCpu: [], nearLimit: [], spikes: [] });
  });

  it('orders spikes newest first', () => {
    const two = inventory([container('x', null), container('y', null)]);
    const out = computeHostResources('00000000-0000-4000-8000-000000000001', two, new Map([
      ['x', series([1, 1, 1, 1, 50, 50, 1, 1])],
      ['y', series([1, 1, 1, 1, 1, 1, 50, 50])],
    ]));
    expect(out.spikes.map((s) => s.containerName)).toEqual(['y', 'x']);
  });
});
