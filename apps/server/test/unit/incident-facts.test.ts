import { describe, expect, it } from 'vitest';
import { IncidentFact, type ContainerEvent, type LastChange, type LogLine } from '@shipyard/schema';
import { firstErrorIndex, formatDuration, incidentFacts, looksLikeError, type FactsInput } from '../../src/incident/facts.js';
import { incidentLogsOf } from '../../src/incident/service.js';

/** SHP-T-19.3: an incident's facts from fixed rules, in time order (SHP-ADR-013; SHP-REQ-216). */

function line(text: string, at: string | null = '2026-11-02T10:00:00.000Z'): LogLine {
  return { at, stream: 'stderr', text };
}

const healthy: FactsInput['container'] = { state: 'running', restartCount: 0, startedAt: '2026-11-02T09:00:00.000Z', stats: null };

describe('the error-line rule', () => {
  it('matches error words on a word boundary and nothing else', () => {
    for (const text of ['ERROR: boom', 'fatal: x', 'panic: nil', 'connection refused', 'permission denied', 'request timed out', 'timeout', 'Exception in thread', 'migration failed', 'err=1']) {
      expect(looksLikeError({ text }), text).toBe(true);
    }
    for (const text of ['listening on :3000', 'terrorist', 'errands done', 'GET /health 200']) {
      expect(looksLikeError({ text }), text).toBe(false);
    }
    expect(firstErrorIndex([line('ok'), line('still ok'), line('Error: x'), line('error again')])).toBe(2);
    expect(firstErrorIndex([line('ok')])).toBe(-1);
  });
});

describe('incidentLogsOf', () => {
  it('keeps the lines from the first error to the end', () => {
    const lines = [line('a'), line('b'), line('fatal: c'), line('d')];
    expect(incidentLogsOf(lines)).toEqual({ from: 'first-error', lines: lines.slice(2) });
  });

  it('keeps the last 200 when none looks like an error, and never more than 2000', () => {
    const quiet = Array.from({ length: 500 }, (_, i) => line(`ok ${String(i)}`));
    const kept = incidentLogsOf(quiet);
    expect(kept.from).toBe('tail');
    expect(kept.lines).toHaveLength(200);
    expect(kept.lines[0]?.text).toBe('ok 300');
    const loud = Array.from({ length: 2500 }, (_, i) => line(`error ${String(i)}`));
    const capped = incidentLogsOf(loud);
    expect(capped.lines).toHaveLength(2000);
    expect(capped.lines[0]?.text).toBe('error 500');
  });
});

describe('formatDuration', () => {
  it('gives the two largest units', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(30_000)).toBe('30s');
    expect(formatDuration(4 * 60_000)).toBe('4m');
    expect(formatDuration((2 * 3600 + 5 * 60 + 9) * 1000)).toBe('2h 5m');
    expect(formatDuration(-(3 * 86_400 + 4 * 3600) * 1000)).toBe('3d 4h');
  });
});

describe('incidentFacts', () => {
  it('states nothing for a healthy container with quiet logs and no change', () => {
    expect(incidentFacts({ container: healthy, condition: null, lines: [line('ok')], lastChange: null })).toEqual([]);
  });

  it('builds every rule, dated facts ascending and undated ones last', () => {
    const deploy: LastChange = {
      kind: 'deploy',
      id: '00000000-0000-4000-8000-000000000001',
      at: '2026-11-02T09:30:00.000Z',
      state: 'succeeded',
      sha: 'abcdef0'.padEnd(40, '1'),
      digest: null,
    };
    const facts = incidentFacts({
      container: { state: 'restarting', restartCount: 4, startedAt: '2026-11-02T10:05:00.000Z', stats: { cpuPercent: 3, memoryBytes: 900, memoryLimitBytes: 1000 } },
      condition: { condition: 'restarting', since: new Date('2026-11-02T10:02:00.000Z') },
      lines: [line('booting', '2026-11-02T09:59:00.000Z'), line('Error: db refused', '2026-11-02T10:01:00.000Z'), line('fatal: giving up', '2026-11-02T10:01:01.000Z')],
      lastChange: deploy,
    });
    for (const f of facts) IncidentFact.parse(f);
    expect(facts).toEqual([
      { kind: 'last-change', at: deploy.at, text: 'Last deploy abcdef0 succeeded at 2026-11-02T09:30:00.000Z, 32m before it began failing' },
      { kind: 'log-error', at: '2026-11-02T10:01:00.000Z', text: 'First error: Error: db refused' },
      { kind: 'failing', at: '2026-11-02T10:02:00.000Z', text: 'Restarting since 2026-11-02T10:02:00.000Z' },
      { kind: 'restarts', at: '2026-11-02T10:05:00.000Z', text: 'Docker has restarted it 4 times' },
      { kind: 'state', at: null, text: 'Docker reports it restarting' },
      { kind: 'log-error', at: null, text: '2 lines look like errors' },
      { kind: 'memory', at: null, text: 'Memory at 90% of its limit' },
    ]);
  });

  it('names an unhealthy container, a stack update after the failure began, and leaves memory under 70% out', () => {
    const update: LastChange = {
      kind: 'stack-update',
      id: '00000000-0000-4000-8000-000000000002',
      at: '2026-11-02T11:00:00.000Z',
      state: 'failed',
      sha: null,
      digest: `sha256:${'a'.repeat(64)}`,
    };
    const facts = incidentFacts({
      container: { ...healthy, stats: { cpuPercent: 1, memoryBytes: 600, memoryLimitBytes: 1000 } },
      condition: { condition: 'unhealthy', since: new Date('2026-11-02T10:00:00.000Z') },
      lines: [],
      lastChange: update,
    });
    expect(facts.map((f) => f.text)).toEqual([
      'Unhealthy since 2026-11-02T10:00:00.000Z',
      'Last update failed at 2026-11-02T11:00:00.000Z, 1h after it began failing',
    ]);
  });

  it('truncates the first error to 300 characters and an undated error line sorts last', () => {
    const long = `error ${'x'.repeat(1000)}`;
    const facts = incidentFacts({ container: { ...healthy, state: 'exited' }, condition: null, lines: [line(long, null)], lastChange: null });
    expect(facts.map((f) => f.kind)).toEqual(['state', 'log-error']);
    const text = facts[1]?.text ?? '';
    expect(text.startsWith('First error: error xxx')).toBe(true);
    expect(text.length).toBe('First error: '.length + 300);
    for (const f of facts) IncidentFact.parse(f);
  });

  it('says once for a single restart and ignores a container with no limit', () => {
    const facts = incidentFacts({
      container: { ...healthy, restartCount: 1, stats: { cpuPercent: 1, memoryBytes: 10_000, memoryLimitBytes: null } },
      condition: null,
      lines: [],
      lastChange: null,
    });
    expect(facts).toEqual([{ kind: 'restarts', at: healthy.startedAt, text: 'Docker has restarted it once' }]);
  });
});

