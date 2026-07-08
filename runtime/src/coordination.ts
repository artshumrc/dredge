/// <reference lib="webworker" />

// Multi-tab leader election and search relay (Phase 4).
//
// The OPFS SAH pool is exclusive: only one tab can hold its sync-access handles.
// Before this module, every additional tab lost the pool and fell back to a
// ~200 MB in-memory copy of the database. Here, tabs elect a leader via the Web
// Locks API. The leader owns the pool and database and boots exactly as a
// single tab does today (the tickets 12/13 path). Follower tabs download
// nothing: they relay search requests to the leader over a BroadcastChannel and
// return the leader's responses verbatim. When the leader's tab goes away, a
// follower holding a queued lock request is granted leadership, boots from the
// OPFS copy the departed leader left behind, and starts serving locally.
//
// All the coordination primitives (locks, channel, timers, ids) arrive through
// an injected `CoordinationEnv`, mirroring the BootEnv seam in db.ts, so vitest
// can drive election and failover with fakes. When the primitives are absent
// (older browsers), the worker passes no env and this module boots locally with
// no channel — preserving today's single-tab behavior, including the in-memory
// fallback inside boot().

import { WorkerError, toDredgeError } from "./db";
import type { StatusFn, Tier } from "./db";
import type { DredgeError } from "./protocol";
import type { DredgeSearchRequest, DredgeSearchResponse } from "./search";

// --- Injected primitives (Web Locks / BroadcastChannel shaped) ---------------

export interface LockInfo {
  name: string;
  mode: "exclusive" | "shared";
}

export interface LockRequestOptions {
  mode?: "exclusive" | "shared";
  ifAvailable?: boolean;
  steal?: boolean;
  signal?: AbortSignal;
}

// The lock is held for as long as the callback's returned promise is pending;
// resolving that promise releases the lock. `ifAvailable` requests that cannot
// be granted immediately invoke the callback with `null`.
export type LockGrantedCallback<T> = (lock: LockInfo | null) => Promise<T> | T;

export interface LockManagerLike {
  request<T>(
    name: string,
    options: LockRequestOptions,
    callback: LockGrantedCallback<T>,
  ): Promise<T>;
}

export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  close(): void;
}

export interface CoordinationEnv {
  locks: LockManagerLike;
  createChannel(name: string): BroadcastChannelLike;
  // Schedule a one-shot timeout; returns a cancel function. Injected so tests
  // fire relay timeouts deterministically instead of waiting on wall-clock.
  scheduleTimeout(callback: () => void, ms: number): () => void;
  // A relay-request id that is unique across all tabs sharing the channel.
  newId(): string;
  // How long a follower waits for the leader to answer a relayed search before
  // giving up with QUERY_FAILED. Defaults to DEFAULT_RELAY_TIMEOUT_MS.
  relayTimeoutMs?: number;
}

// --- Local backend (leader-side database) ------------------------------------

// The leader's view of its own database: enough for the coordinator to serve
// both this tab's client and relayed follower requests. The worker builds it by
// booting the database and closing over schema introspection + search().
export interface LocalBackend {
  getTier(): Tier;
  search(request: DredgeSearchRequest): DredgeSearchResponse;
}

// Boot the database and return a LocalBackend. Receives the status callback the
// coordinator wants boot() to report through (so a leader's tier progression is
// both surfaced to its own client and broadcast to followers).
export type BootLocal = (status: StatusFn) => Promise<LocalBackend>;

export interface CoordinatedSessionOptions {
  // sha256 of the shipped database; namespaces the lock and channel so tabs on
  // different deployments (or across a redeploy) never coordinate with each
  // other.
  manifestSha: string;
  // Status sink for this tab's client (the worker forwards these on).
  status: StatusFn;
  bootLocal: BootLocal;
  // Absent → single-tab mode: boot locally with no coordination.
  env?: CoordinationEnv;
}

export interface CoordinatedSession {
  readonly role: "leader" | "follower";
  getTier(): Tier;
  search(request: DredgeSearchRequest): Promise<DredgeSearchResponse>;
  destroy(): void;
}

// --- Channel protocol ---------------------------------------------------------

type ChannelMessage =
  | { kind: "leader-query" }
  | { kind: "leader-state"; tier: Tier }
  | { kind: "search-request"; reqId: string; request: DredgeSearchRequest }
  | { kind: "search-response"; reqId: string; response: DredgeSearchResponse }
  | { kind: "search-error"; reqId: string; error: DredgeError };

const DEFAULT_RELAY_TIMEOUT_MS = 10_000;

function lockName(sha: string): string {
  return `dredge-leader-${sha}`;
}

function channelName(sha: string): string {
  return `dredge-channel-${sha}`;
}

interface RelayPending {
  resolve: (response: DredgeSearchResponse) => void;
  reject: (error: Error) => void;
  cancel: () => void;
}

