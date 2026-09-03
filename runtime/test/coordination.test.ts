import { describe, expect, it } from "vitest";

import { startCoordinatedSession } from "../src/coordination";
import type {
  BroadcastChannelLike,
  CoordinatedSession,
  CoordinationEnv,
  LockGrantedCallback,
  LockInfo,
  LockManagerLike,
  LockRequestOptions,
  LocalBackend,
} from "../src/coordination";
import type { StatusFn } from "../src/db";
import type {
  DredgeSearchRequest,
  DredgeSearchResponse,
  DredgeSuggestRequest,
  DredgeSuggestResponse,
} from "../src/search";
import type { DredgeStatus } from "../src/protocol";

// Ticket 15 (multi-tab leader election) exercised through the CoordinationEnv
// seam: two tabs share a fake Web Locks manager and a fake BroadcastChannel hub.
// One tab downloads (leader); the other relays (follower). Releasing the leader
// promotes a follower and it serves locally. A silent leader trips the relay
// timeout into QUERY_FAILED with no memory fallback. With no primitives, a tab
// boots locally exactly as a single tab does today. Nothing here touches the
// browser or a real database — bootLocal is a fake backend.

// --- Fake Web Locks -----------------------------------------------------------
// Models a single exclusive lock: `ifAvailable` probes see whether it is held;
// plain requests queue and are granted FIFO when the holder's callback settles.
// A callback that returns a never-resolving promise holds the lock (leadership).

interface QueuedRequest {
  callback: LockGrantedCallback<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

class FakeLockManager implements LockManagerLike {
  private held = false;
  private readonly queue: QueuedRequest[] = [];

  request<T>(
    _name: string,
    options: LockRequestOptions,
    callback: LockGrantedCallback<T>,
  ): Promise<T> {
    if (options.ifAvailable) {
      if (this.held) {
        return Promise.resolve(callback(null)) as Promise<T>;
      }
      return this.grant(callback);
    }
    if (!this.held) {
      return this.grant(callback);
    }
    // Held: queue until the current holder releases.
    return new Promise<T>((resolve, reject) => {
      const entry: QueuedRequest = {
        callback: callback as LockGrantedCallback<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      if (options.signal) {
        if (options.signal.aborted) {
          reject(new Error("AbortError"));
          return;
        }
        options.signal.addEventListener("abort", () => {
          const index = this.queue.indexOf(entry);
          if (index >= 0) {
            this.queue.splice(index, 1);
          }
          reject(new Error("AbortError"));
        });
      }
      this.queue.push(entry);
    });
  }

  private grant<T>(callback: LockGrantedCallback<T>): Promise<T> {
    this.held = true;
    const lock: LockInfo = { name: "dredge", mode: "exclusive" };
    const done = Promise.resolve(callback(lock));
    void done.finally(() => {
      this.held = false;
      this.pump();
    });
    return done;
  }

  private pump(): void {
    if (this.held || this.queue.length === 0) {
      return;
    }
    const next = this.queue.shift()!;
    this.grant(next.callback).then(next.resolve, next.reject);
  }
}

// --- Fake BroadcastChannel hub ------------------------------------------------
// Delivers each message to every OTHER open channel on the hub (never to the
// sender), synchronously — matching BroadcastChannel semantics.

class FakeChannelHub {
  private readonly channels = new Set<FakeChannel>();

  create(): FakeChannel {
    const channel = new FakeChannel(this);
    this.channels.add(channel);
    return channel;
  }

  broadcast(from: FakeChannel, message: unknown): void {
    for (const channel of [...this.channels]) {
      if (channel !== from && !channel.closed) {
        channel.deliver(message);
      }
    }
  }

  remove(channel: FakeChannel): void {
    this.channels.delete(channel);
  }
}

class FakeChannel implements BroadcastChannelLike {
  closed = false;
  private readonly listeners = new Set<(event: { data: unknown }) => void>();

  constructor(private readonly hub: FakeChannelHub) {}

  postMessage(message: unknown): void {
    this.hub.broadcast(this, message);
  }

  addEventListener(_type: "message", listener: (event: { data: unknown }) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "message", listener: (event: { data: unknown }) => void): void {
    this.listeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    this.hub.remove(this);
  }

  deliver(message: unknown): void {
    for (const listener of [...this.listeners]) {
      listener({ data: message });
    }
  }
}

// --- Fake timer ---------------------------------------------------------------

class FakeScheduler {
  private readonly pending = new Map<number, () => void>();
  private nextHandle = 1;

