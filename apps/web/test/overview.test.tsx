import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Overview as OverviewSchema, type AppTile, type IncidentBanner, type Overview, type OverviewWork, type ProjectChip } from '@shipyard/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { clockTime } from '../src/lib/deploy';
import {
  appsHealthy,
  collapseTiles,
  containerHref,
  coresWords,
  cpuPercentWords,
  freshnessWords,
  gbWords,
  incidentContainerLine,
  incidentHeadline,
  last24hSentence,
  lastChangeSentence,
  oldestContainer,
  ownerButtonWords,
  ownerHref,
  projectsSummary,
  tileChangeWords,
  workHref,
} from '../src/lib/overview';
import { meReply, mockFetch, type Reply } from './fetch';

/**
 * Overview (SHP-T-19.6, SHP-REQ-207, SHP-REQ-209): incident banners first, then what runs, Needs
 * you, what is happening now, the Deployed apps' tiles, the last 24 hours and every other compose
 * project — all from `GET /api/overview`, with its words in pure helpers.
 */

const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const GB = 1024 * 1024 * 1024;
const SHA = 'abcdef0'.padEnd(40, '1');
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CID = (c: string) => c.repeat(64);
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

function tile(name: string, overrides: Partial<AppTile> = {}): AppTile {
  return {
    name,
    health: 'healthy',
    containers: 2,
    running: 2,
    failing: 0,
    cpuPercent: 2.4,
    memoryBytes: GB / 2,
    lastChange: { kind: 'deploy', id: ID(90), at: ago(2 * HOUR), state: 'succeeded', sha: SHA, digest: null },
    ...overrides,
  };
}

function chip(project: string, overrides: Partial<ProjectChip> = {}): ProjectChip {
  return { project, tier: 'observed', containers: 2, running: 2, failing: 0, ...overrides };
}

function work(kind: OverviewWork['kind'], n: number, overrides: Partial<OverviewWork> = {}): OverviewWork {
  return { kind, id: ID(n), subject: 'bindery', label: 'abcdef0', state: 'running', at: ago(3 * MIN), ...overrides };
}

const POSTROOM_INCIDENT: IncidentBanner = {
  owner: { kind: 'app', name: 'postroom' },
  tier: 'shipped',
  containers: [
    { id: CID('a'), name: 'postroom-smtp-1', condition: 'unhealthy', state: 'running', health: 'unhealthy', restartCount: 3, failingSince: ago(40 * MIN) },
    { id: CID('b'), name: 'postroom-imap-1', condition: 'restarting', state: 'restarting', health: 'none', restartCount: 1, failingSince: ago(10 * MIN) },
  ],
  since: ago(40 * MIN),
  lastChange: { kind: 'deploy', id: ID(91), at: ago(HOUR), state: 'succeeded', sha: SHA, digest: null },
};

const IMMICH_INCIDENT: IncidentBanner = {
  owner: { kind: 'stack', name: 'immich' },
  tier: 'operated',
  containers: [{ id: CID('c'), name: 'immich-server-1', condition: 'restarting', state: 'restarting', health: 'none', restartCount: 0, failingSince: ago(5 * MIN) }],
  since: ago(5 * MIN),
  lastChange: null,
};

function fixture(overrides: Partial<Overview> = {}): Overview {
  return OverviewSchema.parse({
    generatedAt: ago(0),
    hostReportedAt: ago(12_000),
    runs: {
      deployedApps: 5,
      operatedStacks: 1,
      observedProjects: 2,
      containers: 88,
      running: 86,
      failing: 3,
      cpuPercent: 80,
      memoryBytes: Math.round(3.2 * GB),
      disk: { dataRoot: { path: '/DATA', freeBytes: 875 * GB, totalBytes: 904 * GB }, dockerRoot: null },
    },
    now: [work('deploy', 1, { subject: 'bindery', label: 'abcdef0', state: 'soaking' }), work('action', 2, { subject: 'forgejo', label: 'restart', state: 'running' })],
    last24h: {
      deploys: { succeeded: 2, failed: 0, rolledBack: 1 },
      stackUpdates: { succeeded: 0, failed: 0 },
      actions: 2,
      backups: { succeeded: 4, failed: 0 },
      recent: [work('build', 3, { subject: 'www', label: '1234567', state: 'succeeded', at: ago(HOUR) }), work('deploy', 4, { subject: 'foreman', state: 'rolled_back', at: ago(5 * HOUR) })],
    },
    apps: [tile('bindery'), tile('d3auth'), tile('docs'), tile('foreman'), tile('postroom', { health: 'unhealthy', failing: 2 }), tile('www')],
    projects: [chip('forgejo'), chip('immich', { tier: 'operated', failing: 1, running: 1 })],
    incidents: [POSTROOM_INCIDENT, IMMICH_INCIDENT],
    ...overrides,
  });
}

