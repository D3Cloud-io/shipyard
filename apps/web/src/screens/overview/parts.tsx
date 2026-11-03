import { Badge, Link, Stat, StatGroup, StatusDot } from '@d3cloud/ui';
import type { AppTile, OverviewRuns, OverviewWork, ProjectChip } from '@shipyard/schema';
import { Link as RouterLink } from 'react-router-dom';
import { ageWords, bytesWords } from '../../lib/host';
import {
  TILE_HEALTH,
  WORK_KIND_WORDS,
  appsHealthy,
  chipFailing,
  collapseTiles,
  coresWords,
  cpuPercentWords,
  foldedWords,
  gbWords,
  projectsSummary,
  tileChangeWords,
  tileFailing,
  workHref,
  workStateWords,
  workTone,
} from '../../lib/overview';
import { TIER_WORDS } from '../../lib/words';

/**
 * Overview's pieces (SHP-T-19.6, SHP-REQ-207): the What runs cards, a list of work (Happening now,
 * Last 24 h), the Deployed apps' health tiles and the other compose projects' chips. Words come
 * from lib/overview.ts, so every sentence here is unit-tested without rendering.
 */

// ── What runs ────────────────────────────────────────────────────────────

export function RunsStats({ runs, tiles }: { runs: OverviewRuns; tiles: readonly AppTile[] }) {
  const apps = appsHealthy(tiles);
  const disk = runs.disk?.dataRoot ?? null;
  return (
    <StatGroup role="group" aria-label="What runs" className="shp-ov-stats">
      <Stat
        label="Apps"
        value={String(apps.healthy)}
        unit={`of ${String(apps.total)} healthy`}
        footnote={`${String(runs.operatedStacks)} operated ${runs.operatedStacks === 1 ? 'stack' : 'stacks'} · ${String(runs.observedProjects)} observed`}
      />
      <Stat
        label="Containers"
        value={String(runs.running)}
        unit={`of ${String(runs.containers)} running`}
        footnote={
          runs.failing > 0 ? (
            <Badge size="sm" tone="danger">
              {`${String(runs.failing)} failing`}
            </Badge>
          ) : (
            'None failing'
          )
        }
      />
      <Stat
        label="Load"
        value={coresWords(runs.cpuPercent)}
        unit="cores"
        footnote={
          <>
            {`${coresWords(runs.cpuPercent)} of the host's CPU and ${gbWords(runs.memoryBytes)} of memory in containers.`}{' '}
            <span className="shp-ov-muted">Load average lives in Grafana.</span>
          </>
        }
      />
      <Stat
        label="Disk"
        value={disk === null ? '—' : bytesWords(disk.freeBytes)}
        {...(disk === null ? {} : { unit: 'free' })}
        footnote={disk === null ? 'No agent has reported the disk yet.' : `of ${bytesWords(disk.totalBytes)} on ${disk.path}`}
      />
    </StatGroup>
  );
}

// ── Work ─────────────────────────────────────────────────────────────────

export function WorkList({ items, label, now }: { items: readonly OverviewWork[]; label: string; now: number }) {
  return (
    <ul className="shp-ov-work" aria-label={label}>
      {items.map((work) => (
        <li key={`${work.kind}:${work.id}`} className="shp-ov-work__row">
          <Badge size="sm" tone="neutral" className="shp-ov-work__kind">
            {WORK_KIND_WORDS[work.kind]}
          </Badge>
          <span className="shp-ov-work__what">
            <Link asChild className="shp-ov-work__link">
              <RouterLink to={workHref(work)}>{work.subject ?? 'Host'}</RouterLink>
            </Link>
            <span className="shp-ov-work__label">{work.label}</span>
          </span>
          <span className="shp-ov-work__meta">
            <Badge size="sm" tone={workTone(work.state)}>
              {workStateWords(work.state)}
            </Badge>
            <span className="shp-ov-work__age">{`${ageWords(work.at, now)} ago`}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

// ── App tiles ────────────────────────────────────────────────────────────

function Tile({ tile, now, folded }: { tile: AppTile; now: number; folded: boolean }) {
  const health = TILE_HEALTH[tile.health];
  const failing = tileFailing(tile);
  return (
    <li className="shp-ov-tile" data-failing={failing ? 'true' : undefined} data-folded={folded ? 'true' : undefined}>
      <span className="shp-ov-tile__head">
        <Link asChild className="shp-ov-tile__name">
          <RouterLink to={`/apps/${encodeURIComponent(tile.name)}`}>{tile.name}</RouterLink>
        </Link>
        <StatusDot tone={failing ? 'danger' : health.tone} size="sm">
          {health.words}
        </StatusDot>
      </span>
      <span className="shp-ov-tile__line">
        {`${String(tile.running)}/${String(tile.containers)} running`}
        {tile.failing > 0 ? ` · ${String(tile.failing)} failing` : ''}
      </span>
      <span className="shp-ov-tile__line shp-ov-muted">{`${cpuPercentWords(tile.cpuPercent)} CPU · ${gbWords(tile.memoryBytes)}`}</span>
      <span className="shp-ov-tile__line shp-ov-muted">{tileChangeWords(tile.lastChange, now)}</span>
    </li>
  );
}

/**
 * Every Deployed app as a tile. On a phone the healthy tiles after the first few fold into one
 * line naming them (P1); the fold is CSS, so the desktop grid shows every tile and nothing moves.
 */
export function AppTiles({ tiles, now, label }: { tiles: readonly AppTile[]; now: number; label: string }) {
  const { folded } = collapseTiles(tiles);
  const foldedNames = new Set(folded.map((t) => t.name));
  return (
    <>
      <ul className="shp-ov-tiles" aria-label={label}>
        {tiles.map((tile) => (
          <Tile key={tile.name} tile={tile} now={now} folded={foldedNames.has(tile.name)} />
        ))}
      </ul>
      {folded.length === 0 ? null : (
        <p className="shp-ov-folded">
          <span className="shp-ov-folded__count">{foldedWords(folded.length)}</span>{' '}
          {folded.map((t, i) => (
            <span key={t.name}>
              {i === 0 ? '' : ', '}
              <Link asChild>
                <RouterLink to={`/apps/${encodeURIComponent(t.name)}`}>{t.name}</RouterLink>
              </Link>
            </span>
          ))}
        </p>
      )}
    </>
  );
}

// ── Project chips ────────────────────────────────────────────────────────

/**
 * One chip per other compose project. On a phone, while none fails, they fold into one line
 * ("12 observed stacks, all running"); one failing keeps every chip on screen.
 */
export function ProjectChips({ chips }: { chips: readonly ProjectChip[] }) {
  const anyFailing = chips.some(chipFailing);
  return (
    <div className="shp-ov-chips" data-quiet={anyFailing ? undefined : 'true'}>
      {anyFailing ? null : <p className="shp-ov-chips__summary">{projectsSummary(chips)}</p>}
      <ul className="shp-ov-chips__list" aria-label="Other compose projects">
        {chips.map((chip) => (
          <li key={chip.project} className="shp-ov-chip" data-failing={chipFailing(chip) ? 'true' : undefined}>
            <span className="shp-ov-chip__name">{chip.project}</span>
            <span className="shp-ov-chip__count">{` · ${String(chip.running)}/${String(chip.containers)}`}</span>
            {chipFailing(chip) ? (
              <Badge size="sm" tone="danger">
                {`${String(chip.failing)} failing`}
              </Badge>
            ) : null}
            <Badge size="sm" tone="neutral">
              {TIER_WORDS[chip.tier]}
            </Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}
