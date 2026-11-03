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
});
