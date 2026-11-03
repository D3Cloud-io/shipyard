import { Router } from 'express';
import type { ServiceDeps } from '../deps.js';

/**
 * Mounted at `/api/overview` (SHP-ADR-013, SHP-T-19.2). A stub until that task lands: it mounts
 * nothing, so requests fall through to the app's 404.
 */
export function overviewRouter(_deps: ServiceDeps): Router {
  return Router();
}
