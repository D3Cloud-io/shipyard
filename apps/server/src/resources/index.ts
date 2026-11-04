import { Router } from 'express';
import { HostInventory, ResourcesResponse, refusal, type HostResources } from '@shipyard/schema';
import type { Db } from '../db.js';
import type { ServiceDeps } from '../deps.js';
import { sendRefusal } from '../errors.js';
import { HOST_SAMPLE_WINDOW_MS } from '../host/index.js';
import { computeHostResources, type CpuSample } from './service.js';

/**
 * Host › Resources (SHP-ADR-013, SHP-REQ-225, SHP-REQ-226): each reporting host's container CPU and
 * memory against its cores and memory, the heaviest containers, those near a memory limit, and
 * spikes. Computed on read from `host_snapshot` and `host_sample`; writes nothing.
 */

/** Every reporting agent's Resources, oldest report first. A stored inventory that no longer validates is skipped. */
export async function readResources(deps: Pick<ServiceDeps, 'db' | 'logger'>, now: Date = new Date()): Promise<ResourcesResponse> {
  const { db, logger } = deps;
  const rows = await db.hostSnapshot.findMany({ orderBy: { reportedAt: 'asc' }, select: { agentId: true, inventory: true } });
  const hosts: HostResources[] = [];
  const since = new Date(now.getTime() - HOST_SAMPLE_WINDOW_MS);
  for (const row of rows) {
    const parsed = HostInventory.safeParse(row.inventory);
    if (!parsed.success) {
      logger.warn({ agentId: row.agentId, issues: parsed.error.issues.length }, 'stored host snapshot no longer validates; left out of resources');
      continue;
    }
    hosts.push(computeHostResources(row.agentId, parsed.data, await readSamples(db, row.agentId, since)));
  }
  return ResourcesResponse.parse({ hosts });
}

/** One agent's CPU samples within the window, grouped by container, in one query. */
async function readSamples(db: Db, agentId: string, since: Date): Promise<Map<string, CpuSample[]>> {
  const rows = await db.hostSample.findMany({
    where: { agentId, at: { gte: since } },
    orderBy: [{ at: 'asc' }, { id: 'asc' }],
    select: { containerName: true, at: true, cpuPercent: true },
  });
  const byContainer = new Map<string, CpuSample[]>();
  for (const r of rows) {
    const list = byContainer.get(r.containerName) ?? [];
    list.push({ at: r.at, cpuPercent: r.cpuPercent });
    byContainer.set(r.containerName, list);
  }
  return byContainer;
}

/**
 * Mounted at /api/host/resources. GET only: any signed-in user and any API token, as `GET /api/host`
 * (the host is not an app). An agent's signed request is not a reader.
 */
export function resourcesRouter(deps: ServiceDeps): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const type = req.actor?.type;
    if (type !== 'user' && type !== 'token') {
      sendRefusal(res, refusal('unauthenticated', 'You are not signed in.'));
      return;
    }
    res.json(await readResources(deps));
  });

  return router;
}
