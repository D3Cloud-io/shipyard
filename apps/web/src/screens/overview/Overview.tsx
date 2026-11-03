import { Alert, Button, EmptyState, Link, Page, PageHeader, Section, Skeleton, Stack, StatusDot } from '@d3cloud/ui';
import { useMemo, useRef, useState } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import { DryRunSheet, type SheetAction } from '../../components/DryRunSheet';
import { NeedsYou } from '../../components/NeedsYou';
import { appStatus } from '../../lib/appstatus';
import { useCan } from '../../lib/auth';
import { useHomeData } from '../../lib/home';
import { ageWords, isStale } from '../../lib/host';
import { needsYouFrom } from '../../lib/needsyou';
import { freshnessWords, incidentKey, last24hSentence, useOverview } from '../../lib/overview';
import { IncidentBanners } from './IncidentBanners';
import { AppTiles, ProjectChips, RunsStats, WorkList } from './parts';
import './overview.css';

/**
 * Overview (SHP-ADR-013, SHP-T-19.6, SHP-REQ-207, SHP-REQ-209): state first, then what is wrong —
 * one incident banner per Deployed app or Operated stack with a failing container, what runs on the
 * host, Needs you (the same list Apps shows, from the shell's shared store), what is happening now,
 * a health tile per Deployed app, the last 24 hours, and a chip per other compose project. It lives
 * at `/overview`; Apps stays the home until SHP-T-19.9.
 *
 * Needs you's "Approve and deploy" opens the same dry-run sheet Apps opens.
 */
export function Overview() {
  const data = useOverview();
  const canDeploy = useCan();
  const home = useHomeData(canDeploy);
  const navigate = useNavigate();
  const [action, setAction] = useState<SheetAction | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const o = data.overview;
  const now = data.now;

  // The banners already there on the first answer are static; one that appears later is announced.
  const firstSeen = useRef<Set<string> | null>(null);
  if (o !== null && firstSeen.current === null) firstSeen.current = new Set(o.incidents.map(incidentKey));
  const announced = useMemo(() => {
    const seen = firstSeen.current;
    return new Set((o?.incidents ?? []).map(incidentKey).filter((k) => seen !== null && !seen.has(k)));
  }, [o]);

  const needsYou = useMemo(
    () =>
      needsYouFrom({
        apps: home.apps,
        approvals: home.approvals,
        system: home.system,
        stackNeeds: home.stackNeeds,
        maintenanceNeeds: home.maintenanceNeeds,
      }),
    [home.apps, home.approvals, home.system, home.stackNeeds, home.maintenanceNeeds],
  );
  const counts = useMemo(() => {
    const kinds = home.apps.map((app) => appStatus({ ...app, approval: home.approvals.find((a) => a.app === app.name) }).kind);
    return { upToDate: kinds.filter((k) => k === 'up-to-date').length, ready: kinds.filter((k) => k === 'ready').length };
  }, [home.apps, home.approvals]);

  const stale = o !== null && o.hostReportedAt !== null && isStale(o.hostReportedAt, now);
  const noAgent = o !== null && o.hostReportedAt === null;

  return (
    <Page width="wide">
      <Stack gap="24">
        <PageHeader title="Overview" {...(o === null ? {} : { description: freshnessWords(o, now) })} />

        {stale && o.hostReportedAt !== null ? (
          <p className="shp-ov-stale">
            <StatusDot tone="warning">{`Last reported ${ageWords(o.hostReportedAt, now)} ago — the agent may be down.`}</StatusDot>
          </p>
        ) : null}

        {data.status === 'loading' && o === null ? (
          <div aria-busy="true">
            <span role="status" className="shp-visually-hidden">
              Loading the overview
            </span>
            <Stack gap="12" aria-hidden="true">
              <Skeleton variant="block" height={96} />
              <Skeleton variant="block" height={56} />
              <Skeleton variant="text" lines={6} />
            </Stack>
          </div>
        ) : null}

        {data.status === 'error' && o === null ? (
          <Alert
            tone="danger"
            title={data.error?.message ?? 'Shipyard is not answering.'}
            actions={
              <Button type="button" variant="secondary" onClick={data.reload}>
                Retry
              </Button>
            }
          >
            {data.error?.fix ?? 'Check that the server is running and reachable, then try again.'}
          </Alert>
        ) : null}

        {o !== null ? <IncidentBanners incidents={o.incidents} now={now} announced={announced} /> : null}

        {noAgent ? (
          <EmptyState
            kind="empty"
            heading="No host inventory yet"
            headingLevel={2}
            action={
              <Link asChild>
                <RouterLink to="/settings/host">Settings › Host</RouterLink>
              </Link>
            }
          >
            No agent has reported what Docker runs on this host. The agent reports everything Docker runs once it is enrolled and on version f574b79 or
            later; Settings › Host shows its state.
          </EmptyState>
        ) : null}

        {o !== null && !noAgent ? (
          <Section title="What runs" surface="plain">
            <RunsStats runs={o.runs} tiles={o.apps} />
          </Section>
        ) : null}

        {o !== null && home.status === 'ready' ? (
          needsYou.count > 0 ? (
            <NeedsYou
              items={needsYou.items}
              apps={home.apps}
              approvals={home.approvals}
              system={home.system}
              stackNeeds={home.stackNeeds}
              maintenanceNeeds={home.maintenanceNeeds}
              stacks={home.stacks}
              canAct={canDeploy}
              onReview={(next) => {
                setAction(next);
                setSheetOpen(true);
              }}
              onChanged={home.refresh}
              onDeployStarted={(deployId) => {
                void navigate(`/deploys/${deployId}`);
              }}
              upToDate={counts.upToDate}
              ready={counts.ready}
            />
          ) : (
            <p className="shp-ov-quiet">Nothing needs you.</p>
          )
        ) : null}

        {o !== null ? (
          <div className="shp-ov-pair">
            <Section title="Happening now" surface="plain">
              {o.now.length === 0 ? <p className="shp-ov-quiet">Nothing is running right now.</p> : <WorkList items={o.now} label="Happening now" now={now} />}
            </Section>

            <Section title="Last 24 h" surface="plain">
              <Stack gap="8">
                <p className="shp-ov-sentence">{last24hSentence(o.last24h)}</p>
                {o.last24h.recent.length === 0 ? null : <WorkList items={o.last24h.recent} label="Last 24 hours" now={now} />}
              </Stack>
            </Section>
          </div>
        ) : null}

        {o !== null && !noAgent ? (
          <Section title="Apps on this host" surface="plain">
            {o.apps.length === 0 ? (
              <p className="shp-ov-quiet">Shipyard deploys no apps on this host yet.</p>
            ) : (
              <AppTiles tiles={o.apps} now={now} label="Deployed apps" />
            )}
          </Section>
        ) : null}

        {o !== null && !noAgent && o.projects.length > 0 ? (
          <Section title="Everything else" surface="plain">
            <ProjectChips chips={o.projects} />
          </Section>
        ) : null}
      </Stack>

      <DryRunSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        action={action}
        onStarted={(deployId) => {
          setSheetOpen(false);
          void navigate(`/deploys/${deployId}/live`);
        }}
      />
    </Page>
  );
}
