import { z } from 'zod';

import { LogLine } from './actions.js';
import { Refusal } from './errors.js';
import { ContainerHealth, ContainerState, ContainerTier, HostDisk } from './host.js';
import { AppName, Digest, Sha40 } from './primitives.js';

/**
 * Overview and the incident bundle (SHP-ADR-013, SHP-P-19): state first, then what is wrong.
 *
 * `GET /api/overview` answers what runs on the host, what is happening now, the last 24 hours, a
 * health tile per Deployed app, a chip per other compose project, and one incident banner per
 * Deployed or Operated app with a failing container. Needs you is not here: the console derives it
 * from the same shared store it always has (SHP-ADR-006), so the list and its badge cannot disagree.
 *
 * The incident bundle is one container's case for a person or for Claude: the facts Shipyard can
 * state from fixed rules, its redacted logs since the first error, its inspect state (never its
 * environment), and its owner's last change. It is built on request and never stored (SHP-REQ-215);
 * `renderIncidentBundle` is the one text form, so Copy for Claude and `shipyard_incident` match.
 */

const ContainerId = z.string().regex(/^[0-9a-f]{64}$/, '64 lowercase hex characters');
const Bytes = z.int().min(0);
const Count = z.int().min(0);
const Instant = z.iso.datetime({ offset: true });

/** Why a container is failing. SHP-P-20 adds `restart-loop` once the server keeps events. */
export const IncidentCondition = z
  .enum(['unhealthy', 'restarting'])
  .meta({ id: 'IncidentCondition', description: 'Why a container is failing: its healthcheck, or Docker restarting it' });
export type IncidentCondition = z.infer<typeof IncidentCondition>;

/**
 * The newest change to an app or stack: a deploy of a Deployed app or an update of an Operated
 * stack. `sha` is set for a deploy; `digest` names the first service's new digest for an update.
 */
export const LastChange = z
  .strictObject({
    kind: z.enum(['deploy', 'stack-update']),
    id: z.uuid(),
    /** When it finished, or when it was requested while it has not. */
    at: Instant,
    /** The deploy's or update's state as its own status endpoint names it. */
    state: z.string().min(1).max(40),
    sha: Sha40.nullable(),
    digest: Digest.nullable(),
  })
  .meta({ id: 'LastChange', description: "An app's last deploy or a stack's last update" });
export type LastChange = z.infer<typeof LastChange>;

export const IncidentContainer = z
  .strictObject({
    id: ContainerId,
    name: z.string().min(1).max(255),
    condition: IncidentCondition,
    state: ContainerState,
    health: ContainerHealth,
    restartCount: Count,
    /** The first report the server received in which it was failing, by the server's clock. */
    failingSince: Instant,
  })
  .meta({ id: 'IncidentContainer', description: 'One failing container in an incident banner' });
export type IncidentContainer = z.infer<typeof IncidentContainer>;

/** One per Deployed app or Operated stack with a failing container (SHP-REQ-209); never Observed. */
export const IncidentBanner = z
  .strictObject({
    owner: z.strictObject({ kind: z.enum(['app', 'stack']), name: AppName }),
    tier: z.enum(['shipped', 'operated']),
    /** Oldest failure first. */
    containers: z.array(IncidentContainer).min(1).max(200),
    /** The earliest `failingSince` among them. */
    since: Instant,
    lastChange: LastChange.nullable(),
  })
  .meta({ id: 'IncidentBanner', description: 'An app or stack with a failing container' });
export type IncidentBanner = z.infer<typeof IncidentBanner>;

/** Something in flight now, or something that ended in the last 24 hours. */
export const OverviewWork = z
  .strictObject({
    kind: z.enum(['deploy', 'stack-update', 'action', 'maintenance', 'build']),
    id: z.uuid(),
    /** The app, stack, volume or container it is about; null for a host-wide prune. */
    subject: z.string().min(1).max(255).nullable(),
    /** What it does: a lifecycle verb, a maintenance kind, a short SHA. */
    label: z.string().min(1).max(100),
    state: z.string().min(1).max(40),
    /** When it started for work in flight; when it ended for the last 24 hours. */
    at: Instant,
  })
  .meta({ id: 'OverviewWork', description: 'A deploy, update, action, maintenance job or build' });
export type OverviewWork = z.infer<typeof OverviewWork>;

/** A Deployed app's tile. `health` is the worst of its containers; `stopped` when none runs. */
export const AppTile = z
  .strictObject({
    name: AppName,
    health: z.enum(['healthy', 'unhealthy', 'starting', 'stopped', 'unknown']),
    containers: Count,
    running: Count,
    failing: Count,
    /** The sum over its running containers' latest samples; null when none reported stats. */
    cpuPercent: z.number().min(0).nullable(),
    memoryBytes: Bytes.nullable(),
    lastChange: LastChange.nullable(),
  })
  .meta({ id: 'AppTile', description: "A Deployed app's health tile on Overview" });
export type AppTile = z.infer<typeof AppTile>;

