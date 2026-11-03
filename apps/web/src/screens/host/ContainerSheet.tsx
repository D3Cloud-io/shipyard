import { Badge, Button, Modal, StatusDot } from '@d3cloud/ui';
import type { HostContainer, LifecycleVerb } from '@shipyard/schema';
import { useState } from 'react';
import { canAct, canReadLogs, containerRequest, containerVerbs, isBusy, targetFor, useAction, useLogs, type Logs } from '../../lib/actions';
import { useMe } from '../../lib/auth';
import type { FollowStatus } from '../../lib/incident';
import { containerStatus, cpuWords, isDeployedTier, memoryWords, restartWords } from '../../lib/host';
import { LIFECYCLE_VERB_WORDS, TIER_WORDS } from '../../lib/words';
import { ActionProgress } from './ActionProgress';
import { CopyForClaude } from './CopyForClaude';
import { LogsPanel } from './LogsViewer';
import { RestartConfirm } from './RestartConfirm';
import { RestartFollow } from './RestartFollow';
import { StopConfirm } from './StopConfirm';

/**
 * A container's sheet (SHP-T-15.7, SHP-REQ-184/185/188/189/192), opened from its Host row or by
 * `/host?container=<id>`: what it is (tier, state, service, image, use), its lifecycle actions when
 * its tier and the reader's role allow them, and its logs. On a desktop it is a panel on the right
 * beside the list; on a phone a bottom sheet, the way every sheet in the console is.
 *
 * Observed containers get no action at all (SHP-REQ-185); a viewer sees none either. Stop asks
 * first and is only ever here (SHP-REQ-188). Restart asks first too, and once sent it is followed
 * until the container is healthy again or failing again (SHP-T-19.7, SHP-REQ-210/211/242); Copy for
 * Claude (admin and operator, any tier) copies its incident bundle (SHP-REQ-212). The footer says the logs are redacted on the host and
 * never stored, and that opening them is audited (SHP-REQ-192).
 */

export const LOGS_NOTE = 'Redacted on the host before they leave it, and never stored. Opening these logs is recorded in the audit log.';

const HINT = 'Restart and Recreate never change the image.';

function Facts({ container }: { container: HostContainer }) {
  const status = containerStatus(container);
  const where = container.compose === null ? null : `${container.compose.project} · ${container.compose.service}`;
  return (
    <span className="shp-csheet__facts">
      <span className="shp-csheet__line">
        <Badge size="sm" tone={isDeployedTier(container.tier) ? 'attention' : 'neutral'}>
          {TIER_WORDS[container.tier]}
        </Badge>
        <StatusDot tone={status.tone} size="sm">
          {status.words}
        </StatusDot>
        {where === null ? null : <span>{where}</span>}
        <code className="shp-csheet__image">{container.image}</code>
      </span>
      <span className="shp-csheet__line">
        {restartWords(container.restartCount)} · {cpuWords(container.stats)} CPU · {memoryWords(container.stats)}
      </span>
    </span>
  );
}

function Actions({ container, logs }: { container: HostContainer; logs: Logs }) {
  const me = useMe();
  const { phase, run } = useAction();
  const [confirm, setConfirm] = useState<'stop' | 'restart' | null>(null);
  // A confirmed restart being followed: a counter, so asking again starts the follow afresh.
  const [followed, setFollowed] = useState(0);
  const target = targetFor(container.tier, container.app);
  const service = container.compose?.service ?? null;
  const canRead = canReadLogs(me?.role);
  const copy = canRead ? <CopyForClaude container={container} /> : null;

  if (target === null || service === null) {
    return (
      <div className="shp-csheet__actions">
        <p className="shp-csheet__muted">Observed: Shipyard only watches this container. Adopt its stack to start, stop or restart it here.</p>
        {copy}
      </div>
    );
  }
  if (!canAct(me?.role)) return null;

  const busy = isBusy(phase);
  const ask = (verb: LifecycleVerb) => {
    const body = containerRequest(container, verb);
    if (body === null) return;
    setFollowed((n) => (verb === 'restart' ? n + 1 : 0));
    run(body);
  };
  const verbs = containerVerbs(container);
  const open = (which: 'stop' | 'restart') => () => {
    setConfirm(which);
  };

  return (
    <div className="shp-csheet__actions">
      <div className="shp-csheet__buttons" role="group" aria-label="Actions">
        {verbs.map((verb) =>
          verb === 'stop' ? (
            <Button key={verb} type="button" variant="danger-ghost" disabled={busy} onClick={open('stop')}>
              {LIFECYCLE_VERB_WORDS.stop}
            </Button>
          ) : (
            <Button
              key={verb}
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={verb === 'restart' ? open('restart') : () => {
                ask(verb);
              }}
            >
              {LIFECYCLE_VERB_WORDS[verb]}
            </Button>
          ),
        )}
        {verbs.includes('restart') ? <span className="shp-csheet__hint">{HINT}</span> : null}
      </div>
      {followed > 0 && !busy ? null : copy}
      {followed > 0 ? (
        busy ? (
          <ActionProgress phase={phase} />
        ) : (
          <RestartFollow
            key={followed}
            name={container.name}
            phase={phase}
            onRestarted={() => {
              // The old stream ended with the old process; this one opens on the restarted container.
              if (canRead) logs.setFollow(true);
            }}
            onSettled={(status: FollowStatus) => {
              if (status === 'healthy' && canRead) logs.setFollow(false);
            }}
            actions={copy}
          />
        )
      ) : (
        <ActionProgress phase={phase} />
      )}
      <StopConfirm
        open={confirm === 'stop'}
        onOpenChange={(next) => {
          if (!next) setConfirm(null);
        }}
        name={container.name}
        target={target}
        service={service}
        onConfirm={() => {
          ask('stop');
        }}
      />
      <RestartConfirm
        open={confirm === 'restart'}
        onOpenChange={(next) => {
          if (!next) setConfirm(null);
        }}
        name={container.name}
        target={target}
        service={service}
        onConfirm={() => {
          ask('restart');
        }}
      />
    </div>
  );
}

/** One container's actions and logs, sharing the log stream so a restart can turn Follow on. */
function SheetBody({ container }: { container: HostContainer }) {
  const me = useMe();
  const allowed = canReadLogs(me?.role);
  const logs = useLogs(container.id, allowed);
  return (
    <>
      <Actions container={container} logs={logs} />
      <LogsPanel logs={logs} allowed={allowed} />
    </>
  );
}

export interface ContainerSheetProps {
  /** The container to show; null when the address names one this host does not have. */
  container: HostContainer | null;
  open: boolean;
  onClose: () => void;
}

export function ContainerSheet({ container, open, onClose }: ContainerSheetProps) {
  const onOpenChange = (next: boolean) => {
    if (!next) onClose();
  };

  if (container === null) {
    return (
      <Modal open={open} onOpenChange={onOpenChange} title="Container not found" closeLabel="Close" size="md">
        <p>This host has no container with that ID any more. It may have been removed or recreated since the link was made.</p>
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      className="shp-csheet"
      size="lg"
      closeLabel="Close"
      title={container.name}
      description={<Facts container={container} />}
      footer={<p className="shp-csheet__note">{LOGS_NOTE}</p>}
    >
      <span className="shp-csheet__close">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </span>
      <div className="shp-csheet__body">
        <SheetBody key={container.id} container={container} />
      </div>
    </Modal>
  );
}
