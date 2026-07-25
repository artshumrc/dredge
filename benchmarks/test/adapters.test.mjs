import assert from "node:assert/strict";
import test from "node:test";

import lunr from "lunr";

// Ticket 02 unit seam: lunr's active-filter clause must survive its stemming
// pipeline and behave as a required (AND) constraint. build-js-engine.mjs indexes
// `benchmark_group` as a lunr field so the adapter can add `+benchmark_group:groupN`
// as a required clause; this test builds an equivalent index in Node and asserts
// the clause both intersects (AND) and correctly restricts to the group.
function buildIndex(documents) {
  return lunr(function configure() {
    this.ref("id");
    this.field("title", { boost: 10 });
    this.field("body");
    this.field("benchmark_group");
    for (const document of documents) this.add(document);
  });
}

const documents = [
  { id: "1", title: "against constitutional amendment", body: "on the rules", benchmark_group: "group3" },
  { id: "2", title: "against the wall entirely", body: "unrelated body text", benchmark_group: "group3" },
  { id: "3", title: "constitutional amendment passed", body: "against nothing", benchmark_group: "group5" },
  { id: "4", title: "some other document", body: "amendment constitutional again", benchmark_group: "group5" },
];

test("lunr + clauses require every token (AND)", () => {
  const index = buildIndex(documents);
  const ids = index.search("+constitutional +amendment").map((hit) => hit.ref).sort();
  // Docs 1, 3, 4 contain both tokens; doc 2 contains neither and is excluded.
  assert.deepEqual(ids, ["1", "3", "4"]);
});

test("lunr filter clause +benchmark_group:groupN survives the pipeline and restricts", () => {
  const index = buildIndex(documents);
  const ids = index.search("+amendment +benchmark_group:group3").map((hit) => hit.ref).sort();
  // Only doc 1: it has "amendment" AND is in group3. Doc 2 is group3 but lacks
  // the term; docs 3 and 4 have the term but are group5. If the group value were
  // mangled by stemming, this would return nothing — so a non-empty, exact match
  // proves the clause survives the pipeline.
  assert.deepEqual(ids, ["1"]);
});

test("lunr without a required clause is OR by default (the behavior the adapter overrides)", () => {
  const index = buildIndex(documents);
  // Plain multi-token search matches any token — this is why the adapter must
  // add explicit `+` clauses to get AND semantics.
  const ids = index.search("constitutional wall").map((hit) => hit.ref).sort();
  assert.ok(ids.includes("2"), "OR default matches doc 2 on 'wall' alone");
  assert.ok(ids.includes("1"), "OR default matches doc 1 on 'constitutional' alone");
});
