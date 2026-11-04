import { describe, expect, it, vi } from 'vitest';
import { AGENT_EVENT_BUFFER, AgentReport } from '@shipyard/schema';
import type { ContainerEventsOptions, DockerPort, EngineContainerEvent } from '@shipyard/sequence';
import { createEventCollector, toContainerEvent } from '../src/events.js';

/**
 * Engine events (SHP-T-20.2): every start, die, oom, health_status and restart event reaches the
 * next report (SHP-REQ-217); a dropped stream reopens from the last event's time (SHP-REQ-218);
 * past the buffer the oldest go and are counted (SHP-REQ-219); only an accepted report lets them go.
 */

const ID = 'a'.repeat(64);
const quiet = { info: () => undefined, warn: () => undefined };

function event(n: number, over: Partial<EngineContainerEvent> = {}): EngineContainerEvent {
  return {
    kind: 'start',
    timeNano: (1_790_000_000_000_000_000n + BigInt(n) * 1_000_000n).toString(),
    containerId: ID,
    containerName: 'toy-web-1',
    exitCode: null,
    health: null,
    ...over,
  };
}

/**
 * A port whose event streams the test scripts: each subscription records its options and gets the
 * next script, a function that emits and then ends (resolves) or breaks (throws).
 */
function scriptedDocker(scripts: ((emit: (e: EngineContainerEvent) => void, opts: ContainerEventsOptions) => Promise<void>)[]) {
  const subscriptions: ContainerEventsOptions[] = [];
  const docker = {
    containerEvents: (opts: ContainerEventsOptions, onEvent: (e: EngineContainerEvent) => void) => {
      subscriptions.push(opts);
      const script = scripts.shift();
      // Out of scripts: hold the stream open until the signal aborts.
      if (script === undefined) {
        return new Promise<void>((resolve) => {
          if (opts.signal.aborted) resolve();
          opts.signal.addEventListener('abort', () => {
            resolve();
          });
        });
      }
      return script(onEvent, opts);
    },
  } as unknown as DockerPort;
  return { docker, subscriptions };
}

const noSleep = (): Promise<void> => Promise.resolve();

describe('toContainerEvent', () => {
  it('takes the Engine time in ms, exit code only on die and health only on health_status', () => {
    expect(toContainerEvent(event(0, { kind: 'die', exitCode: 137, health: 'healthy' }))).toEqual({
      kind: 'die',
      at: '2026-09-21T14:13:20.000Z',
      containerId: ID,
      containerName: 'toy-web-1',
      exitCode: 137,
      health: null,
    });
    expect(toContainerEvent(event(1, { kind: 'health_status', health: 'unhealthy', exitCode: 1 }))).toMatchObject({ at: '2026-09-21T14:13:20.001Z', exitCode: null, health: 'unhealthy' });
  });

  it('is null for an event the report schema would refuse', () => {
    expect(toContainerEvent(event(0, { containerId: 'short' }))).toBeNull();
    expect(toContainerEvent(event(0, { containerName: '' }))).toBeNull();
  });
});

