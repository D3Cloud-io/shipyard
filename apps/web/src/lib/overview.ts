// Types only: a runtime import of the schema package would put zod and every schema in the bundle.
import type { StatusDotTone } from '@d3cloud/ui';
import type { AppTile, IncidentBanner, IncidentContainer, LastChange, Overview, OverviewLast24h, OverviewWork, ProjectChip } from '@shipyard/schema';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RefusalError, request, unreachableRefusal } from './api';
import { sha7 } from './appstatus';
import { clockTime, dateTime } from './deploy';
import { HOST_POLL_MS, ageWords } from './host';
import { stateWords } from './words';

/**
 * Overview's data and words (SHP-T-19.6, SHP-REQ-207, SHP-REQ-209, SHP-ADR-013): state first, then
 * what is wrong. The one call is `GET /api/overview`; Needs you comes from the shell's shared store
 * as it does on Apps, so the list and the nav badge cannot disagree.
 *
 * Everything below the hook is pure, so the banner lines, the last-change sentence, the load and
 * memory words and the phone's tile collapse are unit-tested without rendering.
 */

export const overview = {
  read: (): Promise<Overview> => request<Overview>('/api/overview'),
};

// ── Data ─────────────────────────────────────────────────────────────────

export interface OverviewData {
  status: 'loading' | 'ready' | 'error';
  overview: Overview | null;
  error: RefusalError | null;
  /** When the screen last looked at the clock: each read, so a stale report is noticed. */
  now: number;
  /** Reads again now: the error state's Retry. */
  reload: () => void;
}

/**
 * Reads `/api/overview` on mount, then every 30 s while the page is visible, the way Host reads
 * (`useHost`); stops while hidden and reads the moment it is shown. A failed read after a good one
 * keeps the last answer on screen — its age says how old it is — rather than blanking the page.
 */