function routes(overview: Reply | Reply[]): Record<string, Reply | Reply[]> {
  return {
    'GET /api/auth/me': meReply('viewer'),
    'GET /api/apps': { status: 200, body: { apps: [] } },
    'GET /api/approvals': { status: 200, body: [] },
    'GET /api/agent': { status: 200, body: [] },
    'GET /api/overview': overview,
  };
}

async function renderOverview() {
  window.history.replaceState(null, '', '/overview');
  render(<App />);
  await screen.findByRole('heading', { level: 1, name: 'Overview' });
}

function section(name: string): HTMLElement {
  const heading = screen.getByRole('heading', { level: 2, name });
  const region = heading.closest('section');
  if (region === null) throw new Error(`no section for ${name}`);
  return region;
}

describe('the pure helpers', () => {
  it('says load as cores and memory in GB', () => {
    expect(coresWords(80)).toBe('0.8');
    expect(coresWords(250)).toBe('2.5');
    expect(coresWords(null)).toBe('—');
    expect(gbWords(Math.round(3.2 * GB))).toBe('3.2 GB');
    expect(gbWords(null)).toBe('—');
    expect(cpuPercentWords(2.44)).toBe('2.4%');
  });

  it('says the host freshness in the header', () => {
    const o = fixture();
    expect(freshnessWords(o, NOW)).toBe('This host · 88 containers · agent 12 s ago');
    expect(freshnessWords({ ...o, hostReportedAt: null }, NOW)).toBe('This host · 88 containers · no agent has reported yet');
  });

  it('writes a banner: headline, one line per container, the oldest first button, the owner button', () => {
    expect(incidentHeadline(POSTROOM_INCIDENT)).toBe('postroom is degraded');
    expect(incidentHeadline(IMMICH_INCIDENT)).toBe('immich is degraded');
    const [smtp, imap] = POSTROOM_INCIDENT.containers;
    if (smtp === undefined || imap === undefined) throw new Error('fixture');
    expect(incidentContainerLine(smtp, NOW)).toBe(`postroom-smtp-1 unhealthy since ${clockTime(smtp.failingSince)} · restarted 3 times`);
    expect(incidentContainerLine(imap, NOW)).toBe(`postroom-imap-1 restarting since ${clockTime(imap.failingSince)} · restarted once`);
    expect(incidentContainerLine({ ...smtp, restartCount: 0 }, NOW)).toBe(`postroom-smtp-1 unhealthy since ${clockTime(smtp.failingSince)}`);
    // Out of order on the wire, the button still names the one failing longest.
    expect(oldestContainer({ containers: [imap, smtp] })?.name).toBe('postroom-smtp-1');
    expect(containerHref(CID('a'))).toBe(`/host?container=${CID('a')}`);
    expect(ownerHref(POSTROOM_INCIDENT.owner)).toBe('/apps/postroom');
    expect(ownerHref(IMMICH_INCIDENT.owner)).toBe('/host?tier=operated&stack=immich');
    expect(ownerButtonWords(POSTROOM_INCIDENT.owner)).toBe('postroom app');
    expect(ownerButtonWords(IMMICH_INCIDENT.owner)).toBe('immich stack');
  });

  it('states the last change before or after the failure began', () => {
    const since = ago(40 * MIN);
    const deploy = { kind: 'deploy' as const, id: ID(1), state: 'succeeded', sha: SHA, digest: null };
    expect(lastChangeSentence({ ...deploy, at: ago(HOUR) }, 'app', since, NOW)).toBe('Last deploy abcdef0 succeeded 1 h ago — before it began failing');
    expect(lastChangeSentence({ ...deploy, at: ago(10 * MIN), state: 'rolled_back' }, 'app', since, NOW)).toBe(
      'Last deploy abcdef0 rolled back 10 min ago — after it began failing',
    );
    const update = { kind: 'stack-update' as const, id: ID(2), at: ago(2 * HOUR), state: 'succeeded', sha: null, digest: `sha256:${'f'.repeat(64)}` };
    expect(lastChangeSentence(update, 'stack', since, NOW)).toBe('Last update ffffffffffff succeeded 2 h ago — before it began failing');
    expect(lastChangeSentence(null, 'app', since, NOW)).toBe('No deploy since Shipyard started recording');
    expect(lastChangeSentence(null, 'stack', since, NOW)).toBe('No update since Shipyard started recording');
  });

  it('says the last 24 hours as one short sentence', () => {
    expect(last24hSentence(fixture().last24h)).toBe('3 deploys · 1 rolled back · 4 backups · 2 actions');
    expect(
      last24hSentence({ deploys: { succeeded: 1, failed: 1, rolledBack: 0 }, stackUpdates: { succeeded: 0, failed: 1 }, actions: 0, backups: { succeeded: 0, failed: 1 } }),
    ).toBe('2 deploys · 1 failed · 1 stack update · 1 update failed · 1 backup · 1 backup failed');
    expect(last24hSentence({ deploys: { succeeded: 0, failed: 0, rolledBack: 0 }, stackUpdates: { succeeded: 0, failed: 0 }, actions: 0, backups: { succeeded: 0, failed: 0 } })).toBe(
      'Nothing finished in the last 24 hours.',
    );
  });

  it('links work to its own page, or to Activity', () => {
    expect(workHref({ kind: 'deploy', id: ID(1) })).toBe(`/deploys/${ID(1)}`);
    expect(workHref({ kind: 'build', id: ID(2) })).toBe(`/builds/${ID(2)}`);
    expect(workHref({ kind: 'stack-update', id: ID(3) })).toBe('/activity');
    expect(workHref({ kind: 'action', id: ID(4) })).toBe('/activity');
    expect(workHref({ kind: 'maintenance', id: ID(5) })).toBe('/activity');
  });

  it('folds healthy tiles after the first three on a phone, keeping every other tile and the order', () => {
    const tiles = fixture().apps;
    const { shown, folded } = collapseTiles(tiles);
    expect(shown.map((t) => t.name)).toEqual(['bindery', 'd3auth', 'docs', 'postroom']);
    expect(folded.map((t) => t.name)).toEqual(['foreman', 'www']);
    expect(collapseTiles(tiles.slice(0, 2)).folded).toEqual([]);
    expect(appsHealthy(tiles)).toEqual({ healthy: 5, total: 6 });
  });

  it('says a tile last change and the quiet projects line', () => {
    expect(tileChangeWords(tile('x').lastChange, NOW)).toBe('abcdef0 · 2 h ago');
    expect(tileChangeWords(null, NOW)).toBe('No deploy yet');
    expect(projectsSummary([chip('a'), chip('b')])).toBe('2 observed stacks, all running');
    expect(projectsSummary([chip('a', { tier: 'operated' }), chip('b'), chip('c', { running: 1 })])).toBe('1 operated and 2 observed stacks, 1 container not running');
    expect(projectsSummary([chip('a', { tier: 'operated' })])).toBe('1 operated stack, all running');
  });
});

