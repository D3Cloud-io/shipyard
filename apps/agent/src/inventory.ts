import { statfs as nodeStatfs } from 'node:fs/promises';
import { totalmem } from 'node:os';
import {
  Digest,
  HostInventory,
  RestartPolicy,
  type AppName,
  type ContainerStats,
  type ContainerTier,
  type HealthCheckResult,
  type HostContainer,
  type HostFilesystem,
  type Manifest,
  type StackManifest,
} from '@shipyard/schema';
import {
  createRedactor,
  loadRedactionValues,
  redactionValues,
  type DockerPort,
  type DockerRootSpace,
  type FsPort,
  type HostContainerRecord,
  type HostImageRecord,
  type HostInfo,
  type HostNetworkRecord,
  type HostStatsSample,
  type HostSystemDf,
  type HostVolumeRecord,
} from '@shipyard/sequence';
import type { ReportLog } from './report.js';

/**
 * The host inventory (SHP-T-14.4, SHP-REQ-175..177): every container Docker knows about, with its
 * tier, plus volumes, images, networks, the builder cache and free space, read through the Docker
 * port and sent with every report. The report carries it each interval, so a container that
 * stopped is reported as stopped on the next one; the server keeps no inventory the agent did not
 * just read.
 *
 * What the inventory costs on a real host is why it is cached in pieces: `/system/df` computes
 * every volume's size and can take tens of seconds, and the Docker root's free space needs a
 * helper container. Neither changes minute to minute. Everything else is a list or one-shot read.
 *
 * Nothing here can leak a container's environment, command or labels: the port never carries them
 * (SHP-REQ-177), and `HostInventory` is a strict schema with no field for them.
 *
 * Each container also carries its last exit code, whether it was OOM-killed and its restart policy,
 * and the host its CPU count and memory from `/info` (SHP-T-20.2, SHP-REQ-221). A container that is
 * unhealthy or starting carries its last five health-check results, their output redacted here
 * exactly as its logs are (SHP-REQ-220): when the redaction values cannot be read, the result goes
 * with empty output rather than with text that was not redacted.
 */

export const DF_TTL_MS = 10 * 60_000;
export const DOCKER_ROOT_TTL_MS = 15 * 60_000;
/** A failed df or Docker-root read is tried again after this, not on every report. */
export const FAILURE_RETRY_MS = 60_000;
/** A report does not wait longer than this for a slow `/system/df`; the read carries on in the background. */
export const DF_WAIT_MS = 30_000;
const STATS_CONCURRENCY = 8;
/** `HealthCheckResult.output` is capped at 4 KiB, cut after redaction. */
export const HEALTH_OUTPUT_MAX_CHARS = 4096;

/** Docker keeps at most this many bytes of a probe's output (`MaxOutputLen`), cutting where it likes. */
export const DOCKER_PROBE_OUTPUT_MAX_BYTES = 4096;

/**
 * Output Docker cut at its limit may end part-way into a secret, which the redactor cannot match
 * whole. Drops the longest tail that is the start of any redaction value, so no prefix of a secret
 * is sent (the same guarantee `safeCut` gives logs).
 */
export function dropPartialSecret(text: string, values: readonly string[]): string {
  let drop = 0;
  for (const value of values) {
    for (let k = Math.min(value.length - 1, text.length); k > drop && k >= 2; k--) {
      if (text.endsWith(value.slice(0, k))) {
        drop = k;
        break;
      }
    }
  }
  return drop === 0 ? text : text.slice(0, text.length - drop);
}

// ─── Tier ────────────────────────────────────────────────────────────────────

export interface Tier {
  tier: ContainerTier;
  app: AppName | null;
}

/**
 * A container's tier (SHP-ADR-008), from this host's manifests only. A compose project some loaded
 * app manifest names is `shipped` — the whole project belongs to that app, including services the
 * manifest does not map, such as its database. A project an adopted stack names (a manifest under
 * `<data root>/stacks/`, SHP-ADR-010, SHP-REQ-183) is `operated`, with the stack's name as `app`.
 * Anything else is `observed`. An app manifest wins over a stack naming the same project: the
 * deploy engine owns that project, and an adoption must never demote it.
 */
