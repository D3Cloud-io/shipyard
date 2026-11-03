import { Router } from 'express';
import { refusal } from '@shipyard/schema';
import type { ServiceDeps } from '../deps.js';
import { callerFromRequest } from '../deploys/service.js';
import { sendRefusal } from '../errors.js';
import { buildIncidentBundle } from './service.js';

export * from './facts.js';
export * from './service.js';

/**
 * Mounted at `/api/containers` (SHP-ADR-013; SHP-REQ-212, SHP-REQ-214, SHP-REQ-215):
 * `GET /:id/incident` builds one container's incident bundle on request and returns it. Read-only
 * apart from its audit events; nothing of the bundle is kept.
 */

const CONTAINER_ID = /^[0-9a-f]{64}$/;

export function incidentRouter(deps: ServiceDeps): Router {
  const router = Router();

  router.get('/:id/incident', async (req, res) => {
    const raw: unknown = req.params['id'];
    const id = typeof raw === 'string' ? raw : '';
    if (!CONTAINER_ID.test(id)) {
      sendRefusal(res, refusal('invalid_request', 'A container ID is 64 lowercase hex characters.', 'Use the full ID the Host view shows.'));
      return;
    }
    const bundle = await buildIncidentBundle(deps, callerFromRequest(req), { containerId: id });
    if ('code' in bundle) {
      sendRefusal(res, bundle);
      return;
    }
    res.json(bundle);
  });

  return router;
}
