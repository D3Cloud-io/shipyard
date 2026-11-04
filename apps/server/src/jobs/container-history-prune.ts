import type { ServiceDeps } from '../deps.js';

/**
 * Deletes container events older than 30 days and health buckets older than 7 (SHP-REQ-222,
 * SHP-REQ-223). Pre-flight stub: the server already starts it, so SHP-T-20.3 fills it in.
 */
export function startContainerHistoryPrune(_deps: Pick<ServiceDeps, 'db' | 'logger'>): { stop: () => Promise<void> } {
  return { stop: () => Promise.resolve() };
}
