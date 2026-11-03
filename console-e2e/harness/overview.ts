import type { Db } from './db.js';
import { hostInventory } from './host.js';

/**
 * Overview's incident (SHP-T-19.6, SHP-REQ-209): a `container_condition` row for a Deployed
 * container already in the seeded host snapshot (harness/host.ts), written the way the server's
 * condition tracker leaves it, so `GET /api/overview` carries one banner for its app. Nothing else
 * of the world changes; `clearFailingContainers` puts it back.
 */

export const OVERVIEW_FIXTURE = {
  /** Deployed, in the `bindery` compose project, running with no healthcheck of its own. */
  failingContainer: 'bindery-worker-1',
  app: 'bindery',
  /** The other compose projects the seeded snapshot has: one Operated, one Observed. */
  operatedProject: 'immich',
  observedProject: 'forgejo',
  /** How long ago it began failing. */
  failingForMs: 12 * 60_000,
} as const;

/** A seeded container's ID, the way harness/host.ts derives it. */
export function seededContainerId(name: string): string {
  const found = hostInventory(Date.now()).containers.find((c) => c.name === name);
  if (found === undefined) throw new Error(`no seeded container ${name}`);
  return found.id;
}

/** Marks a seeded container failing since `since`: Overview shows its owner's banner. */
export async function seedFailingContainer(
  db: Db,
  agentId: string,
  containerName: string = OVERVIEW_FIXTURE.failingContainer,
  condition: 'unhealthy' | 'restarting' = 'unhealthy',
  since: Date = new Date(Date.now() - OVERVIEW_FIXTURE.failingForMs),
): Promise<void> {
  await db.containerCondition.upsert({
    where: { agentId_containerName: { agentId, containerName } },
    create: { agentId, containerName, condition, since },
    update: { condition, since },
  });
}

/** Clears every failing condition the agent has: no banner. */
export async function clearFailingContainers(db: Db, agentId: string): Promise<void> {
  await db.containerCondition.deleteMany({ where: { agentId } });
}
