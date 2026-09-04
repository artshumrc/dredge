import { describe, expect, it } from "vitest";

import {
  DredgeSearchClient,
  type DredgeSearchRequest,
  type DredgeSearchResponse,
  type DredgeStatus,
  type DredgeSuggestRequest,
  type DredgeSuggestResponse,
  type DredgeWorkerRequest,
  type DredgeWorkerResponse,
} from "../src/client.template";

// A scripted worker: it auto-answers `init` (so the client reaches `ready`)
// but holds every `search` post until the test explicitly responds, letting
// tests control in-flight timing. It records all posts for assertions.
class FakeWorker {
  readonly posts: DredgeWorkerRequest[] = [];
  private readonly messageListeners = new Set<(event: { data: DredgeWorkerResponse }) => void>();

  postMessage(message: DredgeWorkerRequest): void {
    this.posts.push(message);
    if (message.type === "init") {
      this.emit({ type: "ready", id: message.id });
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

  suggestPosts(): Array<{ id: number; request: DredgeSuggestRequest }> {
    const suggests: Array<{ id: number; request: DredgeSuggestRequest }> = [];
    for (const message of this.posts) {
      if (message.type === "suggest") {
        suggests.push({ id: message.id, request: message.request });
      }
    }
    return suggests;
  }

  respondSuggest(id: number, response: DredgeSuggestResponse): void {
    this.emit({ type: "suggestResult", id, response });
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

function makeResponse(total = 0): DredgeSearchResponse {
  return { total, hits: [], elapsedMs: 1 };
}

function makeSuggestions(...terms: string[]): DredgeSuggestResponse {
  return { suggestions: terms.map((term) => ({ term, documentFrequency: 1 })), elapsedMs: 1 };
}

function completion(term: string): DredgeSuggestRequest {
  return { term, kind: "completion" };
}

function correction(term: string): DredgeSuggestRequest {
  return { term, kind: "correction" };
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

  it("posts only the first and last of three rapid completions", async () => {
    const { client, worker } = makeClient();
    await client.init();

    const p1 = client.suggest(completion("p"));
    const p2 = client.suggest(completion("py"));
    const p3 = client.suggest(completion("pyr"));
    const settled = Promise.allSettled([p1, p2, p3]);

    await flush();

    expect(worker.suggestPosts()).toHaveLength(1);
    const first = worker.suggestPosts()[0];
    expect(first.request).toEqual(completion("p"));

    // The middle keystroke never reaches the worker; the newest is retained.
    await expect(p2).rejects.toMatchObject({ code: "STALE_RESPONSE" });

    worker.respondSuggest(first.id, makeSuggestions("pylon"));
    await flush();

    expect(worker.suggestPosts()).toHaveLength(2);
    const last = worker.suggestPosts()[1];
    expect(last.request).toEqual(completion("pyr"));

    worker.respondSuggest(last.id, makeSuggestions("pyramid"));
    const outcomes = await settled;

    expect(outcomes[0].status).toBe("rejected");
    expect(outcomes[1].status).toBe("rejected");
    expect(outcomes[2].status).toBe("fulfilled");
    expect(
      (outcomes[2] as PromiseFulfilledResult<DredgeSuggestResponse>).value.suggestions[0].term,
    ).toBe("pyramid");
  });

  it("neither supersedes nor is superseded by a correction between two completions", async () => {
    const { client, worker } = makeClient();
    await client.init();

    const first = client.suggest(completion("pyr"));
    const fix = client.suggest(correction("kartouche"));
    const second = client.suggest(completion("pyra"));

    await flush();

    // The correction posts immediately alongside the in-flight completion, and
    // the completion it sits between is the one retained.
    const posts = worker.suggestPosts();
    expect(posts.map((post) => post.request)).toEqual([completion("pyr"), correction("kartouche")]);

    worker.respondSuggest(posts[1].id, makeSuggestions("cartouche"));
    await expect(fix).resolves.toMatchObject({ suggestions: [{ term: "cartouche" }] });

    worker.respondSuggest(posts[0].id, makeSuggestions("pylon"));
    await expect(first).rejects.toMatchObject({ code: "STALE_RESPONSE" });
    await flush();

    const last = worker.suggestPosts()[2];
    expect(last.request).toEqual(completion("pyra"));
    worker.respondSuggest(last.id, makeSuggestions("pyramid"));
    await expect(second).resolves.toMatchObject({ suggestions: [{ term: "pyramid" }] });
  });

  it("does not reject an in-flight search when a completion is issued", async () => {
    const { client, worker } = makeClient();
    await client.init();

    const search = client.search({ query: "khufu" });
    const suggestion = client.suggest(completion("pyr"));
    await flush();

    expect(worker.searchPosts()).toHaveLength(1);
    expect(worker.suggestPosts()).toHaveLength(1);

    worker.respondSuggest(worker.suggestPosts()[0].id, makeSuggestions("pyramid"));
    await expect(suggestion).resolves.toMatchObject({ suggestions: [{ term: "pyramid" }] });

    worker.respondSearch(worker.searchPosts()[0].id, makeResponse(9));
    await expect(search).resolves.toMatchObject({ total: 9 });
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

describe("DredgeSearchClient boot", () => {
  it("reaches ready on init and accepts searches", async () => {
    const { client, worker } = makeClient();
    const seen: DredgeStatus[] = [];
    client.onStatus((status) => seen.push(status));

    await client.init();
    expect(client.getStatus()).toBe("ready");
    expect(seen).toContain("ready");

    const p = client.search({ query: "temple" });
    await flush();
    expect(worker.searchPosts()).toHaveLength(1);
    worker.respondSearch(worker.searchPosts()[0].id, makeResponse(3));
    await expect(p).resolves.toMatchObject({ total: 3 });
  });
});