class Session implements CoordinatedSession {
  role: "leader" | "follower" = "leader";

  private readonly opts: CoordinatedSessionOptions;
  private readonly env?: CoordinationEnv;
  private channel: BroadcastChannelLike | undefined;
  private channelListener: ((event: { data: unknown }) => void) | undefined;
  private backend: LocalBackend | undefined;
  // Last tier the leader advertised; the answer to getTier() while a follower.
  private followerTier: Tier = "hot";
  private readonly relayPending = new Map<string, RelayPending>();
  // Resolves the leadership lock's held-forever promise, releasing it.
  private releaseLock: (() => void) | undefined;
  // Aborts the queued failover request when this tab is torn down.
  private failoverAbort: AbortController | undefined;
  // Resolves start() once this tab reaches a serving state (follower ready or
  // promoted to leader).
  private settleStartFn: (() => void) | undefined;
  private destroyed = false;

  constructor(opts: CoordinatedSessionOptions) {
    this.opts = opts;
    this.env = opts.env;
  }

  async start(): Promise<void> {
    if (!this.env) {
      // Single-tab mode: no coordination primitives available. Boot locally;
      // boot()'s own in-memory fallback still covers a contended OPFS pool.
      await this.becomeLeader();
      return;
    }
    const role = await this.electLeader();
    if (role === "leader") {
      return;
    }
    // Follower: relay to the leader, and keep a queued lock request so that if
    // the leader departs, this tab is granted leadership and takes over.
    this.role = "follower";
    this.openChannel();
    this.queueFailover();
    await this.waitForServing();
  }

  getTier(): Tier {
    if (this.role === "leader") {
      return this.backend?.getTier() ?? this.followerTier;
    }
    return this.followerTier;
  }

  async search(request: DredgeSearchRequest): Promise<DredgeSearchResponse> {
    if (this.role === "leader") {
      if (!this.backend) {
        throw new WorkerError({ code: "QUERY_FAILED", message: "Database is not open." });
      }
      return this.backend.search(request);
    }
    return this.relaySearch(request);
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.failoverAbort?.abort();
    this.releaseLock?.();
    this.rejectAllRelays("WORKER_TERMINATED", "Dredge worker was terminated.");
    if (this.channel && this.channelListener) {
      this.channel.removeEventListener("message", this.channelListener);
    }
    this.channel?.close();
    this.channel = undefined;
  }

  // --- Leadership ------------------------------------------------------------

  // Probe the leadership lock. If it is free we take it (and hold it until
  // destroy), booting the database inside the grant; if it is already held we
  // resolve as a follower without acquiring anything.
  private electLeader(): Promise<"leader" | "follower"> {
    const env = this.env!;
    return new Promise<"leader" | "follower">((resolveRole, rejectRole) => {
      env.locks
        .request(lockName(this.opts.manifestSha), { ifAvailable: true }, async (lock) => {
          if (!lock) {
            resolveRole("follower");
            return; // held by another tab; we acquired nothing
          }
          try {
            await this.becomeLeader();
          } catch (error) {
            // Boot failed: release the lock so another tab can try, and fail
            // this tab's boot.
            rejectRole(error as Error);
            return;
          }
          resolveRole("leader");
          await this.holdUntilDestroy(); // keep leadership until this tab dies
        })
        .catch((error) => {
          rejectRole(error as Error);
        });
    });
  }

  // Queue a plain (blocking) lock request. Its grant means the previous leader
  // released the lock — its tab is gone — so this tab becomes the new leader.
  private queueFailover(): void {
    const env = this.env!;
    this.failoverAbort = new AbortController();
    env.locks
      .request(lockName(this.opts.manifestSha), { signal: this.failoverAbort.signal }, async () => {
        await this.promoteToLeader();
        await this.holdUntilDestroy();
      })
      .catch(() => {
        // Aborted on destroy, or the request failed — nothing to recover.
      });
  }

