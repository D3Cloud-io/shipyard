import type { ContainerEvent } from '@shipyard/schema';
import type { Db } from '../db.js';

/**
 * Container history (SHP-ADR-013, SHP-T-20.3): the Engine events an agent reports, kept 30 days,
 * and 30-minute health buckets, kept 7. Pre-flight stub: the report handler already calls this, so
 * SHP-T-20.3 fills it in without touching the handler.
 */
export async function storeContainerEvents(_db: Db, _agentId: string, _events: readonly ContainerEvent[], _dropped: number, _now: Date): Promise<void> {
  // SHP-T-20.3.
}
