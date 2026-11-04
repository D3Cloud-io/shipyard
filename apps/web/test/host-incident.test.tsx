import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderIncidentBundle, type ActionStatus, type HostContainer, type HostSnapshot, type IncidentBundle } from '@shipyard/schema';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { LOGS_FOLLOW_SECONDS } from '../src/lib/actions';
import {
  HEALTHY_REPORTS_NEEDED,
  copiedWords,
  followRestart,
  reportFrom,
  restartActionOf,
  withReport,
  type Report,
  type RestartAction,
} from '../src/lib/incident';
import { RestartFollow } from '../src/screens/host/RestartFollow';
import { restartConsequence } from '../src/screens/host/RestartConfirm';
import { meReply, mockFetch, type Call, type Reply } from './fetch';

/**
 * SHP-T-19.7 (SHP-REQ-210/211/212/242, SHP-ADR-013): Restart asks first, naming the container and its
 * app; a confirmed restart is followed until the container reports healthy three times in a row or
 * fails again, and the sheet says which; Copy for Claude puts the incident bundle on the clipboard
 * and says what it copied. The follow rule is a pure function, tested here without timers.
 */

// ── Fixtures ─────────────────────────────────────────────────────────────

const MB = 1024 * 1024;
const WORKER_ID = '1'.repeat(64);
const FORGEJO_ID = '4'.repeat(64);
const ACTION_ID = '0b9c1f6e-6a4e-4d43-9a49-8e1f2b3c4d5e';
const LOGS_ID = '5f0e2c1a-1b2c-4d3e-8f4a-5b6c7d8e9f00';

function container(name: string, overrides: Partial<HostContainer>): HostContainer {
  return {
    id: '0'.repeat(64),
    name,
    image: `ghcr.io/matdemers1/${name}:sha-${'a'.repeat(40)}`,
    imageId: `sha256:${'b'.repeat(64)}`,
    digest: null,
    state: 'running',
    health: 'none',
    restartCount: 0,
    createdAt: '2026-10-20T00:00:00.000Z',
    startedAt: '2026-10-20T00:00:01.000Z',
    compose: null,
    tier: 'observed',
    app: null,
    ports: [],
    mounts: [],
    stats: { cpuPercent: 11.8, memoryBytes: 300 * MB, memoryLimitBytes: null },
    ...overrides,
  };
}

const WORKER = container('bindery-worker-1', { id: WORKER_ID, compose: { project: 'bindery', service: 'worker' }, tier: 'shipped', app: 'bindery' });
const FORGEJO = container('forgejo', { id: FORGEJO_ID, compose: { project: 'forgejo', service: 'server' } });

function snapshot(worker: Partial<HostContainer>, reportedAt: number): HostSnapshot {
  return {
    agent: { id: '7c0f4a0e-3b51-4d8e-9a8e-1f2e3d4c5b6a', fingerprint: 'SHA256:agent' },
    reportedAt: new Date(reportedAt).toISOString(),
    inventory: {
      sampledAt: new Date(reportedAt).toISOString(),
      containers: [{ ...WORKER, ...worker }, FORGEJO],
      volumes: [],
      images: [],
      networks: [],
      builderCache: { bytes: 0, reclaimableBytes: 0 },
      disk: { dataRoot: { path: '/DATA', freeBytes: 1, totalBytes: 2 }, dockerRoot: null },
    },
    samples: {},
  };
}

function status(overrides: Partial<ActionStatus> = {}): ActionStatus {
  const now = Date.now();
  return {
    id: ACTION_ID,
    target: { kind: 'app', name: 'bindery' },
    verb: 'restart',
    service: 'worker',
    state: 'succeeded',
    requesterLabel: 'Matt (console)',
    createdAt: new Date(now - 8_000).toISOString(),
    startedAt: new Date(now - 7_000).toISOString(),
    endedAt: new Date(now).toISOString(),
    refusal: null,
    output: null,
    ...overrides,
  };
}

