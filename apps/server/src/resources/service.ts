import type { HostContainer, HostInventory, HostResources, ResourceContainer, ResourceSpike } from '@shipyard/schema';

/**
 * Host › Resources, computed on read (SHP-ADR-013, SHP-REQ-225, SHP-REQ-226). Pure functions over
 * the latest inventory and the 24-hour `host_sample` window; no database, no clock, so the unit
 * tests need neither. Nothing here is stored.
 */

/** A spike is a CPU sample above this many times the container's own 24-hour median (SHP-REQ-225). */
export const SPIKE_MEDIAN_FACTOR = 5;

/**
 * The least CPU, in percent of one core, a sample must reach to count as a spike: a tenth of a
 * core. Without a floor an idle container whose median is near 0 would flag on every blip, since
 * five times nothing is nothing. This is a Shipyard choice on top of SHP-REQ-225, not part of it.
 */
export const SPIKE_NOISE_FLOOR_PERCENT = 10;

/** Consecutive spiking samples that make a spike; a single sample is a blip, not a spike. */
export const SPIKE_MIN_SAMPLES = 2;

/** A container needs this many samples in the window before it has a median worth comparing to. */
export const SPIKE_MIN_HISTORY = 3;

/** Memory at or over this fraction of a container's limit is "near" it (SHP-REQ-226). */
export const NEAR_LIMIT_FRACTION = 0.7;

/** How many containers each "heaviest" list holds. */
export const HEAVIEST_COUNT = 10;

/** One CPU sample of one container. */
export interface CpuSample {
  at: Date;
  cpuPercent: number;
}

/** The newest spiking run in a container's samples. */
export interface SpikeRun {
  from: Date;
  to: Date;
  samples: number;
  peakCpuPercent: number;
  medianCpuPercent: number;
  ongoing: boolean;
}

/** The median of `values`; 0 for none. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? 0) + upper) / 2;
}

/**
 * The newest run of `SPIKE_MIN_SAMPLES` or more consecutive samples, each above
 * `SPIKE_MEDIAN_FACTOR` times the median of all of `samples` and at least
 * `SPIKE_NOISE_FLOOR_PERCENT` (SHP-REQ-225); null when there is none. `samples` are one container's
 * window, in any order. A container with fewer than `SPIKE_MIN_HISTORY` samples has no spikes.
 * `ongoing` is true when the run includes the container's latest sample.
 */
export function findSpike(samples: readonly CpuSample[]): SpikeRun | null {
  if (samples.length < SPIKE_MIN_HISTORY) return null;
  const ordered = samples.toSorted((a, b) => a.at.getTime() - b.at.getTime());
  const med = median(ordered.map((s) => s.cpuPercent));
  const spiking = (s: CpuSample): boolean => s.cpuPercent > SPIKE_MEDIAN_FACTOR * med && s.cpuPercent >= SPIKE_NOISE_FLOOR_PERCENT;

  let newest: SpikeRun | null = null;
  let start = -1;
  for (let i = 0; i <= ordered.length; i++) {
    const sample = ordered[i];
    if (sample !== undefined && spiking(sample)) {
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0 && i - start >= SPIKE_MIN_SAMPLES) {
      const run = ordered.slice(start, i);
      newest = {
        from: run[0]?.at ?? new Date(0),
        to: run[run.length - 1]?.at ?? new Date(0),
        samples: run.length,
        peakCpuPercent: Math.max(...run.map((s) => s.cpuPercent)),
        medianCpuPercent: med,
        ongoing: i === ordered.length,
      };
    }
    start = -1;
  }
  return newest;
}

function resourceContainer(c: HostContainer): ResourceContainer | null {
  if (c.stats === null) return null;
  const { cpuPercent, memoryBytes, memoryLimitBytes } = c.stats;
  return {
    id: c.id,
    name: c.name,
    tier: c.tier,
    app: c.app,
    cpuPercent,
    memoryBytes,
    memoryLimitBytes,
    limitFraction: memoryLimitBytes === null || memoryLimitBytes === 0 ? null : memoryBytes / memoryLimitBytes,
  };
}

/**
 * One host's Resources entry from its latest inventory and its samples by container name
 * (SHP-REQ-226). `used` sums the containers that have stats; the heaviest lists are the top
 * `HEAVIEST_COUNT` by CPU and by memory; `nearLimit` is memory at or over `NEAR_LIMIT_FRACTION` of
 * its limit, nearest first; `spikes` are the newest run per container, newest first. A sample for a
 * container no longer in the inventory is ignored.
 */
export function computeHostResources(agentId: string, inventory: HostInventory, samplesByContainer: ReadonlyMap<string, readonly CpuSample[]>): HostResources {
  const running = inventory.containers.flatMap((c) => {
    const r = resourceContainer(c);
    return r === null ? [] : [r];
  });

  const spikes: ResourceSpike[] = [];
  for (const c of inventory.containers) {
    const run = findSpike(samplesByContainer.get(c.name) ?? []);
    if (run === null) continue;
    spikes.push({
      containerName: c.name,
      tier: c.tier,
      app: c.app,
      from: run.from.toISOString(),
      to: run.to.toISOString(),
      samples: run.samples,
      peakCpuPercent: run.peakCpuPercent,
      medianCpuPercent: run.medianCpuPercent,
      ongoing: run.ongoing,
    });
  }
  spikes.sort((a, b) => Date.parse(b.to) - Date.parse(a.to) || a.containerName.localeCompare(b.containerName));

  return {
    agent: { id: agentId },
    sampledAt: inventory.sampledAt,
    cpuCores: inventory.cpuCores ?? null,
    memoryBytes: inventory.memoryBytes ?? null,
    used: {
      cpuPercent: running.reduce((sum, c) => sum + c.cpuPercent, 0),
      memoryBytes: running.reduce((sum, c) => sum + c.memoryBytes, 0),
    },
    heaviestByCpu: running.toSorted((a, b) => b.cpuPercent - a.cpuPercent || a.name.localeCompare(b.name)).slice(0, HEAVIEST_COUNT),
    heaviestByMemory: running.toSorted((a, b) => b.memoryBytes - a.memoryBytes || a.name.localeCompare(b.name)).slice(0, HEAVIEST_COUNT),
    nearLimit: running
      .filter((c) => c.limitFraction !== null && c.limitFraction >= NEAR_LIMIT_FRACTION)
      .toSorted((a, b) => (b.limitFraction ?? 0) - (a.limitFraction ?? 0) || a.name.localeCompare(b.name)),
    spikes,
  };
}
