import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(runtimeRoot, "..");
const fixtureRoot = resolve(runtimeRoot, "test-fixtures");
const configPath = resolve(fixtureRoot, "dredge.config.json");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

// Pages carrying the Variant Group pairs the runtime's widening tests need. The
// synthetic corpus has one surface form per word, so no group can form in it;
// each vocabulary here is disjoint from the generator's so these pages join no
// existing query's results. Every word a query widens across must appear in the
// corpus, because generated groups are read out of the index's own terms.
const VARIANT_PAGES = [
  {
    slug: "plate-negatives",
    title: "Glass Plate Negatives",
    // Reached from `photographs` only through its Variant Group.
    body: "A single photograph of the northern chamber survives on glass.",
  },
  {
    slug: "chamber-survey",
    title: "Chamber Survey Notes",
    // The one page holding `photographs` itself, and only in its body: bm25
    // scores it below the title match below, so exact-before-variant ordering
    // is what has to put it first.
    body: "The survey register lists photographs held in the chamber.",
  },
  {
    slug: "photographed-chambers",
    title: "Photographed Chambers Photographed Again",
    body: "Photographed chambers are photographed once more each season.",
  },
  {
    slug: "excavation-register",
    title: "Excavation Register",
    body: "The excavation register names every trench.",
  },
  {
    slug: "trench-notes",
    title: "Trench Notes",
    body: "Each trench was excavated in stages.",
  },
  {
    slug: "ramesses-inscription",
    title: "Ramesses Inscription",
    body: "The inscription names Ramesses.",
  },
  {
    slug: "cheops-plateau",
    title: "Cheops Plateau",
    body: "Notes on the plateau of Cheops.",
  },
];

// Pages the Search Column tests rank. `ledger` sits in the catalog Search
// Column of one and in the body of the other, so the only thing that can order
// them is the weight the config gives each column.
const SEARCH_COLUMN_PAGES = [
  {
    slug: "storeroom-inventory",
    title: "Storeroom Inventory",
    catalog: "ledger",
    body: "An inventory of vessels held in the northern storeroom.",
  },
  {
    slug: "field-diary",
    title: "Field Diary",
    catalog: "diaryset",
    body: "A ledger was kept beside the trench through the season.",
  },
];

// Pages the highlighting tests mark. The diacritic is the point: the index folds
// it away, so a mark computed on the folded text has to be reported back in the
// offsets of the title as returned.
const HIGHLIGHT_PAGES = [
  {
    slug: "cafe-ostraka",
    title: "Café Notes on Ostraka",
    body: "Notes taken beside the café.",
  },
];

// Declared synonym groups: neither pair shares a stem, so only config can put
// them in one group. They are also the two groups whose members need no corpus
// presence — `ramses` and `khufu` are on no page in the fixture.
const SYNONYM_GROUPS = [
  ["ramses", "ramesses"],
  ["khufu", "cheops"],
];

function fixturePage({ title, body, catalog = "variantset" }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${title}</title>
    <meta name="description" content="${title}.">
  </head>
  <body>
    <main
      data-dredge-category="publication"
      data-dredge-year="2024"
      data-dredge-rating="1.00"
      data-dredge-featured="false"
      data-dredge-published="2024-01-01"
      data-dredge-image="/images/variant.jpg"
      data-dredge-catalog="${catalog}"
    >
      <h1>${title}</h1>
      <p>${body}</p>
    </main>
  </body>
</html>
`;
}

async function addFixturePages() {
  for (const [dir, pages] of [
    ["variants", VARIANT_PAGES],
    ["highlight", HIGHLIGHT_PAGES],
    ["search-columns", SEARCH_COLUMN_PAGES],
  ]) {
    const pageDir = resolve(fixtureRoot, "site", dir);
    await mkdir(pageDir, { recursive: true });
    for (const page of pages) {
      await writeFile(resolve(pageDir, `${page.slug}.html`), fixturePage(page), "utf8");
    }
  }
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.synonym_groups = SYNONYM_GROUPS;
  // The synthetic config folds the catalog attribute into the body; naming it
  // promotes it to a Search Column, and the weight is what the ranking tests
  // read back out of the artifact.
  config.search_fields = [{ source: "data-dredge-catalog", name: "catalog" }];
  config.search_weights = { catalog: 30.0 };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

await rm(fixtureRoot, { recursive: true, force: true });
run("uv", ["run", "dredge", "synth", fixtureRoot, "--count", "50", "--seed", "7"]);
await addFixturePages();
run("uv", [
  "run",
  "dredge",
  "compile",
  "--config",
  configPath,
  "--brotli-quality",
  "1",
]);

console.log(`fixture: ${fixtureRoot}`);
