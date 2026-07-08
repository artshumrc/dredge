import { describe, expect, it } from "vitest";

import {
  DredgeSearchClient,
  type DredgeSearchRequest,
  type DredgeSearchResponse,
  type DredgeStatus,
  type DredgeTier,
  type DredgeWorkerRequest,
  type DredgeWorkerResponse,
} from "../src/client.template";

// A scripted worker: it auto-answers `init` (so the client reaches `ready`)
// but holds every `search` post until the test explicitly responds, letting
// tests control in-flight timing. It records all posts for assertions.
class FakeWorker {
  readonly posts: DredgeWorkerRequest[] = [];
  private readonly messageListeners = new Set<(event: { data: DredgeWorkerResponse }) => void>();

  // Which tier the auto-answered init reports. "full" mimics a warm boot
  // (client reaches "ready"); "hot" mimics a cold boot (client reaches
  // "ready_hot" until a later status message swaps it to "ready").
  initTier: DredgeTier = "full";

  postMessage(message: DredgeWorkerRequest): void {
    this.posts.push(message);
    if (message.type === "init") {
      this.emit({ type: "ready", id: message.id, tier: this.initTier });
    }
  }

  emitStatus(status: DredgeStatus): void {
    this.emit({ type: "status", status });
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (type === "message") {
      this.messageListeners.add(listener as (event: { data: DredgeWorkerResponse }) => void);
    }
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    if (type === "message") {
      this.messageListeners.delete(listener as (event: { data: DredgeWorkerResponse }) => void);
    }
  }

  terminate(): void {}

  searchPosts(): Array<{ id: number; request: DredgeSearchRequest }> {
    const searches: Array<{ id: number; request: DredgeSearchRequest }> = [];
    for (const message of this.posts) {
      if (message.type === "search") {
        searches.push({ id: message.id, request: message.request });
      }
    }
    return searches;
  }

  respondSearch(id: number, response: DredgeSearchResponse): void {
    this.emit({ type: "searchResult", id, response });
  }

  private emit(data: DredgeWorkerResponse): void {
    for (const listener of this.messageListeners) {
      listener({ data });
    }
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeResponse(total = 0, tier: DredgeTier = "full"): DredgeSearchResponse {
  return { total, hits: [], elapsedMs: 1, tier };
}

function makeClient(): { client: DredgeSearchClient; worker: FakeWorker } {
  const worker = new FakeWorker();
  const client = new DredgeSearchClient({
    workerFactory: () => worker as unknown as Worker,
  });
  return { client, worker };
}

describe("DredgeSearchClient coalescing", () => {
  it("posts only the first and last of three rapid searches", async () => {
    const { client, worker } = makeClient();
    await client.init();

    const p1 = client.search({ query: "a" });
    const p2 = client.search({ query: "ab" });
    const p3 = client.search({ query: "abc" });
    const settled = Promise.allSettled([p1, p2, p3]);

    await flush();

    // Only the first search reached the worker; the middle keystroke never did.
    expect(worker.searchPosts()).toHaveLength(1);
    const first = worker.searchPosts()[0];
    expect(first.request).toEqual({ query: "a" });

    // The in-flight (first) search completes; the retained newest is submitted.
    worker.respondSearch(first.id, makeResponse());
    await flush();

    expect(worker.searchPosts()).toHaveLength(2);
    const last = worker.searchPosts()[1];
    expect(last.request).toEqual({ query: "abc" });

    worker.respondSearch(last.id, makeResponse(42));
    const outcomes = await settled;

    // (a) exactly two posts, (b) middle rejects STALE, (c) last resolves.
    expect(outcomes[0].status).toBe("rejected");
    expect(outcomes[1].status).toBe("rejected");
    expect((outcomes[1] as PromiseRejectedResult).reason.code).toBe("STALE_RESPONSE");
    expect(outcomes[2].status).toBe("fulfilled");
    expect((outcomes[2] as PromiseFulfilledResult<DredgeSearchResponse>).value.total).toBe(42);
  });

  it("keeps only the newest pending search while one is slow in flight", async () => {
    const { client, worker } = makeClient();
    await client.init();

    const p1 = client.search({ query: "one" });
    const p2 = client.search({ query: "two" });
    const p3 = client.search({ query: "three" });
    const settled = Promise.allSettled([p1, p2, p3]);

    await flush();
    // The slow in-flight search is the only post so far.
    expect(worker.searchPosts()).toHaveLength(1);

    // (d) the displaced pending rejects STALE; the newest survives.
    await expect(p2).rejects.toMatchObject({ code: "STALE_RESPONSE" });

    worker.respondSearch(worker.searchPosts()[0].id, makeResponse());
    await flush();

    expect(worker.searchPosts()).toHaveLength(2);
    expect(worker.searchPosts()[1].request).toEqual({ query: "three" });
    worker.respondSearch(worker.searchPosts()[1].id, makeResponse(7));

    const outcomes = await settled;
    expect(outcomes[1].status).toBe("rejected");
    expect(outcomes[2].status).toBe("fulfilled");
    expect((outcomes[2] as PromiseFulfilledResult<DredgeSearchResponse>).value.total).toBe(7);
  });

  it("resolves a lone in-flight search that is never superseded", async () => {
    const { client, worker } = makeClient();
    await client.init();

    const p1 = client.search({ query: "solo" });
    await flush();

    expect(worker.searchPosts()).toHaveLength(1);
    worker.respondSearch(worker.searchPosts()[0].id, makeResponse(5));

    await expect(p1).resolves.toMatchObject({ total: 5 });
  });
});

describe("DredgeSearchClient tier lifecycle", () => {
  it("reaches ready_hot on a cold boot and accepts searches there", async () => {
    const { client, worker } = makeClient();
    worker.initTier = "hot";
    const seen: DredgeStatus[] = [];
    client.onStatus((status) => seen.push(status));

    await client.init();
    expect(client.getStatus()).toBe("ready_hot");

    // A search is accepted on the hot tier and carries tier: "hot".
    const p = client.search({ query: "cold" });
    await flush();
    expect(worker.searchPosts()).toHaveLength(1);
    worker.respondSearch(worker.searchPosts()[0].id, makeResponse(3, "hot"));
    await expect(p).resolves.toMatchObject({ total: 3, tier: "hot" });

    // The background full-tier swap arrives as a plain status message.
    worker.emitStatus("ready");
    expect(client.getStatus()).toBe("ready");
    expect(seen).toContain("ready_hot");
    expect(seen).toContain("ready");

    // Subsequent responses are tagged full.
    const p2 = client.search({ query: "warm" });
    await flush();
    worker.respondSearch(worker.searchPosts()[1].id, makeResponse(9, "full"));
    await expect(p2).resolves.toMatchObject({ total: 9, tier: "full" });
  });

  it("reaches ready directly on a warm boot", async () => {
    const { client, worker } = makeClient();
    worker.initTier = "full";

    await client.init();
    expect(client.getStatus()).toBe("ready");
  });
});