describe('the Overview screen', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders every section from the answer', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const calls = mockFetch(routes({ status: 200, body: fixture() }));
    await renderOverview();
    expect(await screen.findByText('This host · 88 containers · agent 12 s ago')).toBeInTheDocument();
    expect(screen.queryByText(/the agent may be down/)).not.toBeInTheDocument();

    const stats = screen.getByRole('group', { name: 'What runs' });
    expect(within(stats).getByText('of 6 healthy')).toBeInTheDocument();
    expect(within(stats).getByText('of 88 running')).toBeInTheDocument();
    expect(within(stats).getByText('3 failing')).toBeInTheDocument();
    expect(within(stats).getByText(/0\.8 of the host's CPU and 3\.2 GB of memory in containers\./)).toBeInTheDocument();
    expect(within(stats).getByText('Load average lives in Grafana.')).toBeInTheDocument();
    expect(within(stats).getByText('of 904.0 GB on /DATA')).toBeInTheDocument();

    const now = within(section('Happening now')).getByRole('list', { name: 'Happening now' });
    expect(within(now).getAllByRole('listitem')).toHaveLength(2);
    expect(within(now).getByRole('link', { name: 'bindery' })).toHaveAttribute('href', `/deploys/${ID(1)}`);
    expect(within(now).getByRole('link', { name: 'forgejo' })).toHaveAttribute('href', '/activity');
    expect(within(now).getByText('Soaking')).toBeInTheDocument();

    const last = section('Last 24 h');
    expect(within(last).getByText('3 deploys · 1 rolled back · 4 backups · 2 actions')).toBeInTheDocument();
    const recent = within(last).getByRole('list', { name: 'Last 24 hours' });
    expect(within(recent).getByRole('link', { name: 'www' })).toHaveAttribute('href', `/builds/${ID(3)}`);
    expect(within(recent).getByText('Rolled back')).toBeInTheDocument();

    const tiles = within(section('Apps on this host')).getByRole('list', { name: 'Deployed apps' });
    expect(within(tiles).getAllByRole('listitem')).toHaveLength(6);
    expect(within(tiles).getByRole('link', { name: 'postroom' })).toHaveAttribute('href', '/apps/postroom');
    const postroom = within(tiles).getByRole('link', { name: 'postroom' }).closest('li');
    expect(postroom).toHaveAttribute('data-failing', 'true');
    expect(within(postroom as HTMLElement).getByText('Unhealthy')).toBeInTheDocument();
    expect(within(tiles).getAllByText('abcdef0 · 2 h ago').length).toBe(6);
    // The phone's fold line names the healthy tiles past the first three.
    expect(screen.getByText('2 more healthy')).toBeInTheDocument();

    const chips = within(section('Everything else')).getByRole('list', { name: 'Other compose projects' });
    expect(within(chips).getAllByRole('listitem')).toHaveLength(2);
    expect(within(chips).getByText('Operated')).toBeInTheDocument();
    expect(within(chips).getByText('Observed')).toBeInTheDocument();
    expect(within(chips).getByText('1 failing')).toBeInTheDocument();

    // Needs you is empty here: one quiet line, no section.
    expect(screen.getByText('Nothing needs you.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^Needs you/ })).not.toBeInTheDocument();

    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('shows one banner per incident with both buttons and their addresses', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    mockFetch(routes({ status: 200, body: fixture() }));
    await renderOverview();
    const incidents = await screen.findByRole('group', { name: 'Incidents' });
    const banners = within(incidents).getAllByText(/ is degraded$/);
    expect(banners.map((b) => b.textContent)).toEqual(['postroom is degraded', 'immich is degraded']);

    expect(within(incidents).getByText(`postroom-smtp-1 unhealthy since ${clockTime(ago(40 * MIN))} · restarted 3 times`)).toBeInTheDocument();
    expect(within(incidents).getByText(`postroom-imap-1 restarting since ${clockTime(ago(10 * MIN))} · restarted once`)).toBeInTheDocument();
    expect(within(incidents).getByText('Last deploy abcdef0 succeeded 1 h ago — before it began failing')).toBeInTheDocument();
    expect(within(incidents).getByText('No update since Shipyard started recording')).toBeInTheDocument();

    expect(within(incidents).getByRole('link', { name: 'Open postroom-smtp-1' })).toHaveAttribute('href', `/host?container=${CID('a')}`);
    expect(within(incidents).queryByRole('link', { name: 'Open postroom-imap-1' })).not.toBeInTheDocument();
    expect(within(incidents).getByRole('link', { name: 'postroom app' })).toHaveAttribute('href', '/apps/postroom');
    expect(within(incidents).getByRole('link', { name: 'Open immich-server-1' })).toHaveAttribute('href', `/host?container=${CID('c')}`);
    expect(within(incidents).getByRole('link', { name: 'immich stack' })).toHaveAttribute('href', '/host?tier=operated&stack=immich');
    // Present on the first answer: static, so a screen reader is not interrupted by it.
    expect(within(incidents).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('opens the app page from a banner', async () => {
    mockFetch({ ...routes({ status: 200, body: fixture() }), 'GET /api/apps/postroom': { status: 404, body: { error: { code: 'not_found', gate: 'none', message: 'No app postroom.', fix: 'Check the name.' } } } });
    await renderOverview();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: 'postroom app' }));
    expect(window.location.pathname).toBe('/apps/postroom');
  });

  it('says so when nothing is happening, nothing deploys and nothing else runs', async () => {
    const empty = fixture({
      now: [],
      apps: [],
      projects: [],
      incidents: [],
      last24h: { deploys: { succeeded: 0, failed: 0, rolledBack: 0 }, stackUpdates: { succeeded: 0, failed: 0 }, actions: 0, backups: { succeeded: 0, failed: 0 }, recent: [] },
    });
    mockFetch(routes({ status: 200, body: empty }));
    await renderOverview();
    expect(await screen.findByText('Nothing is running right now.')).toBeInTheDocument();
    expect(screen.getByText('Nothing finished in the last 24 hours.')).toBeInTheDocument();
    expect(screen.getByText('Shipyard deploys no apps on this host yet.')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Incidents' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Everything else' })).not.toBeInTheDocument();
  });

  it('points to Settings › Host when no agent has reported', async () => {
    mockFetch(routes({ status: 200, body: fixture({ hostReportedAt: null, incidents: [], apps: [], projects: [] }) }));
    await renderOverview();
    expect(await screen.findByRole('heading', { level: 2, name: 'No host inventory yet' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Settings › Host' })).toHaveAttribute('href', '/settings/host');
    expect(screen.queryByRole('group', { name: 'What runs' })).not.toBeInTheDocument();
  });

  it('warns when the agent report is stale', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    mockFetch(routes({ status: 200, body: fixture({ hostReportedAt: ago(10 * MIN) }) }));
    await renderOverview();
    expect(await screen.findByText('Last reported 10 min ago — the agent may be down.')).toBeInTheDocument();
  });

  it('shows the refusal and retries when the first read fails', async () => {
    const refusal: Reply = { status: 503, body: { error: { code: 'internal', gate: 'none', message: 'Shipyard could not read its records.', fix: 'Check the server logs.' } } };
    mockFetch(routes([refusal, { status: 200, body: fixture() }]));
    await renderOverview();
    expect(await screen.findByText('Shipyard could not read its records.')).toBeInTheDocument();
    expect(screen.getByText('Check the server logs.')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('group', { name: 'What runs' })).toBeInTheDocument();
    expect(screen.queryByText('Shipyard could not read its records.')).not.toBeInTheDocument();
  });

  it('keeps the last answer on screen when a later read fails, and announces a new banner', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const refusal: Reply = { status: 503, body: { error: { code: 'internal', gate: 'none', message: 'Down.', fix: 'Wait.' } } };
    mockFetch(routes([{ status: 200, body: fixture({ incidents: [] }) }, refusal, { status: 200, body: fixture({ incidents: [IMMICH_INCIDENT] }) }]));
    await renderOverview();
    expect(await screen.findByRole('group', { name: 'What runs' })).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.getByRole('group', { name: 'What runs' })).toBeInTheDocument();
    expect(screen.queryByText('Down.')).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('immich is degraded');
  });
});

describe('Needs you on Overview', () => {
  it('shows the same list Apps shows, as its own section', async () => {
    const app = { name: 'd3auth', repo: 'matdemers1/d3auth', liveSha: 'a'.repeat(40), reportedAt: new Date().toISOString(), drift: null, approvalPolicy: 'required', active: null };
    const approval = {
      deployId: ID(70),
      kind: 'deploy',
      app: 'd3auth',
      sha: 'b'.repeat(40),
      requester: { label: 'user matthew', repo: null, branch: null },
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    mockFetch({
      ...routes({ status: 200, body: fixture() }),
      'GET /api/apps': { status: 200, body: { apps: [app] } },
      'GET /api/approvals': { status: 200, body: [approval] },
      'GET /api/apps/d3auth/commits': { status: 200, body: { live: 'a'.repeat(40), head: 'a'.repeat(40), commits: [], newestGreen: null, source: 'github' } },
    });
    await renderOverview();
    expect(await screen.findByRole('heading', { level: 2, name: 'Needs you (1)' })).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Needs you' })).getByText('d3auth')).toBeInTheDocument();
    expect(screen.queryByText('Nothing needs you.')).not.toBeInTheDocument();
  });
});