export function deriveTier(
  composeProject: string | null,
  manifests: readonly Pick<Manifest, 'name' | 'compose'>[],
  stacks: readonly Pick<StackManifest, 'name' | 'compose'>[] = [],
): Tier {
  if (composeProject !== null) {
    const owner = manifests.find((m) => m.compose.project === composeProject);
    if (owner !== undefined) return { tier: 'shipped', app: owner.name };
    const stack = stacks.find((m) => m.compose.project === composeProject);
    if (stack !== undefined) return { tier: 'operated', app: stack.name };
  }
  return { tier: 'observed', app: null };
}

// ─── CPU and memory ──────────────────────────────────────────────────────────

/**
 * `cpuPercent = Δcpu / Δsystem * onlineCpus * 100` between two samples of the same container
 * (what `docker stats` computes from precpu). One-shot stats carry no precpu, so the previous
 * sample is the agent's own. Null when the counters did not advance or went backwards (a restart).
 */
export function cpuPercent(prev: Pick<HostStatsSample, 'cpuTotal' | 'systemCpu'>, cur: HostStatsSample): number | null {
  const cpuDelta = cur.cpuTotal - prev.cpuTotal;
  const systemDelta = cur.systemCpu - prev.systemCpu;
  if (cpuDelta < 0 || systemDelta <= 0) return null;
  return Math.round((cpuDelta / systemDelta) * cur.onlineCpus * 10_000) / 100;
}

// ─── Mapping ─────────────────────────────────────────────────────────────────

const PORT_PROTOCOLS = new Set(['tcp', 'udp', 'sctp']);
const MOUNT_TYPES = new Set(['volume', 'bind', 'tmpfs', 'npipe', 'cluster', 'image']);
const STATES = new Set(['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead']);

/**
 * Docker Hub's spellings of one repository, made one: `docker.io/library/nginx`,
 * `index.docker.io/library/nginx` and `library/nginx` are all `nginx`, which is how the Engine
 * writes RepoDigests, while a compose file may write any of them.
 */
