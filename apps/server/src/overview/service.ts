import {
  ACTIVE_STATES,
  HostInventory,
  Overview,
  type AppTile,
  type HostContainer,
  type HostDisk,
  type IncidentBanner,
  type IncidentContainer,
  type LastChange,
  type OverviewWork,
  type ProjectChip,
} from '@shipyard/schema';
import type { Db } from '../db.js';
import { readContainerConditions, readRestartLoops, restartLoopKey, type ContainerConditionRow, type RestartLoop } from '../host/index.js';
import { lastChangeOf } from '../incident/service.js';

/**
 * Overview, assembled (SHP-ADR-013, SHP-REQ-207, SHP-REQ-209): what runs on the host, what is
 * happening now, what ended in the last 24 hours, a tile per Deployed app, a chip per other compose
 * project and one incident banner per Deployed or Operated app with a failing container.
 *
 * Reads only. The host half comes from each agent's latest stored snapshot, from
 * `container_condition` (kept by the agent's report) and from restart loops computed from
 * `container_event` (SHP-REQ-227); the work half from the ledger tables. Needs
 * you is not here: the console derives it from the shared store it already has (SHP-REQ-208).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_LIMIT = 100;
const RECENT_LIMIT = 20;

/** Deploy-target states that are in flight: the agent's active set, plus waiting to start. */
const DEPLOY_IN_FLIGHT = ['queued', 'awaiting_approval', ...ACTIVE_STATES] as const;
const STACK_UPDATE_IN_FLIGHT = ['queued', 'awaiting_approval', 'dispatched', 'running'] as const;
const ACTION_IN_FLIGHT = ['queued', 'dispatched', 'running'] as const;
const MAINTENANCE_IN_FLIGHT = ['queued', 'dispatched', 'running'] as const;
const BUILD_IN_FLIGHT = ['queued', 'running'] as const;

/** The maintenance kind whose outcome the 24-hour backups count reports. */
const BACKUP_KIND = 'volume-backup';

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sha7 = (sha: string): string => sha.slice(0, 7);
const key = (agentId: string, containerName: string): string => `${agentId}\u0000${containerName}`;

interface Reported {
  agentId: string;
  container: HostContainer;
}

interface Usage {
  cpuPercent: number | null;
  memoryBytes: number | null;
}

/** CPU and memory summed over the running containers that reported stats; null when none did. */
function usageOf(containers: readonly HostContainer[]): Usage {
  let cpu: number | null = null;
  let memory: number | null = null;
  for (const c of containers) {
    if (c.state !== 'running' || c.stats === null) continue;
    cpu = (cpu ?? 0) + c.stats.cpuPercent;
    memory = (memory ?? 0) + c.stats.memoryBytes;
  }
  return { cpuPercent: cpu, memoryBytes: memory };
}

function newestFirst(a: OverviewWork, b: OverviewWork): number {
  return byCodePoint(b.at, a.at) || byCodePoint(a.id, b.id);
}

function oldestFirst(a: OverviewWork, b: OverviewWork): number {
  return byCodePoint(a.at, b.at) || byCodePoint(a.id, b.id);
}

/** Every agent's latest inventory, parsed; one that no longer validates is left out, as `GET /api/host` does. */
async function readSnapshots(db: Db): Promise<{ reported: Reported[]; reportedAt: Date | null; disk: HostDisk | null }> {
  const rows = await db.hostSnapshot.findMany({
    orderBy: { reportedAt: 'asc' },
    select: { agentId: true, inventory: true, reportedAt: true },
  });
  const reported: Reported[] = [];
  let reportedAt: Date | null = null;
  let disk: HostDisk | null = null;
  for (const row of rows) {
    const parsed = HostInventory.safeParse(row.inventory);
    if (!parsed.success) continue;
    for (const container of parsed.data.containers) reported.push({ agentId: row.agentId, container });
    // Ascending by report time, so the last one that validates is the newest.
    reportedAt = row.reportedAt;
    disk = parsed.data.disk;
  }
  return { reported, reportedAt, disk };
}

