import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { create, insertMultiple, save } from "@orama/orama";
import FlexSearch from "flexsearch";
import lunr from "lunr";

import { distRoot, readCorpus, readJson } from "./lib.mjs";

const [engine, site] = process.argv.slice(2);
if (!engine || !site) throw new Error("usage: build-js-engine.mjs <orama|flexsearch|lunr> <site>");

const output = resolve(distRoot, site, "artifacts", engine);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

// Facet dimension names, from the corpus workload. Every JS engine must store
// them so the adapters can tally per-facet counts over the match set.
const facetNames = (await readJson(resolve(distRoot, site, "workload.json"))).facets.map(
  (facet) => facet.name,
);

async function buildOrama() {
  const database = create({
    schema: {
      id: "string",
      url: "string",
      title: "string",
      body: "string",
      ...Object.fromEntries(facetNames.map((name) => [name, "enum"])),
    },
  });
  let batch = [];
  for await (const document of readCorpus(site)) {
    batch.push(document);
    if (batch.length === 500) {
      await insertMultiple(database, batch, 500);
      batch = [];
    }
  }
  if (batch.length) await insertMultiple(database, batch, 500);
  await writeFile(resolve(output, "index.json"), JSON.stringify(save(database)));
}

function flexConfiguration() {
  return {
    tokenize: "forward",
    document: {
      id: "id",
      index: ["title", "body"],
      // Facet values are stored (so the adapter can tally them over the full
      // match set) but NOT declared as `tag`: FlexSearch's native tag search
      // verifiably drops matches (a 400-doc/50-expected probe returns 25), so
      // the adapter filters in JavaScript instead. Declaring the tags would only
      // inflate FlexSearch's artifact for an index nothing reads.
      store: ["id", "url", "title", ...facetNames],
    },
  };
}

async function buildFlexSearch() {
  const index = new FlexSearch.Document(flexConfiguration());
  // FlexSearch cannot enumerate its own index, so also emit a plain document
  // list (id/url/title + facets) for the no-keyword browse and count/sort work.
  const documents = [];
  for await (const document of readCorpus(site)) {
    index.add(document);
    const record = { id: document.id, url: document.url, title: document.title };
    for (const name of facetNames) record[name] = document[name];
    documents.push(record);
  }
  const parts = {};
  await index.export((key, value) => {
    parts[key] = value;
  });
  await writeFile(resolve(output, "index.json"), JSON.stringify(parts));
  await writeFile(resolve(output, "config.json"), JSON.stringify(flexConfiguration()));
  await writeFile(resolve(output, "documents.json"), JSON.stringify(documents));
}

async function buildLunr() {
  const documents = [];
  for await (const document of readCorpus(site)) documents.push(document);
  const index = lunr(function configure() {
    this.ref("id");
    this.field("title", { boost: 10 });
    this.field("body");
    // benchmark_group is a searchable field so the active-filter track can use a
    // required clause; other facets are stored (below) for tallying only.
    this.field("benchmark_group");
    for (const document of documents) this.add(document);
  });
  const stored = Object.fromEntries(
    documents.map((document) => {
      const record = { id: document.id, url: document.url, title: document.title };
      for (const name of facetNames) record[name] = document[name];
      return [document.id, record];
    }),
  );
  await writeFile(resolve(output, "index.json"), JSON.stringify(index));
  await writeFile(resolve(output, "documents.json"), JSON.stringify(stored));
}

if (engine === "orama") await buildOrama();
else if (engine === "flexsearch") await buildFlexSearch();
else if (engine === "lunr") await buildLunr();
else throw new Error(`unsupported JavaScript engine: ${engine}`);
