import { Router } from 'express';
import { refusal } from '@shipyard/schema';
import type { ServiceDeps } from '../deps.js';
import { sendRefusal } from '../errors.js';
import { buildOverview } from './service.js';

export { buildOverview } from './service.js';

/**
 * Mounted at /api/overview (SHP-ADR-013, SHP-REQ-207, SHP-REQ-209). GET only: any signed-in user,
 * whatever the role, and any API token, whatever its app scope — Overview shows what the Host
 * destination shows plus the ledger's recent work. It writes nothing and audits nothing. An agent's
 * signed request is not a reader. Any other method falls through to the app's 404.
 */
export function overviewRouter(deps: ServiceDeps): Router {
  const { db } = deps;
  const router = Router();

  router.get('/', async (req, res) => {
    const type = req.actor?.type;
    if (type !== 'user' && type !== 'token') {
      sendRefusal(res, refusal('unauthenticated', 'You are not signed in.'));
      return;
    }
    res.json(await buildOverview(db));
  });

  return router;
}