async function readInFlight(db: Db): Promise<OverviewWork[]> {
  const [deploys, updates, actions, jobs, builds] = await Promise.all([
    db.deployTarget.findMany({
      where: { state: { in: [...DEPLOY_IN_FLIGHT] }, deploy: { dryRun: false } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: NOW_LIMIT,
      select: { state: true, startedAt: true, createdAt: true, app: { select: { name: true } }, deploy: { select: { id: true, requestedSha: true } } },
    }),
    db.stackUpdate.findMany({
      where: { state: { in: [...STACK_UPDATE_IN_FLIGHT] } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: NOW_LIMIT,
      select: { id: true, stackName: true, kind: true, state: true, startedAt: true, createdAt: true },
    }),
    db.action.findMany({
      where: { state: { in: [...ACTION_IN_FLIGHT] } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: NOW_LIMIT,
      select: { id: true, targetName: true, verb: true, state: true, startedAt: true, createdAt: true },
    }),
    db.maintenanceJob.findMany({
      where: { state: { in: [...MAINTENANCE_IN_FLIGHT] } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: NOW_LIMIT,
      select: { id: true, kind: true, state: true, volume: true, ownerName: true, startedAt: true, createdAt: true },
    }),
    db.build.findMany({
      where: { state: { in: [...BUILD_IN_FLIGHT] } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: NOW_LIMIT,
      select: { id: true, sha: true, state: true, startedAt: true, createdAt: true, app: { select: { name: true } } },
    }),
  ]);
  const work: OverviewWork[] = [
    ...deploys.map((t): OverviewWork => ({
      kind: 'deploy',
      id: t.deploy.id,
      subject: t.app.name,
      label: sha7(t.deploy.requestedSha),
      state: t.state,
      at: (t.startedAt ?? t.createdAt).toISOString(),
    })),
    ...updates.map((u): OverviewWork => ({
      kind: 'stack-update',
      id: u.id,
      subject: u.stackName,
      label: u.kind,
      state: u.state,
      at: (u.startedAt ?? u.createdAt).toISOString(),
    })),
    ...actions.map((a): OverviewWork => ({
      kind: 'action',
      id: a.id,
      subject: a.targetName,
      label: a.verb,
      state: a.state,
      at: (a.startedAt ?? a.createdAt).toISOString(),
    })),
    ...jobs.map((j): OverviewWork => ({
      kind: 'maintenance',
      id: j.id,
      subject: j.volume ?? j.ownerName ?? null,
      label: j.kind,
      state: j.state,
      at: (j.startedAt ?? j.createdAt).toISOString(),
    })),
    ...builds.map((b): OverviewWork => ({
      kind: 'build',
      id: b.id,
      subject: b.app.name,
      label: sha7(b.sha),
      state: b.state,
      at: (b.startedAt ?? b.createdAt).toISOString(),
    })),
  ];
  return work.sort(oldestFirst).slice(0, NOW_LIMIT);
}

async function readLast24h(db: Db, since: Date): Promise<Overview['last24h']> {
  const deployWhere = (state: 'succeeded' | 'failed' | 'rolled_back') => ({ state, endedAt: { gte: since }, deploy: { dryRun: false } });
  const [succeeded, failed, rolledBack, updatesDone, updatesFailed, actionsEnded, backupsDone, backupsFailed] = await Promise.all([
    db.deployTarget.count({ where: deployWhere('succeeded') }),
    db.deployTarget.count({ where: deployWhere('failed') }),
    db.deployTarget.count({ where: deployWhere('rolled_back') }),
    db.stackUpdate.count({ where: { state: 'succeeded', endedAt: { gte: since } } }),
    db.stackUpdate.count({ where: { state: { in: ['failed', 'rolled_back'] }, endedAt: { gte: since } } }),
    db.action.count({ where: { endedAt: { gte: since } } }),
    db.maintenanceJob.count({ where: { kind: BACKUP_KIND, state: 'succeeded', finishedAt: { gte: since } } }),
    db.maintenanceJob.count({ where: { kind: BACKUP_KIND, state: 'failed', finishedAt: { gte: since } } }),
  ]);

  const [deploys, updates, actions, backups] = await Promise.all([
    db.deployTarget.findMany({
      where: { state: { in: ['succeeded', 'failed', 'rolled_back'] }, endedAt: { gte: since }, deploy: { dryRun: false } },
      orderBy: [{ endedAt: 'desc' }, { id: 'desc' }],
      take: RECENT_LIMIT,
      select: { state: true, endedAt: true, app: { select: { name: true } }, deploy: { select: { id: true, requestedSha: true } } },
    }),
    db.stackUpdate.findMany({
      where: { state: { in: ['succeeded', 'failed', 'rolled_back'] }, endedAt: { gte: since } },
      orderBy: [{ endedAt: 'desc' }, { id: 'desc' }],
      take: RECENT_LIMIT,
      select: { id: true, stackName: true, kind: true, state: true, endedAt: true },
    }),
    db.action.findMany({
      where: { endedAt: { gte: since } },
      orderBy: [{ endedAt: 'desc' }, { id: 'desc' }],
      take: RECENT_LIMIT,
      select: { id: true, targetName: true, verb: true, state: true, endedAt: true },
    }),
    db.maintenanceJob.findMany({
      where: { kind: BACKUP_KIND, state: { in: ['succeeded', 'failed'] }, finishedAt: { gte: since } },
      orderBy: [{ finishedAt: 'desc' }, { id: 'desc' }],
      take: RECENT_LIMIT,
      select: { id: true, kind: true, state: true, volume: true, ownerName: true, finishedAt: true },
    }),
  ]);

  const recent: OverviewWork[] = [
    ...deploys.flatMap((t): OverviewWork[] =>
      t.endedAt === null
        ? []
        : [{ kind: 'deploy', id: t.deploy.id, subject: t.app.name, label: sha7(t.deploy.requestedSha), state: t.state, at: t.endedAt.toISOString() }],
    ),
    ...updates.flatMap((u): OverviewWork[] =>
      u.endedAt === null ? [] : [{ kind: 'stack-update', id: u.id, subject: u.stackName, label: u.kind, state: u.state, at: u.endedAt.toISOString() }],
    ),
    ...actions.flatMap((a): OverviewWork[] =>
      a.endedAt === null ? [] : [{ kind: 'action', id: a.id, subject: a.targetName, label: a.verb, state: a.state, at: a.endedAt.toISOString() }],
    ),
    ...backups.flatMap((j): OverviewWork[] =>
      j.finishedAt === null
        ? []
        : [{ kind: 'maintenance', id: j.id, subject: j.volume ?? j.ownerName ?? null, label: j.kind, state: j.state, at: j.finishedAt.toISOString() }],
    ),
  ];

  return {
    deploys: { succeeded, failed, rolledBack },
    stackUpdates: { succeeded: updatesDone, failed: updatesFailed },
    actions: actionsEnded,
    backups: { succeeded: backupsDone, failed: backupsFailed },
    recent: recent.sort(newestFirst).slice(0, RECENT_LIMIT),
  };
}

/** One chip per compose project that is not a Deployed app's: Operated, or Observed when none of its containers is. */
function projectChips(reported: readonly Reported[], failing: ReadonlySet<string>): ProjectChip[] {
  const byProject = new Map<string, Reported[]>();
  for (const r of reported) {
    const project = r.container.compose?.project;
    if (project === undefined) continue;
    let list = byProject.get(project);
    if (list === undefined) {
      list = [];
      byProject.set(project, list);
    }
    list.push(r);
  }
  const chips: ProjectChip[] = [];
  for (const [project, members] of byProject) {
    if (members.some((m) => m.container.tier === 'shipped')) continue;
    chips.push({
      project,
      tier: members.some((m) => m.container.tier === 'operated') ? 'operated' : 'observed',
      containers: members.length,
      running: members.filter((m) => m.container.state === 'running').length,
      failing: members.filter((m) => failing.has(key(m.agentId, m.container.name))).length,
    });
  }
  return chips.sort((a, b) => byCodePoint(a.project, b.project));
}

/**
 * Every failing container, oldest first: its stored condition, unless a restart loop outranks it
 * (SHP-REQ-227). Loops are read only for Deployed and Operated containers — an Observed one has no
 * banner — over the last 30 minutes of their events.
 */
async function failingConditions(db: Db, reported: readonly Reported[], conditions: readonly ContainerConditionRow[], now: Date): Promise<ContainerConditionRow[]> {
  const owned = reported.filter((r) => r.container.tier === 'shipped' || r.container.tier === 'operated');
  const loops: Map<string, RestartLoop> = await readRestartLoops(
    db,
    owned.map((r) => ({ agentId: r.agentId, containerName: r.container.name })),
    now,
  );
  const merged = new Map<string, ContainerConditionRow>();
  for (const row of conditions) merged.set(key(row.agentId, row.containerName), row);
  for (const r of owned) {
    const loop = loops.get(restartLoopKey(r.agentId, r.container.name));
    if (loop === undefined) continue;
    merged.set(key(r.agentId, r.container.name), { agentId: r.agentId, containerName: r.container.name, condition: 'restart-loop', since: loop.since });
  }
  return [...merged.values()].sort((a, b) => a.since.getTime() - b.since.getTime() || byCodePoint(a.containerName, b.containerName));
}

/** One banner per Deployed app or Operated stack with a failing container; an Observed one has none. */
async function incidentBanners(db: Db, reported: readonly Reported[], conditions: readonly ContainerConditionRow[]): Promise<IncidentBanner[]> {
  const containers = new Map<string, HostContainer>();
  for (const r of reported) containers.set(key(r.agentId, r.container.name), r.container);

  interface Group {
    owner: { kind: 'app' | 'stack'; name: string };
    tier: 'shipped' | 'operated';
    containers: IncidentContainer[];
  }
  const groups = new Map<string, Group>();
  // Conditions arrive oldest first, so groups and their containers are created in that order.
  for (const row of conditions) {
    const container = containers.get(key(row.agentId, row.containerName));
    if (container === undefined || container.app === null) continue;
    if (container.tier !== 'shipped' && container.tier !== 'operated') continue;
    const kind = container.tier === 'shipped' ? 'app' : 'stack';
    const groupKey = `${kind}:${container.app}`;
    let group = groups.get(groupKey);
    if (group === undefined) {
      group = { owner: { kind, name: container.app }, tier: container.tier, containers: [] };
      groups.set(groupKey, group);
    }
    group.containers.push({
      id: container.id,
      name: container.name,
      condition: row.condition,
      state: container.state,
      health: container.health,
      restartCount: container.restartCount,
      failingSince: row.since.toISOString(),
    });
  }

  const banners: IncidentBanner[] = [];
  for (const group of groups.values()) {
    const first = group.containers[0];
    if (first === undefined) continue;
    let lastChange: LastChange | null;
    if (group.owner.kind === 'app') {
      lastChange = await lastChangeOf(db, { tier: 'shipped', app: group.owner.name });
    } else {
      lastChange = await lastChangeOf(db, { tier: 'operated', app: group.owner.name });
    }
    banners.push({ owner: group.owner, tier: group.tier, containers: group.containers, since: first.failingSince, lastChange });
  }
  return banners;
}

/** `GET /api/overview`'s body. Reads only; `now` is a parameter so tests can fix the clock. */
export async function buildOverview(db: Db, now: Date = new Date()): Promise<Overview> {
  const since = new Date(now.getTime() - DAY_MS);
  const [snapshots, stored, apps, stackCount, inFlight, last24h] = await Promise.all([
    readSnapshots(db),
    readContainerConditions(db),
    db.app.findMany({ where: { retiredAt: null }, select: { id: true, name: true } }),
    db.stack.count({ where: { retiredAt: null } }),
    readInFlight(db),
    readLast24h(db, since),
  ]);
  const { reported } = snapshots;
  const conditions = await failingConditions(db, reported, stored, now);
  const failing = new Set(conditions.map((c) => key(c.agentId, c.containerName)));
  const isFailing = (r: Reported): boolean => failing.has(key(r.agentId, r.container.name));

  const projects = projectChips(reported, failing);
  const total = usageOf(reported.map((r) => r.container));
  const observedProjects = new Set<string>();
  const byProject = new Map<string, boolean>();
  for (const r of reported) {
    const project = r.container.compose?.project;
    if (project === undefined) continue;
    byProject.set(project, (byProject.get(project) ?? true) && r.container.tier === 'observed');
  }
  for (const [project, allObserved] of byProject) if (allObserved) observedProjects.add(project);

  const tiles: AppTile[] = [];
  for (const app of [...apps].sort((a, b) => byCodePoint(a.name, b.name))) {
    const members = reported.filter((r) => r.container.tier === 'shipped' && r.container.app === app.name);
    const list = members.map((m) => m.container);
    const running = list.filter((c) => c.state === 'running').length;
    const failingCount = members.filter(isFailing).length;
    const health: AppTile['health'] =
      list.length === 0
        ? 'unknown'
        : failingCount > 0
          ? 'unhealthy'
          : list.some((c) => c.health === 'starting')
            ? 'starting'
            : running === 0
              ? 'stopped'
              : 'healthy';
    tiles.push({
      name: app.name,
      health,
      containers: list.length,
      running,
      failing: failingCount,
      ...usageOf(list),
      lastChange: await lastChangeOf(db, { tier: 'shipped', app: app.name }),
    });
  }

  const banners = await incidentBanners(db, reported, conditions);

  return Overview.parse({
    generatedAt: now.toISOString(),
    hostReportedAt: snapshots.reportedAt?.toISOString() ?? null,
    runs: {
      deployedApps: apps.length,
      operatedStacks: stackCount,
      observedProjects: observedProjects.size,
      containers: reported.length,
      running: reported.filter((r) => r.container.state === 'running').length,
      failing: reported.filter(isFailing).length,
      ...total,
      disk: snapshots.disk,
    },
    now: inFlight,
    last24h,
    apps: tiles,
    projects,
    incidents: banners,
  });
}