  private holdUntilDestroy(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.releaseLock = resolve;
    });
  }

  private async promoteToLeader(): Promise<void> {
    if (this.destroyed || this.role === "leader") {
      return;
    }
    // Relayed searches that were waiting on the now-departed leader can never be
    // answered. Reject them with a retryable code; the client's latest-wins
    // coalescing turns this into a re-typed keystroke, not a broken page.
    this.rejectAllRelays("QUERY_FAILED", "The leader tab went away mid-search; please retry.");
    await this.becomeLeader();
    this.settleStart();
  }

  // Boot the local database and take over serving. Used for the original leader,
  // the single-tab path, and a follower promoted on failover. The channel (if
  // any) stays open across a follower→leader promotion; message routing follows
  // `this.role`, which is now "leader".
  private async becomeLeader(): Promise<void> {
    this.role = "leader";
    const status: StatusFn = (value, detail) => {
      this.opts.status(value, detail);
      // Once the database is open, mirror tier changes (e.g. the Hot→Full swap)
      // to followers so their status and response tags track the leader's.
      if ((value === "ready" || value === "ready_hot") && this.channel && this.backend) {
        this.broadcastLeaderState();
      }
    };
    this.backend = await this.opts.bootLocal(status);
    if (this.env) {
      this.openChannel();
      this.broadcastLeaderState();
    }
  }

  // --- Channel ---------------------------------------------------------------

  private openChannel(): void {
    if (this.channel || !this.env) {
      return;
    }
    this.channel = this.env.createChannel(channelName(this.opts.manifestSha));
    this.channelListener = (event) => this.handleChannelMessage(event.data as ChannelMessage);
    this.channel.addEventListener("message", this.channelListener);
  }

  private handleChannelMessage(message: ChannelMessage): void {
    if (this.role === "leader") {
      this.handleAsLeader(message);
    } else {
      this.handleAsFollower(message);
    }
  }

  private handleAsLeader(message: ChannelMessage): void {
    if (message.kind === "leader-query") {
      this.broadcastLeaderState();
      return;
    }
    if (message.kind === "search-request") {
      if (!this.backend) {
        return;
      }
      try {
        const response = this.backend.search(message.request);
        this.channel?.postMessage({ kind: "search-response", reqId: message.reqId, response });
      } catch (error) {
        this.channel?.postMessage({
          kind: "search-error",
          reqId: message.reqId,
          error: toDredgeError(error),
        });
      }
    }
    // leader-state / search-response / search-error are follower-directed.
  }

  private handleAsFollower(message: ChannelMessage): void {
    if (message.kind === "leader-state") {
      this.applyLeaderState(message.tier);
      return;
    }
    if (message.kind === "search-response") {
      const pending = this.relayPending.get(message.reqId);
      if (pending) {
        this.relayPending.delete(message.reqId);
        pending.cancel();
        pending.resolve(message.response);
      }
      return;
    }
    if (message.kind === "search-error") {
      const pending = this.relayPending.get(message.reqId);
      if (pending) {
        this.relayPending.delete(message.reqId);
        pending.cancel();
        pending.reject(new WorkerError(message.error));
      }
    }
    // leader-query / search-request are leader-directed.
  }

  private broadcastLeaderState(): void {
    if (!this.channel || !this.backend) {
      return;
    }
    this.channel.postMessage({ kind: "leader-state", tier: this.backend.getTier() });
  }

  private applyLeaderState(tier: Tier): void {
    this.followerTier = tier;
    // Followers mirror the leader's advertised tier as their own status: the
    // Hot Tier reads "ready_hot", the Full Tier reads "ready".
    this.opts.status(tier === "full" ? "ready" : "ready_hot");
    this.settleStart();
  }

  // --- Relay -----------------------------------------------------------------

  private relaySearch(request: DredgeSearchRequest): Promise<DredgeSearchResponse> {
    const env = this.env!;
    const reqId = env.newId();
    const timeoutMs = env.relayTimeoutMs ?? DEFAULT_RELAY_TIMEOUT_MS;
    return new Promise<DredgeSearchResponse>((resolve, reject) => {
      const cancel = env.scheduleTimeout(() => {
        if (this.relayPending.delete(reqId)) {
          // Leader busy or a zombie holding the lock: fail this search rather
          // than silently spinning up a 200 MB in-memory copy. Memory fallback
          // is only for environments that lack the coordination primitives.
          reject(
            new WorkerError({
              code: "QUERY_FAILED",
              message: "Search relay to the leader tab timed out.",
            }),
          );
        }
      }, timeoutMs);
      this.relayPending.set(reqId, { resolve, reject, cancel });
      this.channel?.postMessage({ kind: "search-request", reqId, request });
    });
  }

  private rejectAllRelays(code: string, message: string): void {
    for (const pending of this.relayPending.values()) {
      pending.cancel();
      pending.reject(new WorkerError({ code, message }));
    }
    this.relayPending.clear();
  }

  // --- Startup gate ----------------------------------------------------------

  // Resolves once this follower has learned the leader's tier (or has itself
  // been promoted to leader), so start() only returns on a serving session.
  private waitForServing(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.settleStartFn = resolve;
      // Ask the current leader to announce its tier. If the leader has just
      // vanished, our queued failover request will instead promote us — either
      // way settleStart() fires.
      this.channel?.postMessage({ kind: "leader-query" });
    });
  }

  private settleStart(): void {
    const resolve = this.settleStartFn;
    if (resolve) {
      this.settleStartFn = undefined;
      resolve();
    }
  }
}

export async function startCoordinatedSession(
  opts: CoordinatedSessionOptions,
): Promise<CoordinatedSession> {
  const session = new Session(opts);
  await session.start();
  return session;
}