/** Every compose project that is not a Deployed app, Operated or Observed. */
export const ProjectChip = z
  .strictObject({
    project: z.string().min(1).max(255),
    tier: z.enum(['operated', 'observed']),
    containers: Count,
    running: Count,
    /** Unhealthy or restarting; an Observed project's failures are shown, never a banner. */
    failing: Count,
  })
  .meta({ id: 'ProjectChip', description: 'A compose project chip on Overview' });
export type ProjectChip = z.infer<typeof ProjectChip>;

export const OverviewRuns = z
  .strictObject({
    deployedApps: Count,
    operatedStacks: Count,
    observedProjects: Count,
    containers: Count,
    running: Count,
    failing: Count,
    /** Summed over every running container's latest sample (100 = one core); null with no samples. */
    cpuPercent: z.number().min(0).nullable(),
    memoryBytes: Bytes.nullable(),
    /** Null until an agent has reported an inventory. */
    disk: HostDisk.nullable(),
  })
  .meta({ id: 'OverviewRuns', description: 'What runs on the host, in totals' });
export type OverviewRuns = z.infer<typeof OverviewRuns>;

export const OverviewLast24h = z
  .strictObject({
    deploys: z.strictObject({ succeeded: Count, failed: Count, rolledBack: Count }),
    stackUpdates: z.strictObject({ succeeded: Count, failed: Count }),
    actions: Count,
    backups: z.strictObject({ succeeded: Count, failed: Count }),
    /** Newest first, at most 20. */
    recent: z.array(OverviewWork).max(20),
  })
  .meta({ id: 'OverviewLast24h', description: 'What ended in the last 24 hours' });
export type OverviewLast24h = z.infer<typeof OverviewLast24h>;

/** `GET /api/overview` (SHP-REQ-207, SHP-REQ-209). */
export const Overview = z
  .strictObject({
    generatedAt: Instant,
    /** The newest report among the agents; null before any. */
    hostReportedAt: Instant.nullable(),
    runs: OverviewRuns,
    /** Oldest first. */
    now: z.array(OverviewWork).max(100),
    last24h: OverviewLast24h,
    /** Alphabetical. */
    apps: z.array(AppTile).max(500),
    /** Alphabetical. */
    projects: z.array(ProjectChip).max(500),
    /** Oldest incident first. */
    incidents: z.array(IncidentBanner).max(500),
  })
  .meta({ id: 'Overview', description: 'The Overview destination: state first, then incidents' });
export type Overview = z.infer<typeof Overview>;

/** A fact Shipyard can state from a fixed rule (SHP-REQ-216). Never a model's guess. */
export const IncidentFact = z
  .strictObject({
    kind: z.enum(['failing', 'restarts', 'log-error', 'memory', 'last-change', 'state']),
    /** When it happened; null for a standing fact such as memory against its limit. */
    at: Instant.nullable(),
    text: z.string().min(1).max(500),
  })
  .meta({ id: 'IncidentFact', description: 'One rule-based fact about an incident' });
export type IncidentFact = z.infer<typeof IncidentFact>;

/** What Docker says about the container, from the latest report. Never its environment. */
export const IncidentInspect = z
  .strictObject({
    image: z.string().min(1).max(500),
    digest: Digest.nullable(),
    state: ContainerState,
    health: ContainerHealth,
    restartCount: Count,
    createdAt: Instant,
    startedAt: Instant.nullable(),
    memoryBytes: Bytes.nullable(),
    memoryLimitBytes: Bytes.nullable(),
    cpuPercent: z.number().min(0).nullable(),
  })
  .meta({ id: 'IncidentInspect', description: "A container's state as the agent last reported it" });
export type IncidentInspect = z.infer<typeof IncidentInspect>;

/**
 * Logs since the first error line in the last 2000, or the last 200 lines when none looks like an
 * error. `unavailable` carries the refusal when the logs could not be read (the agent is offline,
 * or the reader may not read logs); the rest of the bundle still stands.
 */
export const IncidentLogs = z
  .strictObject({
    from: z.enum(['first-error', 'tail']),
    lines: z.array(LogLine).max(2000),
    unavailable: Refusal.nullable(),
  })
  .meta({ id: 'IncidentLogs', description: "A container's redacted logs for an incident" });
export type IncidentLogs = z.infer<typeof IncidentLogs>;

/** `GET /api/containers/:id/incident` and `shipyard_incident` (SHP-REQ-212, SHP-REQ-213). */
export const IncidentBundle = z
  .strictObject({
    builtAt: Instant,
    container: z.strictObject({
      id: ContainerId,
      name: z.string().min(1).max(255),
      tier: ContainerTier,
      /** The app or stack it belongs to; null when Observed. */
      owner: AppName.nullable(),
      compose: z.strictObject({ project: z.string().min(1).max(255), service: z.string().min(1).max(255) }).nullable(),
    }),
    /** Null when it is not failing now. */
    condition: IncidentCondition.nullable(),
    failingSince: Instant.nullable(),
    /** In time order, undated facts last. */
    facts: z.array(IncidentFact).max(100),
    inspect: IncidentInspect,
    logs: IncidentLogs,
    lastChange: LastChange.nullable(),
  })
  .meta({ id: 'IncidentBundle', description: "One container's incident, for a person or for Claude" });
export type IncidentBundle = z.infer<typeof IncidentBundle>;