describe('createEventCollector', () => {
  it('buffers every event for the next report, oldest first, until that report is accepted (SHP-REQ-217)', async () => {
    const { docker } = scriptedDocker([
      (emit) => {
        emit(event(1, { kind: 'die', exitCode: 0 }));
        emit(event(2, { kind: 'start' }));
        emit(event(3, { kind: 'restart' }));
        return new Promise(() => undefined);
      },
    ]);
    const events = createEventCollector({ docker, log: quiet, sleep: noSleep });
    const stop = new AbortController();
    void events.run(stop.signal);
    await vi.waitFor(() => {
      expect(events.size()).toBe(3);
    });

    const batch = events.take();
    expect(batch.events.map((e) => e.kind)).toEqual(['die', 'start', 'restart']);
    expect(batch.droppedEvents).toBe(0);
    // The report schema takes them as they are.
    expect(AgentReport.shape.events.parse(batch.events)).toEqual(batch.events);

    events.accepted({ events: batch.events, droppedEvents: batch.droppedEvents });
    expect(events.size()).toBe(0);
    expect(events.take()).toEqual({ events: [], droppedEvents: 0 });
    stop.abort();
  });

  it('keeps the events of a report that failed for the next one, and lets go only of what an accepted one carried', async () => {
    const emitter: { emit?: (e: EngineContainerEvent) => void } = {};
    const { docker } = scriptedDocker([
      (emit) => {
        emitter.emit = emit;
        return new Promise(() => undefined);
      },
    ]);
    const events = createEventCollector({ docker, log: quiet, sleep: noSleep });
    void events.run(new AbortController().signal);
    await vi.waitFor(() => {
      expect(emitter.emit).toBeDefined();
    });
    const emit = emitter.emit ?? ((): void => undefined);

    emit(event(1));
    const failed = events.take();
    // No `accepted` call: the report failed.
    emit(event(2));
    const next = events.take();
    expect(next.events).toHaveLength(2);

    // Arrived while that report was out: stays for the one after.
    emit(event(3));
    events.accepted(next);
    expect(events.size()).toBe(1);
    // A stale batch is not mistaken for the latest.
    events.accepted(failed);
    expect(events.size()).toBe(1);
  });

  it('drops the oldest past its cap and reports how many until a report carrying the count is accepted (SHP-REQ-219)', async () => {
    const emitter: { emit?: (e: EngineContainerEvent) => void } = {};
    const { docker } = scriptedDocker([
      (emit) => {
        emitter.emit = emit;
        return new Promise(() => undefined);
      },
    ]);
    const events = createEventCollector({ docker, log: quiet, cap: 3, sleep: noSleep });
    void events.run(new AbortController().signal);
    await vi.waitFor(() => {
      expect(emitter.emit).toBeDefined();
    });
    const emit = emitter.emit ?? ((): void => undefined);

    for (let n = 1; n <= 5; n++) emit(event(n, { kind: n % 2 === 0 ? 'die' : 'start', exitCode: n % 2 === 0 ? n : null }));
    const first = events.take();
    expect(first.events.map((e) => e.at)).toEqual(['2026-09-21T14:13:20.003Z', '2026-09-21T14:13:20.004Z', '2026-09-21T14:13:20.005Z']);
    expect(first.droppedEvents).toBe(2);

    // A report that failed: the count stands, and grows.
    emit(event(6));
    const second = events.take();
    expect(second.droppedEvents).toBe(3);
    events.accepted(second);
    expect(events.take()).toEqual({ events: [], droppedEvents: 0 });
  });

  it('does not count as dropped an event that overflowed while the report carrying it was accepted', async () => {
    const emitter: { emit?: (e: EngineContainerEvent) => void } = {};
    const { docker } = scriptedDocker([
      (emit) => {
        emitter.emit = emit;
        return new Promise(() => undefined);
      },
    ]);
    const events = createEventCollector({ docker, log: quiet, cap: 2, sleep: noSleep });
    void events.run(new AbortController().signal);
    await vi.waitFor(() => {
      expect(emitter.emit).toBeDefined();
    });
    const emit = emitter.emit ?? ((): void => undefined);
    emit(event(1));
    emit(event(2));
    const out = events.take();
    // Two more arrive while that report is out; both of its events overflow away.
    emit(event(3));
    emit(event(4));
    events.accepted(out);
    expect(events.take()).toMatchObject({ droppedEvents: 0 });
    expect(events.size()).toBe(2);
  });

  it('caps at AGENT_EVENT_BUFFER by default', async () => {
    const { docker } = scriptedDocker([
      (emit) => {
        for (let n = 0; n < AGENT_EVENT_BUFFER + 7; n++) emit(event(n));
        return new Promise(() => undefined);
      },
    ]);
    const events = createEventCollector({ docker, log: quiet, sleep: noSleep });
    void events.run(new AbortController().signal);
    await vi.waitFor(() => {
      expect(events.size()).toBe(AGENT_EVENT_BUFFER);
    });
    const batch = events.take();
    expect(batch.droppedEvents).toBe(7);
    expect(AgentReport.shape.events.safeParse(batch.events).success).toBe(true);
  });

  it('reopens a stream that ended or broke from the last event it saw, skipping the events at that time it already has (SHP-REQ-218)', async () => {
    const warn = vi.fn();
    const { docker, subscriptions } = scriptedDocker([
      (emit) => {
        emit(event(1, { kind: 'die', exitCode: 1 }));
        emit(event(2, { kind: 'die', exitCode: 0 }));
        emit(event(2, { kind: 'start' }));
        return Promise.resolve();
      },
      (emit) => {
        // `since` is inclusive: the Engine sends both events at that time again, then a new one.
        emit(event(2, { kind: 'die', exitCode: 0 }));
        emit(event(2, { kind: 'start' }));
        emit(event(2, { kind: 'restart' }));
        return Promise.reject(new Error('socket hang up'));
      },
      (emit) => {
        emit(event(2, { kind: 'restart' }));
        emit(event(3, { kind: 'oom' }));
        return new Promise(() => undefined);
      },
    ]);
    const sleeps: number[] = [];
    const events = createEventCollector({
      docker,
      log: { info: () => undefined, warn },
      backoffMs: 10,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    void events.run(new AbortController().signal);
    await vi.waitFor(() => {
      expect(subscriptions).toHaveLength(3);
      expect(events.size()).toBe(5);
    });

    // The first stream opens at now; each reopen at the exact nanosecond of the last event seen.
    expect(subscriptions.map((s) => s.since)).toEqual([null, '1790000000.002000000', '1790000000.002000000']);
    expect(events.take().events.map((e) => `${e.kind}@${e.at.slice(20, 23)}`)).toEqual(['die@001', 'die@002', 'start@002', 'restart@002', 'oom@003']);
    expect(sleeps).toEqual([10, 10]);
    expect(warn).toHaveBeenCalledWith({}, 'Engine event stream ended; reopening it');
    expect(warn).toHaveBeenCalledWith({ err: 'socket hang up' }, 'Engine event stream failed; reopening it');
  });

  it('backs off further while the Engine keeps refusing, up to the cap', async () => {
    const fail = (): Promise<void> => Promise.reject(new Error('connect ENOENT /var/run/docker.sock'));
    const { docker } = scriptedDocker([fail, fail, fail, fail, fail]);
    const sleeps: number[] = [];
    const stop = new AbortController();
    const events = createEventCollector({
      docker,
      log: quiet,
      backoffMs: 100,
      maxBackoffMs: 500,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    void events.run(stop.signal);
    await vi.waitFor(() => {
      expect(sleeps).toHaveLength(5);
    });
    expect(sleeps).toEqual([100, 200, 400, 500, 500]);
    stop.abort();
  });

  it('stops when the agent stops, and does nothing on a port without events', async () => {
    const { docker, subscriptions } = scriptedDocker([]);
    const stop = new AbortController();
    const events = createEventCollector({ docker, log: quiet });
    const running = events.run(stop.signal);
    await vi.waitFor(() => {
      expect(subscriptions).toHaveLength(1);
    });
    expect(subscriptions[0]?.signal).toBe(stop.signal);
    stop.abort();
    await expect(running).resolves.toBeUndefined();
    expect(subscriptions).toHaveLength(1);

    const bare = createEventCollector({ docker: {} as DockerPort, log: quiet });
    await expect(bare.run(new AbortController().signal)).resolves.toBeUndefined();
    expect(bare.take()).toEqual({ events: [], droppedEvents: 0 });
  });

  it('skips an event the report schema would refuse, without counting it dropped', async () => {
    const warn = vi.fn();
    const { docker } = scriptedDocker([
      (emit) => {
        emit(event(1, { containerId: 'not-an-id' }));
        emit(event(2));
        return new Promise(() => undefined);
      },
    ]);
    const events = createEventCollector({ docker, log: { info: () => undefined, warn }, sleep: noSleep });
    void events.run(new AbortController().signal);
    await vi.waitFor(() => {
      expect(events.size()).toBe(1);
    });
    expect(events.take().droppedEvents).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