function bundle(overrides: Partial<IncidentBundle> = {}): IncidentBundle {
  return {
    builtAt: '2026-11-03T10:00:00.000Z',
    container: { id: WORKER_ID, name: WORKER.name, tier: 'shipped', owner: 'bindery', compose: { project: 'bindery', service: 'worker' } },
    condition: 'unhealthy',
    failingSince: '2026-11-03T09:50:00.000Z',
    facts: [
      { kind: 'failing', at: '2026-11-03T09:50:00.000Z', text: 'Unhealthy since 09:50.' },
      { kind: 'restarts', at: null, text: 'Restarted 3 times.' },
    ],
    inspect: {
      image: WORKER.image,
      digest: null,
      state: 'running',
      health: 'unhealthy',
      restartCount: 3,
      createdAt: '2026-10-20T00:00:00.000Z',
      startedAt: '2026-10-20T00:00:01.000Z',
      memoryBytes: null,
      memoryLimitBytes: null,
      cpuPercent: null,
      exitCode: 0,
      oomKilled: false,
      restartPolicy: 'unless-stopped',
    },
    events: [],
    probes: [],
    logs: {
      from: 'first-error',
      lines: [
        { at: '2026-11-03T09:50:01.000Z', stream: 'stderr', text: 'ECONNREFUSED db:5432' },
        { at: '2026-11-03T09:50:02.000Z', stream: 'stdout', text: 'retrying' },
      ],
      unavailable: null,
    },
    lastChange: null,
    ...overrides,
  };
}

type Role = 'admin' | 'operator' | 'deployer' | 'viewer';

function routes(role: Role, extra: Record<string, Reply | Reply[] | ((init: RequestInit | undefined) => Reply)> = {}) {
  return mockFetch({
    'GET /api/auth/me': meReply(role),
    'GET /api/apps': { status: 200, body: { apps: [] } },
    'GET /api/approvals': { status: 200, body: [] },
    'GET /api/agent': { status: 200, body: [] },
    'GET /api/host': { status: 200, body: { hosts: [snapshot({}, Date.now())] } },
    'POST /api/logs': (init) => ({
      status: 201,
      body: { id: LOGS_ID, container: WORKER_ID, containerName: WORKER.name, tail: 200, follow: (JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { follow?: boolean }).follow === true, createdAt: new Date().toISOString() },
    }),
    [`DELETE /api/logs/${LOGS_ID}`]: { status: 200 },
    ...extra,
  });
}

class FakeEventSource {
  onerror: ((e: Event) => void) | null = null;
  addEventListener(): void {
    /* no lines in these tests */
  }
  close(): void {
    /* nothing open */
  }
}

function openSheet(id = WORKER_ID, name = WORKER.name): Promise<HTMLElement> {
  Object.defineProperty(globalThis, 'EventSource', { configurable: true, writable: true, value: FakeEventSource });
  window.history.replaceState(null, '', `/host?container=${id}`);
  render(<App />);
  return screen.findByRole('dialog', { name });
}

function posts(calls: readonly Call[], path: string): Call[] {
  return calls.filter((c) => c.method === 'POST' && c.path === path);
}

function clipboard(): { writeText: ReturnType<typeof vi.fn> } {
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  return { writeText };
}

// ── The follow rule ──────────────────────────────────────────────────────

const END = 1_000_000_000_000;
const succeeded: RestartAction = { kind: 'succeeded', startedAt: END - 7_000, endedAt: END, words: 'Restarted worker in 7s' };
const report = (seconds: number, state: Report['state'], health: Report['health']): Report => ({ at: END + seconds * 1000, state, health });
const view = (reports: Report[], now = END + 60_000, action: RestartAction = succeeded) => followRestart({ name: WORKER.name, action, reports, now });