function normalizeRepository(repo: string): string {
  const hubless = repo.replace(/^(?:index\.)?docker\.io\//, '');
  return hubless.startsWith('library/') ? hubless.slice('library/'.length) : hubless;
}

/** `repo` of `repo[:tag][@digest]`; a port in the registry host is not a tag. */
function imageRepository(reference: string): string {
  const withoutDigest = reference.split('@')[0] ?? reference;
  const lastSlash = withoutDigest.lastIndexOf('/');
  const colon = withoutDigest.lastIndexOf(':');
  return normalizeRepository(colon > lastSlash ? withoutDigest.slice(0, colon) : withoutDigest);
}

/** The image's RepoDigest for the container's own repository; null for a local build or an image ID. */
export function containerDigest(reference: string, image: Pick<HostImageRecord, 'repoDigests'> | undefined): Digest | null {
  if (image === undefined || reference.startsWith('sha256:')) return null;
  const repo = imageRepository(reference);
  for (const ref of image.repoDigests) {
    const at = ref.lastIndexOf('@');
    if (at < 0 || normalizeRepository(ref.slice(0, at)) !== repo) continue;
    const parsed = Digest.safeParse(ref.slice(at + 1));
    if (parsed.success) return parsed.data;
  }
  return null;
}

function memoryLimit(limit: number | null, hostMemory: number): number | null {
  // With no limit set, Docker reports the host's memory as the limit.
  return limit === null || limit >= hostMemory ? null : limit;
}

export interface InventoryOptions {
  docker: DockerPort;
  /** The agent's data root; its free space is read with statfs on every report. */
  dataRoot: string;
  statfs?: (path: string) => Promise<{ bsize: number; blocks: number; bavail: number }>;
  now?: () => number;
  /** Host memory in bytes, to tell "no limit" from a real one. Default `os.totalmem()`. */
  totalMemoryBytes?: () => number;
  /**
   * Reads the env files a health check's output is redacted against (SHP-REQ-220). Absent: a
   * container whose manifest or stack names env files reports its results with empty output.
   */
  fs?: FsPort;
  log?: ReportLog;
}

/**
 * Builds the collector `buildReport` calls with the manifests it has just loaded. It holds the
 * caches and the previous stats sample of each container across reports. Resolves undefined when
 * the Docker port cannot list the host (a fake without the inventory calls); rejects when the
 * Engine fails, which `buildReport` logs before sending the report without `host`.
 */
export function createInventoryCollector(
  opts: InventoryOptions,
): (manifests: readonly Manifest[], stacks?: readonly StackManifest[]) => Promise<HostInventory | undefined> {
  const { docker, dataRoot } = opts;
  const now = opts.now ?? Date.now;
  const statfs = opts.statfs ?? nodeStatfs;
  const hostMemory = opts.totalMemoryBytes ?? totalmem;

  let df: { value: HostSystemDf; nextAt: number } | undefined;
  let dfInFlight: Promise<void> | undefined;
  let dockerRoot: { value: HostFilesystem | null; nextAt: number } = { value: null, nextAt: 0 };
  const previous = new Map<string, HostStatsSample>();

  const refreshDf = (read: () => Promise<HostSystemDf>): Promise<void> => {
    dfInFlight ??= read()
      .then((value) => {
        df = { value, nextAt: now() + DF_TTL_MS };
      })
      .catch((err: unknown) => {
        // Keep the last good answer; look again soon rather than on every report.
        if (df !== undefined) df.nextAt = now() + FAILURE_RETRY_MS;
        else df = { value: { volumeSizes: {}, builderCache: { bytes: 0, reclaimableBytes: 0 } }, nextAt: now() + FAILURE_RETRY_MS };
        opts.log?.warn({ err: err instanceof Error ? err.message : String(err) }, '/system/df failed; reporting the last volume sizes');
      })
      .finally(() => {
        dfInFlight = undefined;
      });
    return dfInFlight;
  };

  const systemDf = async (read: () => Promise<HostSystemDf>): Promise<HostSystemDf> => {
    if (df === undefined || now() >= df.nextAt) {
      const refreshing = refreshDf(read);
      // The very first read has nothing to fall back on, so it is waited for; a later one that runs
      // long carries on in the background while this report uses the previous answer.
      if (df === undefined) await refreshing;
      else await Promise.race([refreshing, new Promise<void>((resolve) => setTimeout(resolve, DF_WAIT_MS).unref())]);
    }
    return df?.value ?? { volumeSizes: {}, builderCache: { bytes: 0, reclaimableBytes: 0 } };
  };

  const dockerRootSpace = async (read: () => Promise<DockerRootSpace>): Promise<HostFilesystem | null> => {
    if (now() < dockerRoot.nextAt) return dockerRoot.value;
    try {
      const space = await read();
      dockerRoot = { value: { path: space.path, freeBytes: space.freeBytes, totalBytes: space.totalBytes }, nextAt: now() + DOCKER_ROOT_TTL_MS };
    } catch (err) {
      // Null until the first success, the last good value after: a failed read must not blank it.
      dockerRoot = { value: dockerRoot.value, nextAt: now() + FAILURE_RETRY_MS };
      opts.log?.warn({ err: err instanceof Error ? err.message : String(err) }, 'Docker root space read failed');
    }
    return dockerRoot.value;
  };

  /** `/info`, or null when it fails: the report then goes without the host totals. */
  const hostInfo = async (): Promise<HostInfo | null> => {
    const read = docker.hostInfo?.bind(docker);
    if (read === undefined) return null;
    try {
      return await read();
    } catch (err) {
      opts.log?.warn({ err: err instanceof Error ? err.message : String(err) }, '/info failed; reporting without host CPU and memory');
      return null;
    }
  };

  /**
   * The redacted health logs of the containers that carry one (SHP-REQ-220), by ID: the same values
   * as `logs.ts` redacts, the container's Env values and its manifest's or stack's env files. A
   * container whose facts or env files cannot be read gets its results with empty output.
   */
  const redactedHealthLogs = async (
    containers: readonly HostContainerRecord[],
    manifests: readonly Manifest[],
    stacks: readonly StackManifest[],
  ): Promise<Map<string, HealthCheckResult[]>> => {
    const out = new Map<string, HealthCheckResult[]>();
    const envFileValues = new Map<string, Promise<string[]>>();
    for (const c of containers) {
      const raw = c.healthLog ?? [];
      if (raw.length === 0 || (c.health !== 'unhealthy' && c.health !== 'starting')) continue;
      let redact: ((text: string) => string) | null = null;
      let values: readonly string[] = [];
      try {
        const facts = await docker.inspectEnv?.(c.id);
        if (facts !== undefined && facts !== null) {
          const project = facts.composeProject;
          const envFiles =
            project === null ? undefined : (manifests.find((m) => m.compose.project === project)?.envFiles ?? stacks.find((m) => m.compose.project === project)?.envFiles);
          let secrets: string[] = [];
          if (envFiles !== undefined && envFiles.length > 0) {
            const fs = opts.fs;
            if (fs === undefined) throw new Error('no filesystem to read the env files with');
            const key = envFiles.join('\n');
            let loading = envFileValues.get(key);
            if (loading === undefined) {
              loading = loadRedactionValues(fs, envFiles);
              envFileValues.set(key, loading);
            }
            secrets = await loading;
          }
          values = redactionValues(secrets, facts.envValues);
          redact = createRedactor(values);
        }
      } catch (err) {
        // Never the output, never the error's text about a value: only that it could not be redacted.
        opts.log?.warn({ container: c.name, err: err instanceof Error ? err.message : String(err) }, 'health check output could not be redacted; reporting it empty');
        redact = null;
      }
      const apply = redact;
      out.set(
        c.id,
        raw.slice(-5).map((r) => ({
          start: r.start,
          end: r.end,
          exitCode: r.exitCode,
          output:
            apply === null
              ? ''
              : apply(Buffer.byteLength(r.output) >= DOCKER_PROBE_OUTPUT_MAX_BYTES ? dropPartialSecret(r.output, values) : r.output).slice(0, HEALTH_OUTPUT_MAX_CHARS),
        })),
      );
    }
    return out;
  };

  const dataRootSpace = async (): Promise<HostFilesystem> => {
    const s = await statfs(dataRoot);
    return { path: dataRoot, freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  };

  /** A failed stats read for one container leaves that container without stats; it never fails the inventory. */
  const sampleStats = async (running: HostContainerRecord[]): Promise<Map<string, ContainerStats | null>> => {
    const out = new Map<string, ContainerStats | null>();
    const read = docker.containerStats?.bind(docker);
    if (read === undefined) return out;
    const total = hostMemory();
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < running.length) {
        const c = running[next++];
        if (c === undefined) return;
        try {
          const sample = await read(c.id);
          const before = previous.get(c.id);
          if (sample === null) {
            out.set(c.id, null);
            continue;
          }
          previous.set(c.id, sample);
          // The first sample of a container has nothing to measure CPU against; memory alone would
          // sit beside a misleading 0%, so it reports no stats at all.
          const cpu = before === undefined ? null : cpuPercent(before, sample);
          out.set(c.id, cpu === null ? null : { cpuPercent: cpu, memoryBytes: Math.round(sample.memoryBytes), memoryLimitBytes: memoryLimit(sample.memoryLimitBytes, total) });
        } catch (err) {
          out.set(c.id, null);
          opts.log?.warn({ container: c.name, err: err instanceof Error ? err.message : String(err) }, 'container stats failed');
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(STATS_CONCURRENCY, running.length) }, worker));
    return out;
  };

  return async (manifests, stacks = []) => {
    const readContainers = docker.hostContainers?.bind(docker);
    const readVolumes = docker.hostVolumes?.bind(docker);
    const readDf = docker.systemDf?.bind(docker);
    const readImages = docker.hostImages?.bind(docker);
    const readNetworks = docker.hostNetworks?.bind(docker);
    if (readContainers === undefined || readVolumes === undefined || readDf === undefined || readImages === undefined || readNetworks === undefined) {
      return undefined;
    }

    const containers = await readContainers();
    const [volumes, images, networks, dfResult, dataDisk, info, healthLogs] = await Promise.all([
      readVolumes(),
      readImages(),
      readNetworks(),
      systemDf(readDf),
      dataRootSpace(),
      hostInfo(),
      redactedHealthLogs(containers, manifests, stacks),
    ]);
    const readRoot = docker.dockerRootSpace?.bind(docker);
    const dockerRootDisk = readRoot === undefined ? null : await dockerRootSpace(readRoot);

    const stats = await sampleStats(containers.filter((c) => c.state === 'running'));
    // Forget containers that are gone, so the map does not grow with every recreate.
    const ids = new Set(containers.map((c) => c.id));
    for (const id of previous.keys()) if (!ids.has(id)) previous.delete(id);

    const imageById = new Map(images.map((i) => [i.id, i]));
    const mountedBy = new Map<string, Set<string>>();
    const imageUsers = new Map<string, number>();
    const networkMembers = new Map<string, number>();
    for (const c of containers) {
      for (const m of c.mounts) {
        if (m.type !== 'volume' || m.volume === null) continue;
        const names = mountedBy.get(m.volume) ?? new Set<string>();
        names.add(c.name);
        mountedBy.set(m.volume, names);
      }
      imageUsers.set(c.imageId, (imageUsers.get(c.imageId) ?? 0) + 1);
      for (const id of new Set(c.networkIds)) networkMembers.set(id, (networkMembers.get(id) ?? 0) + 1);
    }

    const inventory: HostInventory = {
      sampledAt: new Date(now()).toISOString(),
      containers: containers
        .map((c) => hostContainer(c, imageById.get(c.imageId), manifests, stacks, stats.get(c.id) ?? null, healthLogs.get(c.id) ?? []))
        .filter((c): c is HostContainer => c !== null)
        .sort((a, b) => a.name.localeCompare(b.name)),
      volumes: volumes
        .map((v) => hostVolume(v, dfResult, mountedBy.get(v.name)))
        .sort((a, b) => a.name.localeCompare(b.name)),
      images: images
        .map((i) => ({
          id: i.id,
          repoTags: i.repoTags.slice(0, 100),
          repoDigests: i.repoDigests.slice(0, 100),
          sizeBytes: Math.round(i.sizeBytes),
          createdAt: i.createdAt,
          containers: imageUsers.get(i.id) ?? 0,
          dangling: i.repoTags.length === 0,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      networks: networks.map((n) => hostNetwork(n, networkMembers.get(n.id) ?? 0)).sort((a, b) => a.name.localeCompare(b.name)),
      builderCache: dfResult.builderCache,
      disk: { dataRoot: dataDisk, dockerRoot: dockerRootDisk },
      ...(info === null ? {} : { cpuCores: info.cpuCores, memoryBytes: info.memoryBytes }),
    };

    // The report is the agent's heartbeat. An inventory the server's schema would refuse (say, a
    // name that is too long) would fail the whole report with it, so it is dropped here and logged.
    const checked = HostInventory.safeParse(inventory);
    if (!checked.success) {
      opts.log?.warn({ issues: checked.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`) }, 'host inventory failed validation; reporting without it');
      return undefined;
    }
    return checked.data;
  };
}

function hostContainer(
  c: HostContainerRecord,
  image: HostImageRecord | undefined,
  manifests: readonly Manifest[],
  stacks: readonly StackManifest[],
  stats: ContainerStats | null,
  healthLog: HealthCheckResult[],
): HostContainer | null {
  if (!STATES.has(c.state)) return null;
  const { tier, app } = deriveTier(c.compose?.project ?? null, manifests, stacks);
  // Docker's empty policy name is `no`; a name this schema does not know is left out, not guessed.
  const policy = RestartPolicy.safeParse(c.restartPolicy === '' ? 'no' : c.restartPolicy);
  return {
    id: c.id,
    name: c.name,
    image: c.image.slice(0, 500),
    imageId: c.imageId,
    digest: containerDigest(c.image, image),
    state: c.state as HostContainer['state'],
    health: c.health,
    restartCount: c.restartCount,
    createdAt: c.createdAt,
    startedAt: c.startedAt,
    compose: c.compose,
    tier,
    app,
    ports: c.ports
      .filter((p) => PORT_PROTOCOLS.has(p.protocol))
      .slice(0, 200)
      .map((p) => ({ privatePort: p.privatePort, publicPort: p.publicPort, protocol: p.protocol as 'tcp' | 'udp' | 'sctp', ip: p.ip })),
    mounts: c.mounts
      .filter((m) => MOUNT_TYPES.has(m.type))
      .slice(0, 200)
      .map((m) => ({ type: m.type as 'volume' | 'bind' | 'tmpfs' | 'npipe' | 'cluster' | 'image', volume: m.volume, source: m.source, destination: m.destination, readOnly: m.readOnly })),
    stats: c.state === 'running' ? stats : null,
    healthLog: c.health === 'unhealthy' || c.health === 'starting' ? healthLog : [],
    ...(c.exitCode === undefined ? {} : { exitCode: c.exitCode }),
    ...(c.oomKilled === undefined ? {} : { oomKilled: c.oomKilled }),
    ...(policy.success ? { restartPolicy: policy.data } : {}),
  };
}

function hostVolume(v: HostVolumeRecord, df: HostSystemDf, mounted: Set<string> | undefined) {
  const names = [...(mounted ?? [])].sort().slice(0, 500);
  return {
    name: v.name,
    driver: v.driver,
    sizeBytes: df.volumeSizes[v.name] ?? null,
    mountedBy: names,
    composeProject: v.composeProject,
    orphan: names.length === 0,
    createdAt: v.createdAt,
  };
}

function hostNetwork(n: HostNetworkRecord, containers: number) {
  return { id: n.id, name: n.name, driver: n.driver, scope: n.scope, internal: n.internal, containers, composeProject: n.composeProject };
}