  readonly schedule = (callback: () => void, _ms: number): (() => void) => {
    const handle = this.nextHandle++;
    this.pending.set(handle, callback);
    return () => {
      this.pending.delete(handle);
    };
  };

  fireAll(): void {
    const callbacks = [...this.pending.values()];
    this.pending.clear();
    for (const callback of callbacks) {
      callback();
    }
  }

  get size(): number {
    return this.pending.size;
  }
}

// --- Fake local backend -------------------------------------------------------

class FakeBackend implements LocalBackend {
  readonly searches: DredgeSearchRequest[] = [];
  readonly suggestions: DredgeSuggestRequest[] = [];

  constructor(readonly label: string) {}

  search(request: DredgeSearchRequest): DredgeSearchResponse {
    this.searches.push(request);
    return {
      total: 1,
      hits: [{ url: `${this.label}:${request.query ?? ""}` }],
      elapsedMs: 1,
    };
  }

  suggest(request: DredgeSuggestRequest): DredgeSuggestResponse {
    this.suggestions.push(request);
    return {
      suggestions: [{ term: `${this.label}:${request.term}`, documentFrequency: 1, distance: 1 }],
      elapsedMs: 1,
    };
  }
}

// --- Tab harness --------------------------------------------------------------

const SHA = "abc123";

interface TabControls {
  bootLocal: (onStatus: StatusFn) => Promise<LocalBackend>;
  bootCalls: number;
  backend: FakeBackend;
  // Trigger a status from inside the (leader) boot: the captured status callback
  // is boot()'s own status sink.
  emitLeaderStatus: (status: DredgeStatus) => void;
  statuses: DredgeStatus[];
  scheduler: FakeScheduler;
}

function makeTab(
  hub: FakeChannelHub | undefined,
  locks: FakeLockManager | undefined,
  label: string,
  options: { bootStatus?: DredgeStatus; relayTimeoutMs?: number } = {},
): { start: () => Promise<CoordinatedSession>; controls: TabControls } {
  const backend = new FakeBackend(label);
  const scheduler = new FakeScheduler();
  const statuses: DredgeStatus[] = [];
  const controls: TabControls = {
    bootCalls: 0,
    backend,
    statuses,
    scheduler,
    emitLeaderStatus: () => {},
    bootLocal: async (onStatus: StatusFn) => {
      controls.bootCalls += 1;
      controls.emitLeaderStatus = (status) => onStatus(status);
      onStatus(options.bootStatus ?? "ready");
      return backend;
    },
  };

  let seq = 0;
  const env: CoordinationEnv | undefined =
    hub && locks
      ? {
          locks,
          createChannel: () => hub.create(),
          scheduleTimeout: scheduler.schedule,
          newId: () => `${label}-${(seq += 1)}`,
          relayTimeoutMs: options.relayTimeoutMs ?? 1000,
        }
      : undefined;

  const start = () =>
    startCoordinatedSession({
      manifestSha: SHA,
      status: (status) => statuses.push(status),
      bootLocal: controls.bootLocal,
      env,
    });

  return { start, controls };
}

function makeResponseWaiter<T>(promise: Promise<T>): { settled: boolean; value?: T; error?: unknown } {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  promise.then(
    (value) => {
      state.settled = true;
      state.value = value;
    },
    (error) => {
      state.settled = true;
      state.error = error;
    },
  );
  return state;
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("multi-tab leader election (CoordinationEnv seam)", () => {
  it("one tab leads and boots; a second tab follows and serves relayed results", async () => {
    const hub = new FakeChannelHub();
    const locks = new FakeLockManager();
    const tabA = makeTab(hub, locks, "A");
    const tabB = makeTab(hub, locks, "B");

    const leader = await tabA.start();
    expect(leader.role).toBe("leader");
    expect(tabA.controls.bootCalls).toBe(1);

    const follower = await tabB.start();
    expect(follower.role).toBe("follower");
    // The follower downloaded nothing: it never booted a database.
    expect(tabB.controls.bootCalls).toBe(0);
    // It learned the leader is serving and reports ready.
    expect(tabB.controls.statuses).toContain("ready");

    // A follower search is answered by the leader's backend and relayed back.
    const response = await follower.search({ query: "hello" });
    expect(response).toMatchObject({ total: 1 });
    expect(response.hits[0].url).toBe("A:hello");
    // The leader ran it; the follower ran nothing locally.
    expect(tabA.controls.backend.searches).toEqual([{ query: "hello" }]);
    expect(tabB.controls.backend.searches).toEqual([]);

    // Suggestions relay over the same channel, so a follower tab can offer a
    // correction without a database of its own.
    const suggested = await follower.suggest({ term: "helo", kind: "correction" });
    expect(suggested.suggestions[0].term).toBe("A:helo");
    expect(tabA.controls.backend.suggestions).toEqual([{ term: "helo", kind: "correction" }]);

    leader.destroy();
    follower.destroy();
  });

  it("promotes a follower to leader when the leader releases the lock", async () => {
    const hub = new FakeChannelHub();
    const locks = new FakeLockManager();
    const tabA = makeTab(hub, locks, "A");
    const tabB = makeTab(hub, locks, "B");

    const leader = await tabA.start();
    const follower = await tabB.start();
    expect(follower.role).toBe("follower");
    expect(tabB.controls.bootCalls).toBe(0);

    // Leader tab closes → its lock releases → the follower's queued request is
    // granted and it boots from OPFS to serve locally.
    leader.destroy();
    await flush();

    expect(follower.role).toBe("leader");
    expect(tabB.controls.bootCalls).toBe(1);

    // The promoted tab now serves searches from its own backend, no relay.
    const response = await follower.search({ query: "after" });
    expect(response.hits[0].url).toBe("B:after");
    expect(tabB.controls.backend.searches).toEqual([{ query: "after" }]);

    follower.destroy();
  });

  it("rejects in-flight relayed searches when the leader departs mid-search", async () => {
    const hub = new FakeChannelHub();
    const locks = new FakeLockManager();
    // Leader whose backend hangs is not needed: we close the leader's channel so
    // the relay is never answered, then drop the leader to force failover.
    const tabA = makeTab(hub, locks, "A");
    const tabB = makeTab(hub, locks, "B");

    const leader = await tabA.start();
    const follower = await tabB.start();

    // Silence the leader so this search is never answered while it is in flight.
    (leader as unknown as { channel: BroadcastChannelLike }).channel.close();
    const inflight = makeResponseWaiter(follower.search({ query: "lost" }));
    await flush();
    expect(inflight.settled).toBe(false);

    // Leader departs → follower is promoted → the orphaned relay rejects with a
    // retryable code (client coalescing re-issues it as a keystroke).
    leader.destroy();
    await flush();

    expect(inflight.settled).toBe(true);
    expect((inflight.error as { code?: string }).code).toBe("QUERY_FAILED");
    expect(follower.role).toBe("leader");

    follower.destroy();
  });

  it("times out a relayed search into QUERY_FAILED without any memory fallback", async () => {
    const hub = new FakeChannelHub();
    const locks = new FakeLockManager();
    const tabA = makeTab(hub, locks, "A");
    const tabB = makeTab(hub, locks, "B");

    const leader = await tabA.start();
    const follower = await tabB.start();
    expect(follower.role).toBe("follower");

    // Zombie leader: still holds the lock (no failover) but stops serving.
    (leader as unknown as { channel: BroadcastChannelLike }).channel.close();

    const pending = makeResponseWaiter(follower.search({ query: "stall" }));
    await flush();
    expect(pending.settled).toBe(false);
    expect(tabB.controls.scheduler.size).toBe(1);

    // The relay timeout fires.
    tabB.controls.scheduler.fireAll();
    await flush();

    expect(pending.settled).toBe(true);
    expect((pending.error as { code?: string }).code).toBe("QUERY_FAILED");
    // Still a follower — it did NOT boot a 200 MB in-memory copy.
    expect(follower.role).toBe("follower");
    expect(tabB.controls.bootCalls).toBe(0);

    leader.destroy();
    follower.destroy();
  });

  it("boots locally with no coordination env (single-tab fallback preserved)", async () => {
    // No hub, no locks → env is undefined → single-tab path.
    const tab = makeTab(undefined, undefined, "solo");
    const session = await tab.start();

    expect(session.role).toBe("leader");
    expect(tab.controls.bootCalls).toBe(1);

    const response = await session.search({ query: "q" });
    expect(response.hits[0].url).toBe("solo:q");
    expect(tab.controls.backend.searches).toEqual([{ query: "q" }]);

    session.destroy();
  });
});
