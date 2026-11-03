import { Button, Modal } from '@d3cloud/ui';
import type { ActionTarget } from '@shipyard/schema';
import { LOGS_FOLLOW_SECONDS } from '../../lib/actions';
import './incident.css';

/**
 * "Restart <container>?" (SHP-T-19.7, SHP-REQ-210): Restart asks first, naming the container and
 * its app or stack, and says what follows. Cancelling sends nothing; the request is only made by
 * the confirming button.
 */

export function restartConsequence(target: ActionTarget, service: string): string {
  const minutes = String(LOGS_FOLLOW_SECONDS / 60);
  return `${target.name} · ${service} restarts on the same image. This sheet then follows its logs and health until it is healthy again or failing again, for up to ${minutes} minutes.`;
}

export interface RestartConfirmProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  target: ActionTarget;
  service: string;
  onConfirm: () => void;
}

export function RestartConfirm({ open, onOpenChange, name, target, service, onConfirm }: RestartConfirmProps) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={`Restart ${name}?`}
      description={restartConsequence(target, service)}
      footer={
        <>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            Restart
          </Button>
        </>
      }
    />
  );
}
