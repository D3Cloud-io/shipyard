import type { HostContainer, HostResponse } from '@shipyard/schema';
import type { ServiceDeps } from '../deps.js';
import type { DeployCaller } from '../deploys/service.js';
import { logsViewerOf, tokenLogsScopeRefusal } from '../logs/service.js';

/**
 * Who sees health-check output (SHP-ADR-011, SHP-REQ-220, SHP-REQ-224): a probe's output is redacted
 * command output, like a container's logs, so `GET /api/host` and `shipyard_host` show it only to a
 * caller who may read that container's logs — an admin or operator signed in, or a `can_read_logs`
 * token whose owner still is one and whose scope names the container's app or stack. Everyone
 * else sees each result's times and exit code with its output blanked to `''`.
 */

export type ProbeOutputCaller = Pick<DeployCaller, 'actor' | 'role' | 'tokenApps' | 'tokenStacks'>;

function blanked(container: HostContainer): HostContainer {
  if (container.healthLog === undefined || container.healthLog.length === 0) return container;
  return { ...container, healthLog: container.healthLog.map((probe) => ({ ...probe, output: '' })) };
}

/** `response` with every probe's output the caller may not read set to `''`. Reads only. */
export async function withProbeOutputFor(deps: ServiceDeps, caller: ProbeOutputCaller, response: HostResponse): Promise<HostResponse> {
  const viewer = await logsViewerOf(deps, caller);
  if (!('code' in viewer) && viewer.type === 'user') return response;
  const readable = (container: HostContainer): boolean => !('code' in viewer) && tokenLogsScopeRefusal(caller, container) === null;
  return {
    hosts: response.hosts.map((host) => ({
      ...host,
      inventory: { ...host.inventory, containers: host.inventory.containers.map((c) => (readable(c) ? c : blanked(c))) },
    })),
  };
}
