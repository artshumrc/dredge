import { describe, expect, it } from "vitest";

import {
  DredgeSearchClient,
  type DredgeSearchResponse,
  type DredgeSuggestResponse,
} from "../src/client";

type Post = { type: string; id: number; request?: unknown };

// Auto-answers `init` so the client reaches `ready`, then holds every request
// until the test responds, letting a suggestion and a search be in flight at once.
class FakeWorker {
  readonly posts: Post[] = [];
  private readonly listeners = new Set<(event: { data: unknown }) => void>();

  postMessage(message: Post): void {
    this.posts.push(message);
    if (message.type === "init") {
      this.emit({ type: "ready", id: message.id });
    }
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (type === "message") {
      this.listeners.add(listener as (event: { data: unknown }) => void);
    }
  }

  removeEventListener(): void {}

  terminate(): void {}

  idOf(type: string): number {
    const post = this.posts.find((message) => message.type === type);
    if (!post) {
      throw new Error(`no ${type} was posted`);
    }
    return post.id;
  }

  emit(data: unknown): void {
    for (const listener of this.listeners) {
      listener({ data });
    }
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeClient(): { client: DredgeSearchClient; worker: FakeWorker } {
  const worker = new FakeWorker();
  const client = new DredgeSearchClient({
    workerFactory: () => worker as unknown as Worker,
  });
  return { client, worker };
}

const SUGGESTIONS: DredgeSuggestResponse = {
  suggestions: [{ term: "pyramid", score: 1 }],
};

describe("DredgeSearchClient suggestions", () => {
  it("posts a suggest request and resolves its response", async () => {
    const { client, worker } = makeClient();
    const pending = client.suggest({ term: "pyramd", kind: "correction" });
    await flush();

    const post = worker.posts.find((message) => message.type === "suggest");
    expect(post?.request).toEqual({ term: "pyramd", kind: "correction" });

    worker.emit({ type: "suggestResult", id: post!.id, response: SUGGESTIONS });
    await expect(pending).resolves.toEqual(SUGGESTIONS);
  });

  it("does not supersede an in-flight suggestion when a later search is issued", async () => {
    const { client, worker } = makeClient();
    const suggesting = client.suggest({ term: "pyr", kind: "completion" });
    await flush();
    const suggestId = worker.idOf("suggest");

    const searching = client.search({ q: "pyramid" });
    await flush();
    const response: DredgeSearchResponse = { total: 0, hits: [], elapsedMs: 1 };
    worker.emit({ type: "searchResult", id: worker.idOf("search"), response });
    await expect(searching).resolves.toEqual(response);

    worker.emit({ type: "suggestResult", id: suggestId, response: SUGGESTIONS });
    await expect(suggesting).resolves.toEqual(SUGGESTIONS);
  });
});