describe('followRestart (SHP-REQ-211, SHP-REQ-242)', () => {
  it('is healthy again after three healthy reports in a row, and says so', () => {
    const v = view([report(10, 'running', 'healthy'), report(70, 'running', 'healthy'), report(130, 'running', 'healthy')]);
    expect(HEALTHY_REPORTS_NEEDED).toBe(3);
    expect(v.status).toBe('healthy');
    expect(v.headline).toBe('Healthy again');
    expect(v.done).toBe(true);
    expect(v.steps.map((s) => [s.label, s.mark])).toEqual([
      ['Stopped bindery-worker-1', 'done'],
      ['Restarted worker in 7s', 'done'],
      ['Health check passed (3 of 3)', 'done'],
      ['Healthy again', 'done'],
    ]);
  });

  it('counts a container with no healthcheck as healthy when it is running', () => {
    const v = view([report(10, 'running', 'none'), report(70, 'running', 'none'), report(130, 'running', 'none')]);
    expect(v.status).toBe('healthy');
    expect(v.steps[2]?.label).toBe('Reported running (3 of 3)');
  });

  it('keeps counting while healthy reports are fewer than three', () => {
    const v = view([report(10, 'running', 'healthy'), report(70, 'running', 'healthy')]);
    expect(v.status).toBe('checking');
    expect(v.passed).toBe(2);
    expect(v.done).toBe(false);
    expect(v.steps[2]).toMatchObject({ label: 'Health check passed (2 of 3)', mark: 'active' });
  });

  it('starts the count over when a report is not healthy yet (starting), since it must be in a row', () => {
    const v = view([report(10, 'running', 'healthy'), report(70, 'running', 'starting'), report(130, 'running', 'healthy'), report(190, 'running', 'healthy')]);
    expect(v.status).toBe('checking');
    expect(v.passed).toBe(2);
  });

  it('ignores reports from before the restart finished, which describe the old container', () => {
    const v = view([report(-30, 'running', 'unhealthy'), report(-20, 'running', 'healthy'), report(10, 'running', 'starting')]);
    expect(v.status).toBe('checking');
    expect(v.passed).toBe(0);
  });

  it('is failing again on a report that shows it restarting or unhealthy, and offers the bundle', () => {
    for (const r of [report(10, 'restarting', 'none'), report(10, 'running', 'unhealthy'), report(10, 'exited', 'none')]) {
      const v = view([report(5, 'running', 'healthy'), r]);
      expect(v.status).toBe('failing');
      expect(v.headline).toBe('Failing again');
      expect(v.done).toBe(true);
      expect(v.steps.at(-1)).toMatchObject({ label: 'The same error is back', mark: 'failed' });
    }
  });

  it('decides on the first decisive report in order, so a late failure cannot undo three healthy ones', () => {
    const v = view([report(10, 'running', 'healthy'), report(70, 'running', 'healthy'), report(130, 'running', 'healthy'), report(190, 'running', 'unhealthy')]);
    expect(v.status).toBe('healthy');
  });

  it('says the restart did not go through when the action failed, with the refusal', () => {
    const v = view([], END, { kind: 'failed', message: 'The agent that runs this has not polled the server recently.', fix: 'Check the agent is running.' });
    expect(v.status).toBe('not-sent');
    expect(v.headline).toBe('The restart did not go through');
    expect(v.detail).toBe('The agent that runs this has not polled the server recently.');
    expect(v.fix).toBe('Check the agent is running.');
    expect(v.done).toBe(true);
  });

  it('waits while the action is not finished, and never counts a report then', () => {
    const v = view([report(10, 'running', 'healthy')], END, { kind: 'running', startedAt: END - 2_000 });
    expect(v.status).toBe('restarting');
    expect(v.done).toBe(false);
    expect(v.steps.map((s) => s.mark)).toEqual(['done', 'active', 'pending', 'pending']);
    expect(view([], END, { kind: 'sending' }).steps[0]?.mark).toBe('active');
  });

  it('is not settled when the five minutes end first, saying what it last was', () => {
    const deadline = END + LOGS_FOLLOW_SECONDS * 1000;
    const stillGoing = view([report(10, 'running', 'starting')], deadline - 1);
    expect(stillGoing.status).toBe('checking');
    const v = view([report(10, 'running', 'starting')], deadline);
    expect(v.status).toBe('unsettled');
    expect(v.headline).toBe('Still not settled after 5 minutes');
    expect(v.detail).toBe('Last seen: Running · starting.');
    expect(view([], deadline).detail).toBe('It has not been in a report since the restart.');
  });
});

