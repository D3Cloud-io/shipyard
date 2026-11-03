import { Router } from 'express';
import type { ServiceDeps } from '../deps.js';

/**
 * Mounted at `/api/containers` (SHP-ADR-013, SHP-T-19.3): `GET /:id/incident`. A stub until that
 * task lands: it mounts nothing, so requests fall through to the app's 404.
 */
export function incidentRouter(_deps: ServiceDeps): Router {
  return Router();
}
