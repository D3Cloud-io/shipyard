import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { IncidentBundle, renderIncidentBundle } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const load = (name: string): IncidentBundle =>
  IncidentBundle.parse(JSON.parse(readFileSync(join(here, 'fixtures', 'incidentBundle', 'valid', name), 'utf-8')));

describe('renderIncidentBundle (SHP-ADR-013)', () => {
  it('states the container, the facts, inspect, the last change and the logs, in that order', () => {
    const text = renderIncidentBundle(load('1.json'));
    const order = ['# Incident: postroom-imap-1', '## What Shipyard sees', '## Inspect', '## Last change', '## Logs (since the first error, redacted)'];
    const at = order.map((h) => text.indexOf(h));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(text).toContain('connect: connection refused');
    expect(text).toContain('deploy 01a19f9e-03d6-7178-a0db-db2a30fd2eb8 succeeded');
  });

  it('says why logs are missing rather than printing an empty block, and says none for an absent change', () => {
    const bundle = load('1.json');
    const text = renderIncidentBundle({
      ...bundle,
      lastChange: null,
      logs: { from: 'tail', lines: [], unavailable: { code: 'agent_offline', gate: 'none', message: 'The agent did not send the logs in time.', fix: 'Retry.' } },
    });
    expect(text).toContain('Logs unavailable: The agent did not send the logs in time. Retry.');
    expect(text).toMatch(/## Last change\n\n- none/);
    expect(text).not.toContain('```');
  });

  it('lists the last 24 hours of events, the latest health checks and the exit state (SHP-REQ-228)', () => {
    const text = renderIncidentBundle(load('1.json'));
    const order = ['## Inspect', '## Events (last 24 hours)', '## Health checks (latest, redacted)', '## Last change'];
    const at = order.map((h) => text.indexOf(h));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(text).toContain('- Exit code: 137');
    expect(text).toContain('- OOM killed: yes');
    expect(text).toContain('- Restart policy: always');
    expect(text).toContain('2026-11-04T10:01:00.000Z die exit 137');
    expect(text).toContain('exit 1: curl: (7) Failed to connect to localhost port 8080');
  });

  it('says none when there are no events or health checks, and when the agent does not report exit state', () => {
    const bundle = load('1.json');
    const text = renderIncidentBundle({ ...bundle, events: [], probes: [], inspect: { ...bundle.inspect, exitCode: null, oomKilled: null, restartPolicy: null } });
    expect(text).toMatch(/## Events \(last 24 hours\)\n\n- none/);
    expect(text).toMatch(/## Health checks \(latest, redacted\)\n\n- none/);
    expect(text).toContain('- OOM killed: none');
  });
});
