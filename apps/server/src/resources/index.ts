import { Router } from 'express';
import { HostInventory, ResourcesResponse, refusal, type HostResources } from '@shipyard/schema';
import type { Db } from '../db.js';
import type { ServiceDeps } from '../deps.js';
import { sendRefusal } from '../errors.js';
import { HOST_SAMPLE_WINDOW_MS } from '../host/index.js';
import { SPIKE_MEDIAN_FACTOR, SPIKE_MIN_HISTORY, SPIKE_MIN_SAMPLES, SPIKE_NOISE_FLOOR_PERCENT, computeHostResources, type CpuSample } from './service.js';

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

/**
 * One agent's CPU samples within the window, grouped by container — only for the containers that
 * could hold a spike. Postgres works out each container's median and keeps the ones with at least
 * `SPIKE_MIN_SAMPLES` samples over the spike line, so a quiet host reads a handful of rows instead
 * of every container's 24 hours (about 127,000 at 88 containers). `findSpike` then decides on the
 * full series exactly as before; the filter is a necessary condition, never a different rule.
 */
async function readSamples(db: Db, agentId: string, since: Date): Promise<Map<string, CpuSample[]>> {
  const candidates = await db.$queryRaw<{ container_name: string }[]>`
    WITH m AS (
      SELECT container_name, percentile_cont(0.5) WITHIN GROUP (ORDER BY cpu_percent) AS med, count(*) AS n
      FROM host_sample WHERE agent_id = ${agentId}::uuid AND at >= ${since}
      GROUP BY container_name
    )
    SELECT s.container_name
    FROM host_sample s JOIN m ON m.container_name = s.container_name
    WHERE s.agent_id = ${agentId}::uuid AND s.at >= ${since}
      AND m.n >= ${SPIKE_MIN_HISTORY}
      AND s.cpu_percent > ${SPIKE_MEDIAN_FACTOR} * m.med
      AND s.cpu_percent >= ${SPIKE_NOISE_FLOOR_PERCENT}
    GROUP BY s.container_name
    HAVING count(*) >= ${SPIKE_MIN_SAMPLES}`;
  if (candidates.length === 0) return new Map();
  const rows = await db.hostSample.findMany({
    where: { agentId, at: { gte: since }, containerName: { in: candidates.map((c) => c.container_name) } },
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
