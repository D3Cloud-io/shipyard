import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AgentReport, HostInventory, type ContainerEvent } from '@shipyard/schema';
import type { SequencePorts } from '@shipyard/sequence';

import { createAgentClient } from '../../apps/agent/src/client.js';
import { createEventCollector, type EventCollector } from '../../apps/agent/src/events.js';
import { loadOrCreateIdentity } from '../../apps/agent/src/identity.js';
import { createInventoryCollector } from '../../apps/agent/src/inventory.js';
import { buildReport, startReporting, type Reporting } from '../../apps/agent/src/report.js';
import { startFakeControlPlane, type FakeControlPlane } from '../harness/control-plane.js';
import { enginePorts, memoryLog, prepareToyDataRoot, type ToyDataRoot } from '../harness/engine.js';
import { randomRevision, startHarness, type Harness, type ToyImage } from '../harness/harness.js';

/**
 * SHP-T-20.2 (SHP-REQ-217, SHP-REQ-221): against the real dind daemon, the agent's one read-only
 * `/events` stream sees a toy container restarted three times, and the reports the control plane
 * receives carry three restart events for it, each with its die and start, plus the host's CPU
 * count and memory from `/info` and the container's exit state and restart policy.
 */

async function waitFor(what: string, cond: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('Engine events in the agent report', () => {
  let h: Harness | undefined;
  let paths: ToyDataRoot | undefined;
  let plane: FakeControlPlane | undefined;
  let reporting: Reporting | undefined;
  let ports: SequencePorts;
  let image: ToyImage | undefined;
  const stopEvents = new AbortController();
  let eventStream: Promise<void> | undefined;
  const sha = randomRevision();
  const toy = `restarted-${sha.slice(0, 8)}`;

  beforeAll(async () => {
    h = await startHarness();
    paths = await prepareToyDataRoot({ soakSeconds: 2 });
    ports = enginePorts({ dockerHost: h.dockerHost, fakeGithubUrl: h.fakeGithubUrl, registryHostPort: h.registryHostPort }, memoryLog());
    image = await h.buildToyImage({ mode: 'pass', schema: 's1', revision: sha });
    plane = await startFakeControlPlane();
  });

  afterAll(async () => {
    reporting?.stop();
    stopEvents.abort();
    await eventStream;
    await plane?.stop();
    if (h !== undefined) await h.dind(['rm', '--force', toy]).catch(() => undefined);
    await paths?.remove();
    await h?.stop();
  });

  it('reports three restarts of a toy container as three restart events in the next reports', async () => {
    if (h === undefined || paths === undefined || plane === undefined || image === undefined) throw new Error('harness did not start');
    const fake = plane;
    const p = paths;

    // A plain container with no restart policy, started before the stream opens.
    await h.dind(['pull', image.ref]);
    await h.dind(['run', '-d', '--name', toy, '--restart', 'no', '--entrypoint', 'sleep', image.ref, '300']);
    const id = (await h.dind(['inspect', '--format', '{{.Id}}', toy])).stdout.trim();
    expect(id).toMatch(/^[0-9a-f]{64}$/);

    const identity = await loadOrCreateIdentity(p.dataRoot);
    const client = createAgentClient({ serverUrl: fake.url, identity, timeoutMs: 30_000 });
    // The way apps/agent/src/index.ts wires it: one collector for the inventory, one for events.
    const inventory = createInventoryCollector({ docker: ports.docker, dataRoot: p.dataRoot, fs: ports.fs });
    const events: EventCollector = createEventCollector({ docker: ports.docker, log: memoryLog() });
    eventStream = events.run(stopEvents.signal);
    const build = () =>
      buildReport({ fs: ports.fs, docker: ports.docker, engineApiVersion: () => Promise.resolve('e2e'), inventory, events }, p.dataRoot, {
        agentVersion: 'e2e',
        patExpiresAt: null,
      });
    reporting = startReporting(client, build, {
      intervalMs: 3_600_000,
      accepted: (report) => {
        events.accepted(report);
      },
    });
    const reports = (): AgentReport[] => fake.received.filter((r) => r.path === '/api/agent/report').map((r) => AgentReport.parse(r.body));
    await waitFor('the first report', () => reports().length >= 1, 120_000);

    for (let n = 0; n < 3; n++) await h.dind(['restart', '--time', '1', toy]);

    // Accepted reports let their events go, so the restarts are spread over the reports sent since.
    const ours = (): ContainerEvent[] => reports().flatMap((r) => (r.events ?? []).filter((e) => e.containerId === id));
    const count = (kind: ContainerEvent['kind']): number => ours().filter((e) => e.kind === kind).length;
    const send = reporting;
    await waitFor(
      'three restart events in the reports',
      async () => {
        await send.sendNow();
        return count('restart') >= 3;
      },
      60_000,
    );

    expect(count('restart')).toBe(3);
    expect(count('die')).toBe(3);
    expect(count('start')).toBe(3);
    for (const e of ours()) {
      expect(e.containerName).toBe(toy);
      expect(Date.parse(e.at)).not.toBeNaN();
      if (e.kind === 'die') expect(e.exitCode).not.toBeNull();
      else expect(e.exitCode).toBeNull();
    }
    // Oldest first: each restart's die comes before its start.
    const kinds = ours().map((e) => e.kind);
    expect(kinds.indexOf('die')).toBeLessThan(kinds.indexOf('start'));
    expect(reports().every((r) => (r.droppedEvents ?? 0) === 0)).toBe(true);

    // SHP-REQ-221: the host totals from /info and the container's exit state and policy.
    const host = HostInventory.parse(reports().at(-1)?.host);
    expect(host.cpuCores).toBeGreaterThanOrEqual(1);
    expect(host.memoryBytes).toBeGreaterThan(0);
    expect(host.containers.find((c) => c.id === id)).toMatchObject({ state: 'running', restartPolicy: 'no', oomKilled: false, healthLog: [] });
    expect(typeof host.containers.find((c) => c.id === id)?.exitCode).toBe('number');
  });
});
