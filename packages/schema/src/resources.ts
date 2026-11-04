import { z } from 'zod';

import { ContainerTier } from './host.js';
import { AppName } from './primitives.js';

/**
 * Host › Resources (SHP-ADR-013, SHP-REQ-225, SHP-REQ-226): containers' CPU and memory against the
 * host's cores and memory from the Engine's `/info`, the heaviest containers, those over 70% of a
 * memory limit, and spikes. Computed on read from the latest snapshot and `host_sample` (24 h);
 * nothing new is stored. It is not a metrics database: these five answers and no query language.
 */

const ContainerId = z.string().regex(/^[0-9a-f]{64}$/, '64 lowercase hex characters');
const Bytes = z.int().min(0);
const Instant = z.iso.datetime({ offset: true });

/** One running container's latest sample, as Resources lists it. */
export const ResourceContainer = z
  .strictObject({
    id: ContainerId,
    name: z.string().min(1).max(255),
    tier: ContainerTier,
    /** The app or stack it belongs to; null when Observed. */
    app: AppName.nullable(),
    /** Percent of one core, as Docker reports it: 250 is two and a half cores. */
    cpuPercent: z.number().min(0),
    memoryBytes: Bytes,
    memoryLimitBytes: Bytes.nullable(),
    /** `memoryBytes / memoryLimitBytes`; null without a limit. */
    limitFraction: z.number().min(0).nullable(),
  })
  .meta({ id: 'ResourceContainer', description: "One container's latest CPU and memory" });
export type ResourceContainer = z.infer<typeof ResourceContainer>;

/**
 * A container whose CPU is above five times its own 24-hour median for two or more samples in a
 * row (SHP-REQ-225). The newest such run is reported, one per container.
 */
export const ResourceSpike = z
  .strictObject({
    containerName: z.string().min(1).max(255),
    tier: ContainerTier,
    app: AppName.nullable(),
    /** The first sample of the run. */
    from: Instant,
    /** The last sample of the run; equal to the latest sample while it is still spiking. */
    to: Instant,
    samples: z.int().min(2),
    peakCpuPercent: z.number().min(0),
    medianCpuPercent: z.number().min(0),
    /** True when the latest sample is part of the run. */
    ongoing: z.boolean(),
  })
  .meta({ id: 'ResourceSpike', description: 'A run of CPU samples far above the container\'s own median' });
export type ResourceSpike = z.infer<typeof ResourceSpike>;

/** One agent's host. */
export const HostResources = z
  .strictObject({
    agent: z.strictObject({ id: z.uuid() }),
    /** When the agent sampled the latest inventory. */
    sampledAt: Instant,
    /** From `/info`; null when the agent does not report it (older than SHP-P-20). */
    cpuCores: z.int().min(1).nullable(),
    memoryBytes: Bytes.nullable(),
    /** Summed over running containers: CPU in percent of one core, and memory. "In containers", not the whole host. */
    used: z.strictObject({ cpuPercent: z.number().min(0), memoryBytes: Bytes }),
    /** At most ten each, heaviest first. */
    heaviestByCpu: z.array(ResourceContainer).max(10),
    heaviestByMemory: z.array(ResourceContainer).max(10),
    /** Containers at or over 70% of their memory limit, nearest the limit first. */
    nearLimit: z.array(ResourceContainer).max(500),
    /** Newest first. */
    spikes: z.array(ResourceSpike).max(500),
  })
  .meta({ id: 'HostResources', description: "One host's resource use against its cores and memory" });
export type HostResources = z.infer<typeof HostResources>;

/** `GET /api/host/resources`: one entry per agent that has reported an inventory. */
export const ResourcesResponse = z
  .strictObject({
    hosts: z.array(HostResources),
  })
  .meta({ id: 'ResourcesResponse', description: 'Resource use on every reporting host' });
export type ResourcesResponse = z.infer<typeof ResourcesResponse>;
