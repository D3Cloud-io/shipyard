import { AGENT_EVENT_BUFFER, ContainerEvent, type AgentReport } from '@shipyard/schema';
import { engineSince, type DockerPort, type EngineContainerEvent } from '@shipyard/sequence';
import type { ReportLog } from './report.js';

/**
 * Engine events (SHP-T-20.2, SHP-REQ-217..219). One read-only, long-lived `GET /events` on the
 * Engine's socket, asking for container start, die, oom, health_status and restart events only.
 * It is a local read like every other Docker call the agent makes: no port is opened for it.
 *
 * Each event is held in memory until a report carrying it is accepted. The buffer holds at most
 * `AGENT_EVENT_BUFFER`; past that the oldest goes and is counted, and the count goes with the next
 * report (SHP-REQ-219). A report takes a snapshot of the buffer and the count, and only a 2xx for
 * that report removes those events and that count: a failed report loses nothing.
 *
 * When the stream ends or breaks, it is opened again after a short backoff from the time of the
 * last event seen (SHP-REQ-218). The Engine's `since` is inclusive, so the events at exactly that
 * time come again and are recognised and skipped.
 */

/** The first wait before reopening the stream; it doubles on each reopen that saw no event. */
export const EVENTS_BACKOFF_MS = 1_000;
export const EVENTS_MAX_BACKOFF_MS = 30_000;

/** What a report carries: the buffered events, oldest first, and how many were dropped. */
export interface EventBatch {
  events: ContainerEvent[];
  droppedEvents: number;
}

export interface EventCollectorOptions {
  docker: DockerPort;
  log: ReportLog;
  /** Default `AGENT_EVENT_BUFFER`. */
  cap?: number;
  backoffMs?: number;
  maxBackoffMs?: number;
  /** Waits `ms`, or less when `signal` aborts. Tests replace it. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface EventCollector {
  /** Reads the Engine's events, reopening the stream as it ends, until `signal` aborts. */
  run(signal: AbortSignal): Promise<void>;
  /** A snapshot for the next report. The events stay buffered until `accepted`. */
  take(): EventBatch;
  /** The server accepted a report: the batch it carried is sent, so it leaves the buffer. */
  accepted(report: Pick<AgentReport, 'events' | 'droppedEvents'>): void;
  /** Events buffered now. */
  size(): number;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref();
    signal.addEventListener('abort', done, { once: true });
  });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The event as the report carries it, or null when the schema would refuse it. */
export function toContainerEvent(e: EngineContainerEvent): ContainerEvent | null {
  let at: string;
  try {
    at = new Date(Number(BigInt(e.timeNano) / 1_000_000n)).toISOString();
  } catch {
    return null;
  }
  const parsed = ContainerEvent.safeParse({
    kind: e.kind,
    at,
    containerId: e.containerId,
    containerName: e.containerName.slice(0, 255),
    exitCode: e.kind === 'die' ? e.exitCode : null,
    health: e.kind === 'health_status' ? e.health : null,
  });
  return parsed.success ? parsed.data : null;
}

/** What makes two events at one `timeNano` the same event, for the boundary of a reconnect. */
function eventKey(e: EngineContainerEvent): string {
  return `${e.kind}|${e.containerId}|${String(e.exitCode)}|${String(e.health)}`;
}

export function createEventCollector(opts: EventCollectorOptions): EventCollector {
  const { docker, log } = opts;
  const cap = opts.cap ?? AGENT_EVENT_BUFFER;
  const backoffMs = opts.backoffMs ?? EVENTS_BACKOFF_MS;
  const maxBackoffMs = opts.maxBackoffMs ?? EVENTS_MAX_BACKOFF_MS;
  const sleep = opts.sleep ?? abortableSleep;

  let buffer: { seq: number; event: ContainerEvent }[] = [];
  let nextSeq = 0;
  /** Dropped and not yet carried by an accepted report. */
  let dropped = 0;
  /**
   * The snapshot the latest report took. An event it holds that overflows away before the report
   * is answered is counted apart: it is dropped only if that report is not accepted.
   */
  let outstanding: { events: ContainerEvent[]; through: number; dropped: number } | null = null;
  let droppedInFlight = 0;

  // The last event seen: where a reopened stream starts, and the events already seen at that time.
  let lastNano: string | null = null;
  let seenAtLast = new Set<string>();

  const push = (e: EngineContainerEvent): void => {
    const key = eventKey(e);
    if (e.timeNano === lastNano) {
      if (seenAtLast.has(key)) return;
      seenAtLast.add(key);
    } else {
      lastNano = e.timeNano;
      seenAtLast = new Set([key]);
    }
    const event = toContainerEvent(e);
    if (event === null) {
      log.warn({ kind: e.kind, container: e.containerId.slice(0, 12) }, 'Engine event failed validation; not reported');
      return;
    }
    buffer.push({ seq: nextSeq++, event });
    while (buffer.length > cap) {
      const oldest = buffer.shift();
      if (oldest === undefined) break;
      if (outstanding !== null && oldest.seq <= outstanding.through) droppedInFlight += 1;
      else dropped += 1;
    }
  };

  return {
    async run(signal) {
      const subscribe = docker.containerEvents?.bind(docker);
      if (subscribe === undefined) return;
      // A function, not the property: the signal flips while the stream is awaited.
      const aborted = (): boolean => signal.aborted;
      let received = 0;
      let wait = backoffMs;
      while (!aborted()) {
        const before = received;
        try {
          await subscribe({ since: lastNano === null ? null : engineSince(lastNano), signal }, (e) => {
            received += 1;
            push(e);
          });
          if (!aborted()) log.warn({}, 'Engine event stream ended; reopening it');
        } catch (err) {
          if (aborted()) break;
          log.warn({ err: message(err) }, 'Engine event stream failed; reopening it');
        }
        if (aborted()) break;
        if (received > before) wait = backoffMs;
        await sleep(wait, signal);
        wait = Math.min(wait * 2, maxBackoffMs);
      }
    },

    take() {
      // A report that was never accepted did not deliver what overflowed while it was out.
      dropped += droppedInFlight;
      droppedInFlight = 0;
      const events = buffer.map((b) => b.event);
      outstanding = { events, through: buffer.at(-1)?.seq ?? -1, dropped };
      return { events, droppedEvents: dropped };
    },

    accepted(report) {
      const sent = outstanding;
      if (sent === null || report.events !== sent.events) return;
      outstanding = null;
      buffer = buffer.filter((b) => b.seq > sent.through);
      dropped = Math.max(0, dropped - sent.dropped);
      droppedInFlight = 0;
    },

    size: () => buffer.length,
  };
}
