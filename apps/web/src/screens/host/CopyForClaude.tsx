import { Alert, Button } from '@d3cloud/ui';
import type { HostContainer } from '@shipyard/schema';
import { useEffect, useRef, useState } from 'react';
import { copyText } from '../../lib/admin';
import { problemOf } from '../../lib/actions';
import type { RefusalError } from '../../lib/api';
import { copiedWords, incidents, renderBundle } from '../../lib/incident';
import './incident.css';

/**
 * Copy for Claude (SHP-T-19.7, SHP-REQ-212): the container's incident bundle, built by the server
 * on request and never stored, as Markdown on the clipboard. It says what it copied. When the
 * browser refuses the clipboard — an insecure origin, or the permission lost while the server built
 * a slow bundle — the Markdown is shown to copy by hand, so the work is never thrown away.
 */

/** "Copied" stays on the button this long. */
export const COPIED_FOR_MS = 4_000;

type State =
  | { kind: 'idle' }
  | { kind: 'building' }
  | { kind: 'copied'; line: string }
  | { kind: 'manual'; line: string; markdown: string }
  | { kind: 'refused'; error: RefusalError };

export function CopyForClaude({ container }: { container: Pick<HostContainer, 'id'> }) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [recent, setRecent] = useState(false);
  const live = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      live.current?.abort();
    },
    [],
  );
  useEffect(() => {
    if (!recent) return;
    const timer = setTimeout(() => {
      setRecent(false);
    }, COPIED_FOR_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [recent]);

  const copy = () => {
    live.current?.abort();
    const controller = new AbortController();
    live.current = controller;
    setRecent(false);
    setState({ kind: 'building' });
    void (async () => {
      try {
        const bundle = await incidents.bundle(container.id, controller.signal);
        const markdown = await renderBundle(bundle);
        const line = copiedWords(bundle);
        if (controller.signal.aborted) return;
        if (await copyText(markdown)) {
          setState({ kind: 'copied', line });
          setRecent(true);
        } else {
          setState({ kind: 'manual', line: 'The browser would not let the console use the clipboard. Select the text below and copy it.', markdown });
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setState({ kind: 'refused', error: problemOf(error) });
      }
    })();
  };

  const building = state.kind === 'building';
  return (
    <div className="shp-inc-copy">
      <Button type="button" variant="secondary" disabled={building} onClick={copy}>
        {building ? 'Building the bundle…' : recent ? 'Copied' : 'Copy for Claude'}
      </Button>
      <p className="shp-inc-copy__line" aria-live="polite">
        {state.kind === 'copied' || state.kind === 'manual' ? state.line : ''}
      </p>
      {state.kind === 'manual' ? (
        <textarea
          className="shp-inc-copy__manual"
          readOnly
          rows={8}
          aria-label="Incident bundle for Claude"
          value={state.markdown}
          onFocus={(e) => {
            e.currentTarget.select();
          }}
        />
      ) : null}
      {state.kind === 'refused' ? (
        <Alert tone="danger" title={state.error.message} dynamic>
          {state.error.fix}
        </Alert>
      ) : null}
    </div>
  );
}