describe('the follow helpers', () => {
  it('reads this container out of a snapshot by name, once per report', () => {
    const res = { hosts: [snapshot({ state: 'running', health: 'unhealthy' }, END + 5_000)] };
    const r = reportFrom(res, WORKER.name);
    expect(r).toEqual({ at: END + 5_000, state: 'running', health: 'unhealthy' });
    expect(reportFrom({ hosts: [] }, WORKER.name)).toBeNull();
    expect(reportFrom(res, 'gone')).toEqual({ at: END + 5_000, state: null, health: null });
    const once = withReport([], r);
    expect(withReport(once, r)).toBe(once);
    expect(withReport(once, { at: END, state: 'running', health: 'healthy' }).map((x) => x.at)).toEqual([END, END + 5_000]);
  });

  it('turns the action phase into what the follow needs', () => {
    expect(restartActionOf({ kind: 'idle' })).toEqual({ kind: 'sending' });
    const done = status();
    expect(restartActionOf({ kind: 'done', status: done })).toMatchObject({ kind: 'succeeded', words: expect.stringMatching(/^Restarted worker/) as string });
    expect(restartActionOf({ kind: 'done', status: status({ state: 'failed', endedAt: null }) })).toEqual({ kind: 'failed', message: 'Restart of worker failed', fix: null });
  });

  it('says what was copied', () => {
    expect(copiedWords(bundle())).toBe('Copied 2 facts and 2 log lines (since the first error) for Claude — built just now, stored nowhere.');
    expect(copiedWords(bundle({ facts: [], logs: { from: 'tail', lines: [{ at: null, stream: 'stdout', text: 'x' }], unavailable: null } }))).toBe(
      'Copied 0 facts and 1 log line (latest lines) for Claude — built just now, stored nowhere.',
    );
    const unavailable = { code: 'agent_offline' as const, gate: 'none' as const, message: 'The agent is offline.', fix: 'Start it.' };
    expect(copiedWords(bundle({ logs: { from: 'tail', lines: [], unavailable } }))).toBe('Copied 2 facts for Claude — logs unavailable: The agent is offline. Built just now, stored nowhere.');
  });
});

// ── Restart asks first ───────────────────────────────────────────────────

describe('Restart confirms (SHP-REQ-210)', () => {
  it('names the container and its app, and Cancel sends nothing', async () => {
    const calls = routes('admin', { 'POST /api/actions': { status: 202, body: status() } });
    const user = userEvent.setup();
    const sheet = await openSheet();
    await user.click(within(sheet).getByRole('button', { name: 'Restart' }));
    const confirm = await screen.findByRole('dialog', { name: `Restart ${WORKER.name}?` });
    expect(within(confirm).getByText(restartConsequence({ kind: 'app', name: 'bindery' }, 'worker'))).toBeInTheDocument();
    expect(within(confirm).getByText(/bindery · worker restarts on the same image/)).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(posts(calls, '/api/actions')).toEqual([]);
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: `Restart ${WORKER.name}?` })).not.toBeInTheDocument();
    });
    expect(posts(calls, '/api/actions')).toEqual([]);
  });

  it('leaves Recreate asking nothing and sending at once', async () => {
    const calls = routes('admin', { 'POST /api/actions': { status: 202, body: status({ verb: 'recreate', state: 'running', endedAt: null }) }, [`GET /api/actions/${ACTION_ID}`]: { status: 200, body: status({ verb: 'recreate', state: 'running', endedAt: null }) } });
    const user = userEvent.setup();
    const sheet = await openSheet();
    await user.click(within(sheet).getByRole('button', { name: 'Recreate' }));
    expect(posts(calls, '/api/actions').map((c) => c.body)).toEqual([{ target: { kind: 'app', name: 'bindery' }, verb: 'recreate', service: 'worker' }]);
  });
});

// ── The follow, in the sheet ─────────────────────────────────────────────

