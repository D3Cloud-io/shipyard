import type { HostContainer, IncidentCondition } from '@shipyard/schema';
import type { Db, Prisma } from '../db.js';

/**
 * When each failing container began failing (SHP-ADR-013, SHP-REQ-209): the `container_condition`
 * rows that Overview's incident banners and the incident bundle read for "since when".
 *
 * Kept on the agent's report, in `storeHostInventory`'s transaction, by the server's clock: a
 * container that is failing gets a row on the first report that shows it; one that has recovered,
 * or is no longer reported, loses its row. A container that changes from unhealthy to restarting
 * without recovering keeps its original `since` — it has been failing all along.
 */

/** Why a container is failing now, or null when it is not. Restarting wins: it is the louder symptom. */
export function conditionOf(container: Pick<HostContainer, 'state' | 'health'>): IncidentCondition | null {
  if (container.state === 'restarting') return 'restarting';
  if (container.health === 'unhealthy') return 'unhealthy';
  return null;
}

/** Brings `agentId`'s rows in line with `containers`, inside the caller's transaction. */
export async function syncContainerConditions(
  tx: Prisma.TransactionClient,
  agentId: string,
  containers: readonly HostContainer[],
  now: Date,
): Promise<void> {
  const failing = new Map<string, IncidentCondition>();
  for (const c of containers) {
    const condition = conditionOf(c);
    if (condition !== null) failing.set(c.name, condition);
  }
  await tx.containerCondition.deleteMany({ where: { agentId, containerName: { notIn: [...failing.keys()] } } });
  for (const [containerName, condition] of failing) {
    await tx.containerCondition.upsert({
      where: { agentId_containerName: { agentId, containerName } },
      create: { agentId, containerName, condition, since: now },
      update: { condition },
    });
  }
}

export interface ContainerConditionRow {
  agentId: string;
  containerName: string;
  condition: IncidentCondition;
  since: Date;
}

/** Every stored condition, oldest first. Reads only. */
export async function readContainerConditions(db: Db): Promise<ContainerConditionRow[]> {
  const rows = await db.containerCondition.findMany({ orderBy: [{ since: 'asc' }, { containerName: 'asc' }] });
  return rows.map((r) => ({
    agentId: r.agentId,
    containerName: r.containerName,
    condition: r.condition === 'restarting' ? 'restarting' : 'unhealthy',
    since: r.since,
  }));
}
