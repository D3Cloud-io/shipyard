import { Alert, Link } from '@d3cloud/ui';
import type { IncidentBanner } from '@shipyard/schema';
import { Link as RouterLink } from 'react-router-dom';
import {
  containerHref,
  incidentContainerLine,
  incidentHeadline,
  incidentKey,
  lastChangeSentence,
  oldestContainer,
  ownerButtonWords,
  ownerHref,
} from '../../lib/overview';

/**
 * One danger banner per Deployed app or Operated stack with a failing container (SHP-REQ-209): the
 * container, when it began failing, the owner's last change stated against it, and two plainly
 * named ways out — the failing container's sheet on Host and the owner's own page.
 *
 * Announcing: a banner already there when Overview first answers is static (no role — a screen
 * reader would otherwise interrupt itself for something already on the page). One that appears on a
 * later read is `dynamic`, so it is announced once as it is inserted; a poll that re-renders it with
 * the same words does not announce it again.
 */
export function IncidentBanners({ incidents, now, announced }: { incidents: readonly IncidentBanner[]; now: number; announced: ReadonlySet<string> }) {
  if (incidents.length === 0) return null;
  return (
    <div className="shp-ov-incidents" aria-label="Incidents" role="group">
      {incidents.map((banner) => {
        const key = incidentKey(banner);
        const first = oldestContainer(banner);
        return (
          <Alert
            key={key}
            tone="danger"
            title={incidentHeadline(banner)}
            dynamic={announced.has(key)}
            className="shp-ov-incident"
            data-owner={banner.owner.name}
            actions={
              <span className="shp-ov-incident__actions">
                {first === undefined ? null : (
                  <Link asChild className="shp-ov-action">
                    <RouterLink to={containerHref(first.id)}>{`Open ${first.name}`}</RouterLink>
                  </Link>
                )}
                <Link asChild className="shp-ov-action">
                  <RouterLink to={ownerHref(banner.owner)}>{ownerButtonWords(banner.owner)}</RouterLink>
                </Link>
              </span>
            }
          >
            <ul className="shp-ov-incident__lines">
              {banner.containers.map((c) => (
                <li key={c.id}>{incidentContainerLine(c, now)}</li>
              ))}
            </ul>
            <p className="shp-ov-incident__change">{lastChangeSentence(banner.lastChange, banner.owner.kind, banner.since, now)}</p>
          </Alert>
        );
      })}
    </div>
  );
}