describe('incidentFacts from container events (SHP-T-20.3; SHP-REQ-227, SHP-REQ-228)', () => {
  const id = 'a'.repeat(64);
  const ev = (kind: ContainerEvent['kind'], at: string, exitCode: number | null = null): ContainerEvent => ({ kind, at, containerId: id, containerName: 'web-1', exitCode, health: null });

  it('states a restart loop, the last non-zero exit and an OOM kill, dated, in time order', () => {
    const since = new Date('2026-11-04T10:00:00.000Z');
    const facts = incidentFacts({
      container: { ...healthy, exitCode: 0, oomKilled: false },
      condition: { condition: 'restart-loop', since },
      restartLoop: { restarts: 4, since },
      events: [ev('oom', '2026-11-04T09:59:00.000Z'), ev('die', '2026-11-04T09:59:01.000Z', 137), ev('start', '2026-11-04T10:00:00.000Z'), ev('die', '2026-11-04T10:05:00.000Z', 1)],
      lines: [],
      lastChange: null,
    });
    for (const f of facts) IncidentFact.parse(f);
    expect(facts).toEqual([
      { kind: 'oom', at: '2026-11-04T09:59:00.000Z', text: 'Killed for running out of memory' },
      { kind: 'failing', at: since.toISOString(), text: 'In a restart loop since 2026-11-04T10:00:00.000Z' },
      { kind: 'restart-loop', at: since.toISOString(), text: 'Restarted 4 times in 15 minutes.' },
      { kind: 'exit', at: '2026-11-04T10:05:00.000Z', text: 'Exited with code 1' },
    ]);
  });

  it("falls back to Docker's exit code and OOMKilled when no event says so, and states nothing for a clean exit", () => {
    const undated = incidentFacts({ container: { ...healthy, exitCode: 2, oomKilled: true }, condition: null, events: [], lines: [], lastChange: null });
    expect(undated).toEqual([
      { kind: 'exit', at: null, text: 'Docker reports its last exit code as 2' },
      { kind: 'oom', at: null, text: 'Docker reports its last run was killed for running out of memory' },
    ]);
    const clean = incidentFacts({ container: { ...healthy, exitCode: 0, oomKilled: false }, condition: null, events: [ev('die', '2026-11-04T10:00:00.000Z', 0)], lines: [], lastChange: null });
    expect(clean).toEqual([]);
    const many = incidentFacts({ container: healthy, condition: null, events: [ev('oom', '2026-11-04T09:00:00.000Z'), ev('oom', '2026-11-04T10:00:00.000Z')], lines: [], lastChange: null });
    expect(many).toEqual([{ kind: 'oom', at: '2026-11-04T10:00:00.000Z', text: 'Killed for running out of memory 2 times in 24 hours' }]);
  });

  it('states nothing new for an agent older than SHP-P-20, which reports none of it', () => {
    expect(incidentFacts({ container: healthy, condition: null, lines: [], lastChange: null })).toEqual([]);
  });
});