describe('a followed restart', () => {
  it('turns the logs to follow and counts healthy reports', async () => {
    const calls = routes('admin', {
      'POST /api/actions': { status: 202, body: status() },
      'GET /api/host': { status: 200, body: { hosts: [snapshot({ health: 'healthy' }, Date.now() + 60_000)] } },
    });
    const user = userEvent.setup();
    const sheet = await openSheet();
    await user.click(within(sheet).getByRole('button', { name: 'Restart' }));
    await user.click(within(await screen.findByRole('dialog', { name: `Restart ${WORKER.name}?` })).getByRole('button', { name: 'Restart' }));

    expect(await within(sheet).findByText('Health check passed (1 of 3)')).toBeInTheDocument();
    expect(within(sheet).getByText(/^Restarted worker in \d+s$/)).toBeInTheDocument();
    expect(within(sheet).getByText(`Following ${WORKER.name} until it is healthy again`)).toBeInTheDocument();
    await waitFor(() => {
      expect(posts(calls, '/api/logs').map((c) => (c.body as { follow: boolean }).follow)).toEqual([false, true]);
    });
  });

  it('says "Failing again" and offers Copy for Claude beside it', async () => {
    routes('admin', {
      'POST /api/actions': { status: 202, body: status() },
      'GET /api/host': { status: 200, body: { hosts: [snapshot({ health: 'unhealthy' }, Date.now() + 60_000)] } },
    });
    const user = userEvent.setup();
    const sheet = await openSheet();
    await user.click(within(sheet).getByRole('button', { name: 'Restart' }));
    await user.click(within(await screen.findByRole('dialog', { name: `Restart ${WORKER.name}?` })).getByRole('button', { name: 'Restart' }));

    expect(await within(sheet).findByText('Failing again')).toBeInTheDocument();
    expect(within(sheet).getByText('The same error is back')).toBeInTheDocument();
    // One Copy for Claude, in the outcome, not a second in the action row.
    expect(within(sheet).getAllByRole('button', { name: 'Copy for Claude' })).toHaveLength(1);
    expect(within(sheet.querySelector('.shp-inc-follow') as HTMLElement).getByRole('button', { name: 'Copy for Claude' })).toBeInTheDocument();
  });

  it('says the restart did not go through, with the refusal, when the request is refused', async () => {
    const calls = routes('admin', {
      'POST /api/actions': {
        status: 409,
        body: { error: { code: 'agent_offline', gate: 'none', message: 'The agent that runs this has not polled the server recently.', fix: 'Check the agent is running and can reach the server, then retry.' } },
      },
    });
    const user = userEvent.setup();
    const sheet = await openSheet();
    await user.click(within(sheet).getByRole('button', { name: 'Restart' }));
    await user.click(within(await screen.findByRole('dialog', { name: `Restart ${WORKER.name}?` })).getByRole('button', { name: 'Restart' }));
    expect(await within(sheet).findByText('The restart did not go through')).toBeInTheDocument();
    expect(within(sheet).getByText('The agent that runs this has not polled the server recently.')).toBeInTheDocument();
    expect(within(sheet).getByText('Check the agent is running and can reach the server, then retry.')).toBeInTheDocument();
    // No restart happened, so nothing is followed.
    expect(posts(calls, '/api/logs').map((c) => (c.body as { follow: boolean }).follow)).toEqual([false]);
  });
});

describe('RestartFollow polling', () => {
  it('stops after three healthy reports in a row and tells the sheet', async () => {
    const endedAt = Date.now();
    const done = { kind: 'done' as const, status: status({ endedAt: new Date(endedAt).toISOString() }) };
    const reply = (n: number): Reply => ({ status: 200, body: { hosts: [snapshot({ health: 'healthy' }, endedAt + n * 1000)] } });
    const calls = routes('admin', { 'GET /api/host': [reply(10), reply(20), reply(30), reply(40)] });
    const onSettled = vi.fn();
    const onRestarted = vi.fn();
    render(<RestartFollow name={WORKER.name} phase={done} pollMs={15} onSettled={onSettled} onRestarted={onRestarted} />);
    await waitFor(() => {
      expect(onSettled).toHaveBeenCalledWith('healthy');
    });
    expect(screen.getByText('Health check passed (3 of 3)')).toBeInTheDocument();
    expect(onRestarted).toHaveBeenCalledTimes(1);
    const reads = calls.filter((c) => c.path === '/api/host').length;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 80));
    });
    expect(calls.filter((c) => c.path === '/api/host')).toHaveLength(reads);
  });
});

// ── Copy for Claude ──────────────────────────────────────────────────────

