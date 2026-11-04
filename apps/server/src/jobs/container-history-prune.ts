import type { ServiceDeps } from '../deps.js';
import { CONTAINER_EVENT_RETENTION_MS, CONTAINER_HEALTH_RETENTION_MS } from '../host/index.js';

/** How often `startContainerHistoryPrune` runs. */
export const CONTAINER_HISTORY_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export interface ContainerHistoryPruned {
  events: number;
  buckets: number;
}

/**
 * Deletes container events older than 30 days (SHP-REQ-222) and health buckets older than 7
 * (SHP-REQ-223) before `now`. An event goes by the Engine's time for it, a bucket by its start.
 * Returns how many of each were deleted.
 */
export async function pruneContainerHistory(deps: Pick<ServiceDeps, 'db' | 'logger'>, now: Date = new Date()): Promise<ContainerHistoryPruned> {
  const eventCutoff = new Date(now.getTime() - CONTAINER_EVENT_RETENTION_MS);
  const bucketCutoff = new Date(now.getTime() - CONTAINER_HEALTH_RETENTION_MS);
  const { count: events } = await deps.db.containerEvent.deleteMany({ where: { at: { lt: eventCutoff } } });
  const { count: buckets } = await deps.db.containerHealth.deleteMany({ where: { bucketStart: { lt: bucketCutoff } } });
  if (events > 0 || buckets > 0) deps.logger.info({ events, buckets }, 'container history pruned');
  return { events, buckets };
}

/** Starts the hourly container-history prune; the stopper waits for a run in flight. */
export function startContainerHistoryPrune(
  deps: Pick<ServiceDeps, 'db' | 'logger'>,
  intervalMs = CONTAINER_HISTORY_PRUNE_INTERVAL_MS,
): { stop: () => Promise<void> } {
  let stopped = false;
  let inFlight: Promise<unknown> = Promise.resolve();

  const tick = (): void => {
    inFlight = pruneContainerHistory(deps).catch((err: unknown) => {
      deps.logger.error({ err }, 'container history prune failed');
    });
  };

  const timer = setInterval(tick, intervalMs);
  tick();

  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