export function useOverview(): OverviewData {
  const [data, setData] = useState<Omit<OverviewData, 'reload'>>({ status: 'loading', overview: null, error: null, now: Date.now() });
  const generation = useRef(0);

  const load = useCallback(async () => {
    const gen = ++generation.current;
    try {
      const res = await overview.read();
      if (gen !== generation.current) return;
      setData({ status: 'ready', overview: res, error: null, now: Date.now() });
    } catch (err) {
      if (gen !== generation.current) return;
      const error = err instanceof RefusalError ? err : unreachableRefusal();
      setData((prev) => (prev.status === 'ready' ? { ...prev, now: Date.now() } : { status: 'error', overview: null, error, now: Date.now() }));
    }
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
    const start = () => {
      if (timer !== undefined) return;
      timer = setInterval(() => {
        void load();
      }, HOST_POLL_MS);
    };
    const stop = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => {
      if (visible()) {
        void load();
        start();
      } else stop();
    };
    void load();
    if (visible()) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      // A read still in flight lands on an unmounted screen otherwise.
      generation.current += 1;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [load]);

  const reload = useCallback(() => {
    setData((prev) => (prev.status === 'error' ? { ...prev, status: 'loading' } : prev));
    void load();
  }, [load]);

  return { ...data, reload };
}

// ── Small words ──────────────────────────────────────────────────────────

function plural(n: number, one: string, many = `${one}s`): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

const GB = 1024 * 1024 * 1024;

/** CPU as cores (100 = one core): "0.8". A dash with no samples. */
export function coresWords(cpuPercent: number | null): string {
  return cpuPercent === null ? '—' : (cpuPercent / 100).toFixed(1);
}

/** Memory in GB, one decimal: "3.2 GB". A dash with no samples. */
export function gbWords(bytes: number | null): string {
  return bytes === null ? '—' : `${(bytes / GB).toFixed(1)} GB`;
}

/** A tile's CPU as a percent of one core: "2.4%". */
export function cpuPercentWords(cpuPercent: number | null): string {
  return cpuPercent === null ? '—' : `${cpuPercent.toFixed(1)}%`;
}

/** The header line: "This host · 88 containers · agent 12 s ago". */
export function freshnessWords(o: Pick<Overview, 'hostReportedAt' | 'runs'>, now: number): string {
  const containers = plural(o.runs.containers, 'container');
  if (o.hostReportedAt === null) return `This host · ${containers} · no agent has reported yet`;
  return `This host · ${containers} · agent ${ageWords(o.hostReportedAt, now)} ago`;
}

/** A clock time today, a date and time before that: when a failure began. */
export function sinceWords(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  return now - at < 24 * 3_600_000 ? clockTime(iso) : dateTime(iso);
}

// ── Incident banners ─────────────────────────────────────────────────────

/** "postroom is degraded": an Operated stack is said the same way. */
export function incidentHeadline(banner: Pick<IncidentBanner, 'owner'>): string {
  return `${banner.owner.name} is degraded`;
}

/** "postroom-server-1 unhealthy since 2:14 PM · restarted 3 times". */
export function incidentContainerLine(c: Pick<IncidentContainer, 'name' | 'condition' | 'restartCount' | 'failingSince'>, now: number): string {
  const restarts = c.restartCount === 0 ? '' : ` · restarted ${c.restartCount === 1 ? 'once' : `${String(c.restartCount)} times`}`;
  return `${c.name} ${c.condition} since ${sinceWords(c.failingSince, now)}${restarts}`;
}

function lowerFirst(words: string): string {
  return words === '' ? words : `${words.charAt(0).toLowerCase()}${words.slice(1)}`;
}

/** A digest's first twelve hex characters, the way a person reads one. */
function shortDigest(digest: string): string {
  return digest.replace(/^sha256:/, '').slice(0, 12);
}

/**
 * The owner's last change, stated against the incident: "Last deploy a1b2c3d succeeded 2 h ago —
 * before it began failing". A stack says "Last update"; none says nothing was recorded.
 */
export function lastChangeSentence(lastChange: LastChange | null, ownerKind: 'app' | 'stack', since: string, now: number): string {
  if (lastChange === null) {
    return ownerKind === 'app' ? 'No deploy since Shipyard started recording' : 'No update since Shipyard started recording';
  }
  const noun = lastChange.kind === 'deploy' ? 'Last deploy' : 'Last update';
  const id = lastChange.sha !== null ? ` ${sha7(lastChange.sha)}` : lastChange.digest !== null ? ` ${shortDigest(lastChange.digest)}` : '';
  const state = lowerFirst(stateWords(lastChange.state));
  const order = Date.parse(lastChange.at) <= Date.parse(since) ? 'before' : 'after';
  return `${noun}${id} ${state} ${ageWords(lastChange.at, now)} ago — ${order} it began failing`;
}

/** The container a banner's first button opens: the one failing longest (the list is oldest first). */
export function oldestContainer(banner: Pick<IncidentBanner, 'containers'>): IncidentContainer | undefined {
  return [...banner.containers].sort((a, b) => Date.parse(a.failingSince) - Date.parse(b.failingSince))[0];
}

/** Where a container's sheet opens on Host. */
export function containerHref(id: string): string {
  return `/host?container=${encodeURIComponent(id)}`;
}

/** The owner's own page: an app's page, or the stack's sheet among the Operated stacks on Host. */
export function ownerHref(owner: IncidentBanner['owner']): string {
  return owner.kind === 'app' ? `/apps/${encodeURIComponent(owner.name)}` : `/host?tier=operated&stack=${encodeURIComponent(owner.name)}`;
}

/** The second button: "postroom app", or "immich stack". */
export function ownerButtonWords(owner: IncidentBanner['owner']): string {
  return `${owner.name} ${owner.kind === 'app' ? 'app' : 'stack'}`;
}

/** A banner's identity across reads: its owner. */
export function incidentKey(banner: Pick<IncidentBanner, 'owner'>): string {
  return `${banner.owner.kind}:${banner.owner.name}`;
}

// ── Work rows ────────────────────────────────────────────────────────────

export const WORK_KIND_WORDS: Record<OverviewWork['kind'], string> = {
  deploy: 'Deploy',
  'stack-update': 'Stack update',
  action: 'Action',
  maintenance: 'Maintenance',
  build: 'Build',
};

/** Where a row of work opens: its deploy or build page, or Activity for the rest. */
export function workHref(work: Pick<OverviewWork, 'kind' | 'id'>): string {
  if (work.kind === 'deploy') return `/deploys/${encodeURIComponent(work.id)}`;
  if (work.kind === 'build') return `/builds/${encodeURIComponent(work.id)}`;
  return '/activity';
}

const BAD_STATES = new Set(['failed', 'rolled_back', 'refused', 'failure']);

export function workTone(state: string): 'danger' | 'neutral' {
  return BAD_STATES.has(state) ? 'danger' : 'neutral';
}

export function workStateWords(state: string): string {
  return stateWords(state);
}

// ── Last 24 hours ────────────────────────────────────────────────────────

/** "3 deploys · 1 rolled back · 4 backups · 2 actions"; every part with nothing in it is left out. */
export function last24hSentence(l: Pick<OverviewLast24h, 'deploys' | 'stackUpdates' | 'actions' | 'backups'>): string {
  const parts: string[] = [];
  const deploys = l.deploys.succeeded + l.deploys.failed + l.deploys.rolledBack;
  if (deploys > 0) parts.push(plural(deploys, 'deploy'));
  if (l.deploys.failed > 0) parts.push(`${String(l.deploys.failed)} failed`);
  if (l.deploys.rolledBack > 0) parts.push(`${String(l.deploys.rolledBack)} rolled back`);
  const updates = l.stackUpdates.succeeded + l.stackUpdates.failed;
  if (updates > 0) parts.push(plural(updates, 'stack update'));
  if (l.stackUpdates.failed > 0) parts.push(`${String(l.stackUpdates.failed)} ${l.stackUpdates.failed === 1 ? 'update' : 'updates'} failed`);
  const backups = l.backups.succeeded + l.backups.failed;
  if (backups > 0) parts.push(plural(backups, 'backup'));
  if (l.backups.failed > 0) parts.push(`${String(l.backups.failed)} ${l.backups.failed === 1 ? 'backup' : 'backups'} failed`);
  if (l.actions > 0) parts.push(plural(l.actions, 'action'));
  return parts.length === 0 ? 'Nothing finished in the last 24 hours.' : parts.join(' · ');
}

// ── App tiles ────────────────────────────────────────────────────────────

export const TILE_HEALTH: Record<AppTile['health'], { words: string; tone: StatusDotTone }> = {
  healthy: { words: 'Healthy', tone: 'neutral' },
  unhealthy: { words: 'Unhealthy', tone: 'danger' },
  starting: { words: 'Starting', tone: 'warning' },
  stopped: { words: 'Stopped', tone: 'idle' },
  unknown: { words: 'Not reported', tone: 'idle' },
};

/** A tile shows danger when its health says so or a container of it is failing. */
export function tileFailing(tile: Pick<AppTile, 'health' | 'failing'>): boolean {
  return tile.health === 'unhealthy' || tile.failing > 0;
}

/** "a1b2c3d · 2 h ago", or that nothing was deployed. */
export function tileChangeWords(lastChange: LastChange | null, now: number): string {
  if (lastChange === null) return 'No deploy yet';
  const id = lastChange.sha !== null ? sha7(lastChange.sha) : lastChange.digest !== null ? shortDigest(lastChange.digest) : lowerFirst(stateWords(lastChange.state));
  return `${id} · ${ageWords(lastChange.at, now)} ago`;
}

/** How many healthy tiles a phone shows before "N more healthy". */
export const PHONE_HEALTHY_TILES = 3;

/**
 * The phone's tiles: every tile that is not healthy, and the first few healthy ones; the rest of
 * the healthy ones fold into one line. Order is kept, so a refresh never moves a tile.
 */
export function collapseTiles<T extends Pick<AppTile, 'name' | 'health' | 'failing'>>(tiles: readonly T[], keep = PHONE_HEALTHY_TILES): { shown: T[]; folded: T[] } {
  const shown: T[] = [];
  const folded: T[] = [];
  let healthy = 0;
  for (const tile of tiles) {
    if (tile.health === 'healthy' && tile.failing === 0) {
      healthy += 1;
      if (healthy > keep) {
        folded.push(tile);
        continue;
      }
    }
    shown.push(tile);
  }
  return { shown, folded };
}

/** "4 more healthy". */
export function foldedWords(count: number): string {
  return `${String(count)} more healthy`;
}

// ── Project chips ────────────────────────────────────────────────────────

export function chipFailing(chip: Pick<ProjectChip, 'failing'>): boolean {
  return chip.failing > 0;
}

/**
 * The phone's one line for every other compose project while none fails: "12 observed stacks, all
 * running", or "2 operated and 10 observed stacks, 1 container not running".
 */
export function projectsSummary(chips: readonly Pick<ProjectChip, 'tier' | 'containers' | 'running'>[]): string {
  const operated = chips.filter((c) => c.tier === 'operated').length;
  const observed = chips.length - operated;
  const noun = chips.length === 1 ? 'stack' : 'stacks';
  const counts =
    operated > 0 && observed > 0
      ? `${String(operated)} operated and ${String(observed)} observed ${noun}`
      : operated > 0
        ? `${String(operated)} operated ${noun}`
        : `${String(observed)} observed ${noun}`;
  const notRunning = chips.reduce((sum, c) => sum + Math.max(0, c.containers - c.running), 0);
  return notRunning === 0 ? `${counts}, all running` : `${counts}, ${plural(notRunning, 'container')} not running`;
}

// ── What runs ────────────────────────────────────────────────────────────

/** "4 of 5 healthy": the Deployed apps whose tile says healthy. */
export function appsHealthy(tiles: readonly Pick<AppTile, 'health' | 'failing'>[]): { healthy: number; total: number } {
  return { healthy: tiles.filter((t) => t.health === 'healthy' && t.failing === 0).length, total: tiles.length };
}