describe('Copy for Claude (SHP-REQ-212)', () => {
  it('copies the rendered bundle and says what it copied', async () => {
    routes('operator', { [`GET /api/containers/${WORKER_ID}/incident`]: { status: 200, body: bundle() } });
    const user = userEvent.setup();
    const { writeText } = clipboard();
    const sheet = await openSheet();
    await user.click(within(sheet).getByRole('button', { name: 'Copy for Claude' }));
    expect(await within(sheet).findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(renderIncidentBundle(bundle()));
    expect(writeText.mock.calls[0]?.[0]).toMatch(/^# Incident: bindery-worker-1/);
    expect(within(sheet).getByText('Copied 2 facts and 2 log lines (since the first error) for Claude — built just now, stored nowhere.')).toBeInTheDocument();
  });

  it('shows "Building the bundle…" while it waits', async () => {
    let release: (r: Reply) => void = () => undefined;
    const gate = new Promise<Reply>((resolve) => {
      release = resolve;
    });
    routes('admin', { [`GET /api/containers/${WORKER_ID}/incident`]: () => ({ status: 200, body: bundle() }) });
    // A slow bundle: hold the first fetch for it.
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return url.includes('/incident') ? gate.then((r) => new Response(JSON.stringify(r.body), { status: r.status })) : real(input, init);
    });
    const user = userEvent.setup();
    clipboard();
    const sheet = await openSheet();
    await user.click(within(sheet).getByRole('button', { name: 'Copy for Claude' }));
    expect(await within(sheet).findByRole('button', { name: 'Building the bundle…' })).toBeDisabled();
    release({ status: 200, body: bundle() });
    expect(await within(sheet).findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('says why the logs are missing when the agent could not answer', async () => {
    const unavailable = { code: 'agent_offline', gate: 'none', message: 'The agent that runs this has not polled the server recently.', fix: 'Check the agent.' };
    routes('admin', { [`GET /api/containers/${WORKER_ID}/incident`]: { status: 200, body: bundle({ logs: { from: 'tail', lines: [], unavailable } as IncidentBundle['logs'] }) } });
    const user = userEvent.setup();
    clipboard();
    const sheet = await openSheet();
    await user.click(within(sheet).getByRole('button', { name: 'Copy for Claude' }));
    expect(await within(sheet).findByText('Copied 2 facts for Claude — logs unavailable: The agent that runs this has not polled the server recently. Built just now, stored nowhere.')).toBeInTheDocument();
  });

  it('shows the Markdown to copy by hand when the clipboard is unavailable', async () => {
    routes('admin', { [`GET /api/containers/${WORKER_ID}/incident`]: { status: 200, body: bundle() } });
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('denied')) } });
    const sheet = await openSheet();
    await user.click(within(sheet).getByRole('button', { name: 'Copy for Claude' }));
    const box = await within(sheet).findByRole('textbox', { name: 'Incident bundle for Claude' });
    expect(box).toHaveAttribute('readonly');
    expect((box as HTMLTextAreaElement).value).toBe(renderIncidentBundle(bundle()));
    expect(within(sheet).getByText(/would not let the console use the clipboard/)).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Copy for Claude' })).toBeEnabled();
  });

  it("shows a refusal's message and fix", async () => {
    routes('admin', {
      [`GET /api/containers/${WORKER_ID}/incident`]: { status: 404, body: { error: { code: 'not_found', gate: 'none', message: 'That container is not on this host.', fix: 'Reload Host.' } } },
    });
    const user = userEvent.setup();
    clipboard();
    const sheet = await openSheet();
    await user.click(within(sheet).getByRole('button', { name: 'Copy for Claude' }));
    expect(await within(sheet).findByText('That container is not on this host.')).toBeInTheDocument();
    expect(within(sheet).getByText('Reload Host.')).toBeInTheDocument();
  });

  it('is there for an Observed container too, to an admin', async () => {
    routes('admin');
    const sheet = await openSheet(FORGEJO_ID, FORGEJO.name);
    expect(within(sheet).getByRole('button', { name: 'Copy for Claude' })).toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: 'Restart' })).not.toBeInTheDocument();
  });

  it('is absent for a deployer, who keeps Restart', async () => {
    routes('deployer');
    const sheet = await openSheet();
    expect(within(sheet).queryByRole('button', { name: 'Copy for Claude' })).not.toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Restart' })).toBeInTheDocument();
  });

  it('is absent for a viewer', async () => {
    routes('viewer');
    const sheet = await openSheet();
    expect(within(sheet).queryByRole('button', { name: 'Copy for Claude' })).not.toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: 'Restart' })).not.toBeInTheDocument();
  });
});
