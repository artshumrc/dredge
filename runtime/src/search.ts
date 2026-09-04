import type { Exec } from "./db";
import type { DredgeMarks, MarkForms } from "./highlight";
import { foldTerm, markFields, markForms } from "./highlight";
import type { CorrectionLookup, ParseQueryOptions, QueryNode, VariantLookup } from "./query";
import { emitMatchExpression, ftsExactTerm, parseQuery } from "./query";

export { buildMatchExpression, emitMatchExpression, parseQuery } from "./query";
export type { CorrectionLookup, QueryNode, VariantLookup } from "./query";
export type { DredgeMark, DredgeMarks } from "./highlight";

export interface DredgeRange<T> {
  min?: T;
  max?: T;
}

export type DredgeFilterValue =
  | string
  | number
  | boolean
  | Array<string | number | boolean>
  | DredgeRange<number | string>;

export interface DredgeFilters {
  [facet: string]: DredgeFilterValue | undefined;
}

export interface DredgeSort {
  // A selectable `documents` column to order by (e.g. "title"). Unknown or
  // result-only store fields are rejected by the worker.
  field: string;
  direction?: "asc" | "desc";
}

export interface DredgeSearchRequest {
  query?: string;
  filters?: DredgeFilters;
  limit?: number;
  offset?: number;
  includeFacets?: boolean | string[];
  // Explicit ordering. When omitted, results are ordered by relevance
  // (bm25) for keyword queries, or by document id for match-all browse.
  sort?: DredgeSort;
}

export interface DredgeFacetBucket {
  value: string | number | boolean;
  count: number;
}

export interface DredgeHit {
  [field: string]: string | number | boolean | null | DredgeMarks | undefined;
  // Where the reader's terms — including the variants that actually matched —
  // fall in this hit's text fields. Absent when nothing matched, and never
  // markup: the consumer renders the spans into its own DOM.
  marks?: DredgeMarks;
}

// One word the reader typed that the index does not hold, and the dictionary
// terms the search was widened to instead. Reported so a page can say "showing
// results for cartouche" rather than substituting silently.
export interface DredgeCorrection {
  // The reader's word, folded the index's way.
  term: string;
  // The corrections used, in the order they were ranked.
  to: string[];
}

export interface DredgeSearchResponse {
  total: number;
  hits: DredgeHit[];
  facets?: Record<string, DredgeFacetBucket[]>;
  // Present only when at least one term was corrected.
  corrections?: DredgeCorrection[];
  elapsedMs: number;
}

export type DredgeSuggestKind = "correction" | "completion";

export interface DredgeSuggestRequest {
  // A single term: the word the reader typed for a correction, the partial word
  // they are still typing for a completion. Phrases are not suggested against.
  term: string;
  kind: DredgeSuggestKind;
  limit?: number;
  // The rest of the reader's query (without the word being suggested against)
  // and their filters. Every suggestion returned co-occurs with it.
  context?: { query?: string; filters?: DredgeFilters };
}

export interface DredgeSuggestion {
  // A term the index actually holds, so accepting this suggestion cannot land
  // the reader on zero results.
  term: string;
  documentFrequency: number;
  // Edit distance from what the reader typed; for a completion, the number of
  // characters it adds.
  distance: number;
}

export interface DredgeSuggestResponse {
  suggestions: DredgeSuggestion[];
  elapsedMs: number;
}

export class DredgeQueryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DredgeQueryError";
    this.code = code;
  }
}

interface FieldInfo {
  role: "facet" | "store";
  type: string;
}

// A named, independently weighted full-text column of the index.
export interface SearchColumn {
  name: string;
  weight: number;
}

// An ordering multiplier the maintainer declared over one scalar Facet. bm25
// ranks are negative and sort ascending, so a multiplier above 1 moves a row
// toward the front; boosts multiply, never add.
export type Boost =
  | {
      shape: "value";
      facet: string;
      // The Facet value, in the type its column holds, and its multiplier.
      values: Array<{ value: unknown; multiplier: number }>;
    }
  | {
      shape: "recency";
      facet: string;
      // The lift a page dated today receives, halving every `halfLifeDays`.
      maximum: number;
      halfLifeDays: number;
    };

export interface SchemaInfo {
  // Scalar facet columns living directly on the documents table.
  scalarColumns: string[];
  // Array facet name -> join table name (facet_<name>).
  arrayFacets: Map<string, string>;
  fields: Map<string, FieldInfo>;
  // All selectable document columns (excluding content_hash) in stable order.
  documentColumns: string[];
  // Whether the artifact carries a Term Variant table. Artifacts built before
  // it existed have none, and widen nothing.
  hasTermVariants: boolean;
  // The index's Search Columns in column order, each with the bm25 weight the
  // maintainer's config gave it. `bm25()` takes one weight per column in this
  // order, and a `field:` scope may name any of them.
  searchColumns: SearchColumn[];
  // The ordering multipliers the artifact declares, empty for a site that
  // declared none. Read unconditionally: the compiler writes the table into
  // every artifact, and an older one is refused at Boot on its schema version.
  boosts: Boost[];
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function introspectSchema(exec: Exec): SchemaInfo {
  const tableInfo = exec("PRAGMA table_info(documents)");
  // PRAGMA table_info columns: cid, name, type, notnull, dflt_value, pk
  const allColumns = tableInfo.map((row) => String(row[1]));
  const documentColumns = allColumns.filter((name) => name !== "content_hash");

  const fields = new Map<string, FieldInfo>();
  const fieldRows = exec("SELECT name, role, type FROM dredge_fields ORDER BY name");
  for (const row of fieldRows) {
    const role = String(row[1]);
    if (role !== "facet" && role !== "store") {
      throw new DredgeQueryError(
        "QUERY_INVALID",
        `Database field ${String(row[0])} has invalid role ${role}.`,
      );
    }
    fields.set(String(row[0]), { role, type: String(row[2]) });
  }

  const scalarColumns = documentColumns.filter((name) => fields.get(name)?.role === "facet");
  const arrayFacets = new Map<string, string>();
  for (const [name, info] of fields) {
    if (info.role === "facet" && info.type === "string_array") {
      arrayFacets.set(name, `facet_${name}`);
    }
  }

  const variantTable = exec(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    [TERM_VARIANTS_TABLE],
  );

  const searchColumns = exec(
    `SELECT name, weight FROM ${SEARCH_COLUMNS_TABLE} ORDER BY position`,
  ).map((row) => ({ name: String(row[0]), weight: Number(row[1]) }));

  return {
    scalarColumns,
    arrayFacets,
    fields,
    documentColumns,
    hasTermVariants: variantTable.length > 0,
    searchColumns,
    boosts: readBoosts(exec),
  };
}

// Read the artifact's boost rows into one descriptor per boosted Facet. The
// value rows of a Facet are collapsed into a single CASE, so their order here
// is the order the compiler wrote them in.
function readBoosts(exec: Exec): Boost[] {
  const boosts: Boost[] = [];
  const valueBoosts = new Map<string, Extract<Boost, { shape: "value" }>>();
  const rows = exec(
    `SELECT facet, shape, value, multiplier, half_life_days FROM ${BOOSTS_TABLE} ` +
      `ORDER BY rowid`,
  );
  for (const row of rows) {
    const facet = String(row[0]);
    if (String(row[1]) === "recency") {
      boosts.push({
        shape: "recency",
        facet,
        maximum: Number(row[3]),
        halfLifeDays: Number(row[4]),
      });
      continue;
    }
    let boost = valueBoosts.get(facet);
    if (!boost) {
      boost = { shape: "value", facet, values: [] };
      valueBoosts.set(facet, boost);
      boosts.push(boost);
    }
    boost.values.push({ value: row[2], multiplier: Number(row[3]) });
  }
  return boosts;
}

interface WhereClause {
  sql: string[];
  bind: unknown[];
}

function isRange(value: unknown): value is DredgeRange<number | string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    ("min" in value || "max" in value)
  );
}

function scalarFilterClause(
  alias: string,
  column: string,
  value: DredgeFilterValue,
): WhereClause {
  const id = `${alias}.${quoteIdentifier(column)}`;
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return { sql: ["0"], bind: [] };
    }
    const placeholders = value.map(() => "?").join(", ");
    return { sql: [`${id} IN (${placeholders})`], bind: [...value] };
  }
  if (isRange(value)) {
    const sql: string[] = [];
    const bind: unknown[] = [];
    if (value.min !== undefined) {
      sql.push(`${id} >= ?`);
      bind.push(value.min);
    }
    if (value.max !== undefined) {
      sql.push(`${id} <= ?`);
      bind.push(value.max);
    }
    return { sql, bind };
  }
  return { sql: [`${id} = ?`], bind: [value] };
}

function arrayFilterClause(
  alias: string,
  table: string,
  value: DredgeFilterValue,
): WhereClause {
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0) {
    return { sql: ["0"], bind: [] };
  }
  const placeholders = values.map(() => "?").join(", ");
  return {
    sql: [
      `EXISTS (SELECT 1 FROM ${quoteIdentifier(table)} ft ` +
        `WHERE ft.document_id = ${alias}.id AND ft.value IN (${placeholders}))`,
    ],
    bind: [...values],
  };
}

// Build the WHERE clauses + bind values for the given filters. `alias` is the
// table the filters bind against: the match table `m` (whose materialized
// scalar columns and `id` need no `documents` join) for the count and keyword
// facet counts, or `d` when a live `documents` row is in scope. Optionally skips
// one facet — passing a facet's own name yields its disjunctive (skip-self)
// filter set for that facet's counts.
function buildFilterClauses(
  schema: SchemaInfo,
  filters: DredgeFilters,
  alias: string,
  skipFacet?: string,
): WhereClause {
  const sql: string[] = [];
  const bind: unknown[] = [];
  for (const [name, value] of Object.entries(filters)) {
    if (value === undefined || value === null || name === skipFacet) {
      continue;
    }
    if (schema.scalarColumns.includes(name)) {
      const clause = scalarFilterClause(alias, name, value);
      sql.push(...clause.sql);
      bind.push(...clause.bind);
    } else if (schema.arrayFacets.has(name)) {
      const clause = arrayFilterClause(alias, schema.arrayFacets.get(name)!, value);
      sql.push(...clause.sql);
      bind.push(...clause.bind);
    } else {
      throw invalidFieldError("FILTER_INVALID", schema, name, "filter");
    }
  }
  return { sql, bind };
}

function invalidFieldError(
  code: "FILTER_INVALID" | "QUERY_INVALID",
  schema: SchemaInfo,
  name: string,
  use: string,
): DredgeQueryError {
  const field = schema.fields.get(name);
  if (field) {
    return new DredgeQueryError(
      code,
      `Cannot use ${use} field ${JSON.stringify(name)} because it is a ${field.role} field.`,
    );
  }
  return new DredgeQueryError(code, `Unknown ${use} field ${JSON.stringify(name)}.`);
}

// Built-in free-text columns ordered case-insensitively so alphabetical sorts
// read naturally ("apple" before "Banana"). Other columns (ids, codes, facet
// values) keep their natural BINARY collation, which matches the indexes the
// compiler builds for them and lets those sorts use a covering index.
const NOCASE_SORT_COLUMNS = new Set(["title", "description"]);

// Build the ORDER BY clause. An explicit, valid sort wins; otherwise relevance
// (bm25) ordering is used for keyword queries and document id for match-all
// browse. `d.id` is always appended as a stable tiebreaker.
function buildOrderClause(
  schema: SchemaInfo,
  sort: DredgeSort | undefined,
  usesFts: boolean,
): string {
  if (sort) {
    const field = schema.fields.get(sort.field);
    if (field?.role === "store" || !schema.documentColumns.includes(sort.field)) {
      throw invalidFieldError("QUERY_INVALID", schema, sort.field, "sort");
    }
    const direction = sort.direction === "desc" ? "DESC" : "ASC";
    const collate = NOCASE_SORT_COLUMNS.has(sort.field) ? " COLLATE NOCASE" : "";
    return `ORDER BY d.${quoteIdentifier(sort.field)}${collate} ${direction}, d.id`;
  }
  return usesFts ? `ORDER BY ${MATCH_TABLE}.rank, d.id` : "ORDER BY d.id";
}

// The product of every declared boost, as one SQL factor over `alias`'s
// materialized scalar Facet columns. Multipliers and values are bound rather
// than interpolated: they come out of the artifact, and nothing in an artifact
// belongs in SQL text. `null` when the site declared no boost, so an unboosted
// artifact orders by exactly the expression it did before boosts existed.
//
// Every factor falls back to 1.0 where the Facet is NULL or unmatched, so a
// boost can only ever lift the rows it names.
function boostFactor(
  schema: SchemaInfo,
  alias: string,
): { sql: string; bind: unknown[] } | null {
  if (schema.boosts.length === 0) {
    return null;
  }
  const factors: string[] = [];
  const bind: unknown[] = [];
  for (const boost of schema.boosts) {
    const column = `${alias}.${quoteIdentifier(boost.facet)}`;
    if (boost.shape === "value") {
      const whens = boost.values.map(() => "WHEN ? THEN ?").join(" ");
      factors.push(`CASE ${column} ${whens} ELSE 1.0 END`);
      for (const { value, multiplier } of boost.values) {
        bind.push(value, multiplier);
      }
    } else {
      // julianday() of a NULL or unparseable date is NULL, which COALESCE turns
      // back into no lift. A date in the future is clamped to age zero rather
      // than compounding past the declared maximum.
      factors.push(
        `COALESCE(1.0 + (? - 1.0) * ` +
          `pow(2.0, -max(0.0, julianday('now') - julianday(${column})) / ?), 1.0)`,
      );
      bind.push(boost.maximum, boost.halfLifeDays);
    }
  }
  return { sql: factors.join(" * "), bind };
}

function facetNamesToCount(schema: SchemaInfo, includeFacets: boolean | string[]): string[] {
  if (includeFacets === true) {
    return [...schema.scalarColumns, ...schema.arrayFacets.keys()];
  }
  if (Array.isArray(includeFacets)) {
    for (const name of includeFacets) {
      if (!schema.scalarColumns.includes(name) && !schema.arrayFacets.has(name)) {
        throw invalidFieldError("QUERY_INVALID", schema, name, "facet count");
      }
    }
    return includeFacets;
  }
  return [];
}

// The artifact's Term Variant table: surface form -> the group's other surface
// forms, space separated. Optional — artifacts built before it existed have no
// such table, and a runtime opening one widens nothing.
const TERM_VARIANTS_TABLE = "dredge_term_variants";

// The artifact's Search Column table: one row per full-text column, carrying the
// bm25 weight the maintainer configured and the column's position in the index.
// The compiler writes it into every artifact, so no ranking constant lives here.
const SEARCH_COLUMNS_TABLE = "dredge_search_columns";

// The artifact's boost table: one row per boosted Facet value, one per recency
// curve. Empty when the site declared no boost, which is the common case.
const BOOSTS_TABLE = "dredge_boosts";

// The variant table is keyed on the terms the index holds, so a lookup key has
// to be folded the index's way (`foldTerm`) before it can hit.
function variantLookup(exec: Exec): VariantLookup {
  return (term) => {
    const rows = exec(`SELECT variants FROM ${TERM_VARIANTS_TABLE} WHERE term = ?`, [
      foldTerm(term),
    ]);
    const variants = rows[0]?.[0];
    return typeof variants === "string" && variants.length > 0 ? variants.split(" ") : undefined;
  };
}

// A term is corrected only when the index holds nothing like it, so a word of a
// couple of letters — near half the vocabulary at one edit — is left alone.
const MIN_CORRECTION_LENGTH = 3;

// How many dictionary terms one misspelling widens to. Past a few the
// alternation stops being a guess at the reader's word and starts being a scan.
const MAX_CORRECTIONS_PER_TERM = 3;

// Whether the index holds this exact term. The vocabulary view must already
// exist on the connection.
function inVocabulary(exec: Exec, term: string): boolean {
  return exec(`SELECT 1 FROM temp.${VOCAB_TABLE} WHERE term = ? LIMIT 1`, [term]).length > 0;
}

// Whether the index holds any term this one begins. The out-of-vocabulary test
// for the word still being typed: `cartou` extends to `cartouche`, so it is a
// half-typed word rather than a misspelling, while nothing extends `cartouchr`.
function inVocabularyAsPrefix(exec: Exec, term: string): boolean {
  return (
    exec(`SELECT 1 FROM temp.${VOCAB_TABLE} WHERE term >= ? AND term < ? LIMIT 1`, [
      term,
      prefixUpperBound(term),
    ]).length > 0
  );
}

// The folded terms of a query that may be corrected, each against the test its
// occurrences call for: the prefix test where the term is the word still being
// typed, the exact test otherwise. A term typed both ways takes the prefix test,
// the stricter of the two. `wideable` already excludes phrases, identifiers,
// `field:` operands and `near()` operands; the right side of an exclusion is
// never corrected, so it is not collected.
function collectCorrectable(node: QueryNode, out: Map<string, boolean>): void {
  switch (node.kind) {
    case "term":
      if (node.wideable) {
        const term = foldTerm(node.value);
        out.set(term, (out.get(term) ?? false) || node.prefix);
      }
      return;
    case "near":
    case "and":
    case "or":
      for (const child of node.children) {
        collectCorrectable(child, out);
      }
      return;
    case "scoped":
      collectCorrectable(node.child, out);
      return;
    case "not":
      collectCorrectable(node.left, out);
      return;
    default:
      return;
  }
}

// The corrections a query's terms widen to, keyed by folded term. Only terms the
// vocabulary knows nothing of are scanned, so a correctly spelled query costs
// one indexed probe per term and nothing else.
function planCorrections(exec: Exec, node: QueryNode): DredgeCorrection[] {
  const correctable = new Map<string, boolean>();
  collectCorrectable(node, correctable);
  const planned: DredgeCorrection[] = [];
  for (const [term, prefix] of correctable) {
    const known = prefix ? inVocabularyAsPrefix(exec, term) : inVocabulary(exec, term);
    if (Array.from(term).length < MIN_CORRECTION_LENGTH || known) {
      continue;
    }
    const candidates = corrections(exec, term, MAX_CORRECTIONS_PER_TERM);
    if (candidates.length > 0) {
      planned.push({ term, to: candidates.map((candidate) => candidate.term) });
    }
  }
  return planned;
}

// What to evaluate for a reader's query, at the three widths banding reads: the
// reader's own terms, those widened through their Variant Groups, and those
// widened again through corrections. `variantExpr` is null when Term Variants
// changed nothing, and `matchExpr` — the expression that decides the match set —
// equals the variant width when nothing was corrected.
interface MatchPlan {
  exactExpr: string;
  variantExpr: string | null;
  matchExpr: string;
  corrections: DredgeCorrection[];
  // The surface forms to mark on each hit — the reader's own terms plus whatever
  // widening added, so the marking cannot contradict the match set.
  markForms: MarkForms;
}

// Correction reads the FTS index's own vocabulary, which every artifact has, so
// planning runs whether or not the artifact carries a Term Variant table. The
// vocabulary view must already exist on the connection.
function planMatch(
  exec: Exec,
  schema: SchemaInfo,
  query: string,
  options: ParseQueryOptions = {},
): MatchPlan | null {
  const node = query
    ? parseQuery(
        query,
        schema.searchColumns.map((column) => column.name),
        options,
      )
    : null;
  if (node === null) {
    return null;
  }
  const exactExpr = emitMatchExpression(node);
  const widen = schema.hasTermVariants ? variantLookup(exec) : undefined;
  const variantExpr = widen ? emitMatchExpression(node, widen) : exactExpr;
  const planned = planCorrections(exec, node);
  // Usually the two widenings touch different terms, Variant Groups being keyed
  // on terms the index holds. A group member declared in config but absent from
  // the corpus is both, and its alternation carries its variants then its
  // corrections — so a variant page still bands ahead of a corrected one.
  const byTerm = new Map(planned.map((correction) => [correction.term, correction.to]));
  const correct: CorrectionLookup | undefined =
    byTerm.size > 0 ? (term) => byTerm.get(foldTerm(term)) : undefined;
  return {
    exactExpr,
    variantExpr: variantExpr === exactExpr ? null : variantExpr,
    matchExpr: correct ? emitMatchExpression(node, widen, correct) : variantExpr,
    corrections: planned,
    markForms: markForms(node, widen, correct),
  };
}

// Name of the fixed temp table holding the FTS match: one row per matching
// document (`id`), its scalar facet columns joined once from `documents` so
// every downstream read (count, facet counts, scalar-filter evaluation) reads
// `m` alone and never re-probes `documents`, and — only when relevance ordering
// will be read (a keyword query with no explicit sort) — its bm25 `rank`. FTS5
// has no top-k shortcut for rank, so ranking all matches once here is the right
// shape. `documents_fts MATCH` is evaluated once per distinct match: a session
// reuses the table across requests with the same (match expression, rank) key
// and drops-then-rebuilds on a different key. Worker execution is serial, so a
// single fixed name is safe; every rebuild drops any prior table first.
const MATCH_TABLE = "m";

// Materialize the FTS match into the fixed temp table: one row per matching
// document, its scalar facet columns joined once, and — only when `rank` is set
// (a keyword query with no explicit sort will read relevance ordering) — its
// bm25 rank and its band. Always drops any prior table first, so a leftover from
// a different match is replaced regardless of caller state.
//
// The band is what keeps widening from displacing the reader's own words: 0 for
// a document matching the unwidened expression, 1 for one reached only through a
// Variant Group, 2 for one reached only through a Correction. FTS5 offers no
// per-term weight, so each band boundary is established by evaluating the
// narrower expression again — the cheaper of the pair — as an uncorrelated IN
// subquery, which SQLite materializes once rather than per row. A probe is
// omitted where its expression repeats the one below it, so a query with no
// corrections emits the SQL it emitted before corrections existed. Banding is
// ordering only: every row here is in the match set either way, so the total and
// the facet counts are untouched by it.
function bandExpression(
  matchExpr: string,
  exactExpr: string,
  variantExpr: string | null,
  bind: unknown[],
): string {
  const corrected = matchExpr !== (variantExpr ?? exactExpr);
  if (variantExpr === null && !corrected) {
    // Nothing widened, so every match is an exact match.
    return "0 AS band";
  }
  const probe = "f.rowid IN (SELECT rowid FROM documents_fts WHERE documents_fts MATCH ?)";
  const branches = [`WHEN ${probe} THEN 0`];
  bind.push(exactExpr);
  if (variantExpr !== null && corrected) {
    branches.push(`WHEN ${probe} THEN 1`);
    bind.push(variantExpr);
  }
  return `CASE ${branches.join(" ")} ELSE ${corrected ? 2 : 1} END AS band`;
}

function createMatchTable(
  exec: Exec,
  schema: SchemaInfo,
  matchExpr: string,
  rank: boolean,
  exactExpr: string,
  variantExpr: string | null,
): void {
  const rankColumns: string[] = [];
  const bind: unknown[] = [];
  if (rank) {
    const weights = schema.searchColumns.map((column) => column.weight).join(", ");
    rankColumns.push(`bm25(documents_fts, ${weights}) AS rank`);
    rankColumns.push(bandExpression(matchExpr, exactExpr, variantExpr, bind));
  }
  const scalarColumns = schema.scalarColumns.map((name) => `d.${quoteIdentifier(name)}`);
  const matchColumns = ["f.rowid AS id", ...rankColumns, ...scalarColumns];
  bind.push(matchExpr);
  exec(`DROP TABLE IF EXISTS temp.${MATCH_TABLE}`);
  exec(
    `CREATE TEMP TABLE ${MATCH_TABLE} AS SELECT ${matchColumns.join(", ")} ` +
      `FROM documents_fts f JOIN documents d ON d.id = f.rowid ` +
      `WHERE documents_fts MATCH ?`,
    bind,
  );
}

interface Aggregate {
  total: number;
  facets?: Record<string, DredgeFacetBucket[]>;
}

// Compute the corpus-shaped part of a response — the total and facet buckets —
// which depends only on the match set, filters, and requested facet names (not
// on the hits page). In FTS mode the match temp table must already exist.
function computeAggregate(
  exec: Exec,
  schema: SchemaInfo,
  request: DredgeSearchRequest,
  usesFts: boolean,
): Aggregate {
  const filters = request.filters ?? {};

  // Total matching documents. In FTS mode this reads the match table alone —
  // scalar filters bind against its materialized columns, array filters via
  // EXISTS keyed by `m.id` — so counting never joins `documents`. Browse counts
  // `documents` directly.
  const countFrom = usesFts ? `FROM ${MATCH_TABLE}` : "FROM documents d";
  const countFilter = buildFilterClauses(schema, filters, usesFts ? MATCH_TABLE : "d");
  const countWhere = countFilter.sql.length ? `WHERE ${countFilter.sql.join(" AND ")}` : "";
  const totalRows = exec(`SELECT COUNT(*) ${countFrom} ${countWhere}`, countFilter.bind);
  const total = Number(totalRows[0]?.[0] ?? 0);

  // Facet counts: one plain GROUP BY per requested facet, combined with UNION
  // ALL into a single statement (one worker round trip regardless of the number
  // of dimensions). In FTS mode every count reads the match table `m` — scalar
  // facets group `m`'s materialized columns, array facets group `facet_<name>`
  // joined to `m` — so no read re-probes `documents`. On the browse path scalar
  // facets group `documents` directly (the compiler's `documents_<facet>_idx`
  // covering indexes satisfy these without a table scan) and array facets join
  // `facet_<name>` to `documents`. Each facet applies every *other* active
  // filter (skip-self), keeping counts disjunctive. Buckets order by descending
  // count within each facet; facets follow requested order via `ord`.
  let facets: Record<string, DredgeFacetBucket[]> | undefined;
  const facetNames = [...new Set(facetNamesToCount(schema, request.includeFacets ?? false))];
  if (facetNames.length > 0) {
    facets = Object.fromEntries(facetNames.map((name) => [name, []]));
    const facetAlias = usesFts ? MATCH_TABLE : "d";
    const facetFrom = usesFts ? MATCH_TABLE : "documents d";
    const branches: string[] = [];
    const facetBind: unknown[] = [];
    facetNames.forEach((name, ordinal) => {
      const other = buildFilterClauses(schema, filters, facetAlias, name);
      if (schema.scalarColumns.includes(name)) {
        const column = `${facetAlias}.${quoteIdentifier(name)}`;
        const where = [`${column} IS NOT NULL`, ...other.sql];
        branches.push(
          `SELECT ${ordinal} AS ord, ${column} AS value, COUNT(*) AS n ` +
            `FROM ${facetFrom} WHERE ${where.join(" AND ")} GROUP BY ${column}`,
        );
      } else {
        const table = quoteIdentifier(schema.arrayFacets.get(name)!);
        const where = other.sql.length ? `WHERE ${other.sql.join(" AND ")} ` : "";
        branches.push(
          `SELECT ${ordinal} AS ord, ft.value AS value, COUNT(*) AS n ` +
            `FROM ${table} ft JOIN ${facetFrom} ON ${facetAlias}.id = ft.document_id ` +
            `${where}GROUP BY ft.value`,
        );
      }
      facetBind.push(...other.bind);
    });

    const rows = exec(
      `${branches.join(" UNION ALL ")} ORDER BY ord, n DESC`,
      facetBind,
    );
    for (const row of rows) {
      facets[facetNames[Number(row[0])]].push({
        value: row[1] as string | number | boolean,
        count: Number(row[2]),
      });
    }
  }

  return { total, facets };
}

// Compute the requested page of hits. In FTS mode the match temp table must
// already exist and is joined in place of a live `documents_fts MATCH`;
// otherwise this reads the documents table directly (browse).
function computeHits(
  exec: Exec,
  schema: SchemaInfo,
  request: DredgeSearchRequest,
  usesFts: boolean,
  forms: MarkForms,
): DredgeHit[] {
  const filters = request.filters ?? {};
  const limit = Math.max(0, request.limit ?? 20);
  const offset = Math.max(0, request.offset ?? 0);
  // bm25 rank and band exist (and are read as `score` and `band`, and order the
  // hits) only for a keyword query with no explicit sort; otherwise they were
  // never materialized.
  const usesRank = usesFts && !request.sort;

  const columns = schema.documentColumns;
  const select = columns.map((name) => `d.${quoteIdentifier(name)}`).join(", ");
  let hitSql: string;
  let hitBind: unknown[];
  if (usesRank) {
    // Relevance ordering picks the requested page of ids from the match table
    // alone (scalar filters bind against `m`'s materialized columns, array
    // filters via EXISTS keyed by `m.id` — the same clauses the count uses),
    // then joins `documents` for only that page's display columns instead of
    // probing it for every match. The outer ORDER BY re-asserts page order
    // after the join, which is why the boosted ordering is materialized as its
    // own column: only `mm` is in scope by then. Band leads the ordering, so a
    // boost reorders within a band and can never lift a variant-only or
    // correction-only match above an exact one; `score` stays the raw bm25
    // rank, because boosting is ordering and not scoring.
    const countFilter = buildFilterClauses(schema, filters, MATCH_TABLE);
    const pageWhere = countFilter.sql.length ? `WHERE ${countFilter.sql.join(" AND ")}` : "";
    const boost = boostFactor(schema, MATCH_TABLE);
    const ordering = boost ? `rank * ${boost.sql}` : "rank";
    hitSql =
      `SELECT ${select}, mm.rank AS score, mm.band AS band ` +
      `FROM (SELECT id, rank, band, ${ordering} AS ordering FROM ${MATCH_TABLE} ${pageWhere} ` +
      `ORDER BY band, ordering, id LIMIT ? OFFSET ?) mm ` +
      `JOIN documents d ON d.id = mm.id ORDER BY mm.band, mm.ordering, d.id`;
    hitBind = [...(boost?.bind ?? []), ...countFilter.bind, limit, offset];
  } else {
    // Explicit-sort keyword pages sort on a `documents` column, so the join must
    // precede the sort; browse pages read the documents table directly.
    const from = usesFts
      ? `FROM ${MATCH_TABLE} JOIN documents d ON d.id = ${MATCH_TABLE}.id`
      : "FROM documents d";
    const filterClause = buildFilterClauses(schema, filters, "d");
    const whereSql = filterClause.sql.length ? `WHERE ${filterClause.sql.join(" AND ")}` : "";
    const order = buildOrderClause(schema, request.sort, usesFts);
    hitSql = `SELECT ${select} ${from} ${whereSql} ${order} LIMIT ? OFFSET ?`;
    hitBind = [...filterClause.bind, limit, offset];
  }
  const hitRows = exec(hitSql, hitBind);
  return hitRows.map((row) => {
    const hit: DredgeHit = {};
    columns.forEach((name, index) => {
      hit[name] = row[index] as string | number | boolean | null;
    });
    hit.score = usesRank ? Number(row[columns.length]) : 0;
    // 0 is both "matched the reader's own words" and "no banding ran" — the same
    // convention `score` already uses for a page that was never ranked.
    hit.band = usesRank ? Number(row[columns.length + 1]) : 0;
    // Marking is independent of ranking: an explicitly sorted page carries the
    // same marks as a relevance-ordered one.
    const marks = markFields(hit, forms);
    if (Object.keys(marks).length > 0) {
      hit.marks = marks;
    }
    return hit;
  });
}

// Stateless single-pass search: materialize the match, read total/hits/facets,
// then drop the match table. This is the direct engine entry point (tests, and
// any caller that does not want session-scoped caching). The worker serves
// through a SearchSession, which memoizes across requests instead.
export function search(
  exec: Exec,
  schema: SchemaInfo,
  request: DredgeSearchRequest,
): DredgeSearchResponse {
  const started = performance.now();
  // Planning reads the vocabulary view to decide what is a misspelling, so it
  // has to exist before the query is planned — as it does for `suggest`.
  ensureVocabTable(exec);
  const plan = planMatch(exec, schema, (request.query ?? "").trim());

  if (plan === null) {
    // Browse: no text query, so no FTS evaluation and no temp table — read
    // directly from the documents table as before.
    const { total, facets } = computeAggregate(exec, schema, request, false);
    const hits = computeHits(exec, schema, request, false, []);
    return { total, hits, facets, elapsedMs: performance.now() - started };
  }

  // Single-pass: evaluate the FTS match exactly once into a temp table, then
  // read the count, hits page, and all facet counts from it.
  createMatchTable(exec, schema, plan.matchExpr, !request.sort, plan.exactExpr, plan.variantExpr);
  try {
    const { total, facets } = computeAggregate(exec, schema, request, true);
    const hits = computeHits(exec, schema, request, true, plan.markForms);
    return {
      total,
      hits,
      facets,
      ...(plan.corrections.length > 0 ? { corrections: plan.corrections } : {}),
      elapsedMs: performance.now() - started,
    };
  } finally {
    exec(`DROP TABLE IF EXISTS temp.${MATCH_TABLE}`);
  }
}

// --- Suggestions --------------------------------------------------------------

// An FTS5 vocabulary view over the existing index: (term, doc, cnt) for every
// indexed term. It stores nothing of its own — it reads the index — so a
// suggestion surface costs no artifact bytes. Created in `temp`, which means it
// dies with the connection and is rebuilt after a connection swap.
const VOCAB_TABLE = "dredge_vocab";

// A term held by a single document is more often the corpus's own typo or a
// one-off than the word the reader meant, and offering it back is how a "did you
// mean" loses trust. Corrections apply this floor; completions do not, because
// they compute no edit distance and so need no bound on the candidate set.
const MIN_DOCUMENT_FREQUENCY = 2;

// Leading characters a correction candidate must share with what the reader
// typed. It applies only to typed terms shorter than
// `CORRECTION_WIDE_SCAN_LENGTH`: a short word with its first letter changed is
// nearer to too much of the dictionary to guess from, while a longer word
// carries enough of the reader's intent in the rest of its letters that the
// whole length window can be scanned.
const CORRECTION_PREFIX_LENGTH = 1;

// Typed length at and above which the leading-character filter is dropped, so
// that a typo in the first letter is correctable.
const CORRECTION_WIDE_SCAN_LENGTH = 4;

const SUGGESTION_LIMIT = 10;

// One edit for a short word, two for a longer one. At two edits a four-letter
// word is nearer to most of the dictionary than to what the reader meant.
function maxEditDistance(length: number): number {
  return length <= 4 ? 1 : 2;
}

// A strict upper bound, in SQLite's byte-order comparison of TEXT, for every
// term beginning with `prefix`: U+10FFFF encodes to the largest UTF-8 sequence
// there is. This is a seek hint only — `substr(term, 1, n) = prefix` is what
// makes the predicate exact.
function prefixUpperBound(prefix: string): string {
  return `${prefix}\u{10FFFF}`;
}

// Levenshtein distance over code points, abandoned as soon as no cell in a row
// is within `max`. The prefilter bounds how many candidates are scored; this
// bounds the work each one costs.
function editDistance(a: string[], b: string[], max: number): number {
  if (Math.abs(a.length - b.length) > max) {
    return max + 1;
  }
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array<number>(b.length + 1);
    current[0] = i;
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, substitution);
      best = Math.min(best, current[j]);
    }
    if (best > max) {
      return max + 1;
    }
    previous = current;
  }
  return previous[b.length];
}

// Create the vocabulary view if this connection does not already carry it.
// Idempotent, so a caller that has lost track of its connection may repeat it.
function ensureVocabTable(exec: Exec): void {
  exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS temp.${VOCAB_TABLE} ` +
      `USING fts5vocab(main, documents_fts, 'row')`,
  );
}

// The nearest corpus terms to a misspelling. Candidates are narrowed in SQL by
// length window and the document-frequency floor — and, for a short typed term,
// by leading character — *before* any distance is computed; ranking is by
// distance, then by document frequency, because at equal distance the commoner
// word is the better guess.
function corrections(exec: Exec, term: string, limit: number): DredgeSuggestion[] {
  const typed = Array.from(term);
  const max = maxEditDistance(typed.length);
  const wide = typed.length >= CORRECTION_WIDE_SCAN_LENGTH;
  const prefix = typed.slice(0, CORRECTION_PREFIX_LENGTH).join("");
  const rows = wide
    ? exec(
        `SELECT term, doc FROM temp.${VOCAB_TABLE} ` +
          `WHERE doc >= ? AND length(term) BETWEEN ? AND ?`,
        [MIN_DOCUMENT_FREQUENCY, typed.length - max, typed.length + max],
      )
    : exec(
        `SELECT term, doc FROM temp.${VOCAB_TABLE} ` +
          `WHERE doc >= ? AND term >= ? AND term < ? AND substr(term, 1, ?) = ? ` +
          `AND length(term) BETWEEN ? AND ?`,
        [
          MIN_DOCUMENT_FREQUENCY,
          prefix,
          prefixUpperBound(prefix),
          prefix.length,
          prefix,
          typed.length - max,
          typed.length + max,
        ],
      );

  const scored: DredgeSuggestion[] = [];
  for (const row of rows) {
    const candidate = String(row[0]);
    // The reader's own word is not a correction of itself.
    if (candidate === term) {
      continue;
    }
    const distance = editDistance(typed, Array.from(candidate), max);
    if (distance <= max) {
      scored.push({ term: candidate, documentFrequency: Number(row[1]), distance });
    }
  }
  scored.sort(
    (a, b) =>
      a.distance - b.distance ||
      b.documentFrequency - a.documentFrequency ||
      (a.term < b.term ? -1 : a.term > b.term ? 1 : 0),
  );
  return scored.slice(0, limit);
}

// Corpus terms that extend a prefix, commonest first. No edit distance is
// involved, so SQL alone decides the answer.
function completions(exec: Exec, prefix: string, limit: number): DredgeSuggestion[] {
  const length = Array.from(prefix).length;
  const rows = exec(
    `SELECT term, doc FROM temp.${VOCAB_TABLE} ` +
      `WHERE term > ? AND term < ? AND substr(term, 1, ?) = ? ` +
      `ORDER BY doc DESC, term ASC LIMIT ?`,
    [prefix, prefixUpperBound(prefix), length, prefix, limit],
  );
  return rows.map((row) => {
    const term = String(row[0]);
    return {
      term,
      documentFrequency: Number(row[1]),
      distance: Array.from(term).length - length,
    };
  });
}

// How wide the candidate pool is opened when a Suggestion Context has to be
// verified: enough that a limit's worth normally survives the context, capped so
// the per-candidate count stays proportional to the limit rather than the
// corpus.
const CONTEXT_CANDIDATE_FACTOR = 5;
const MAX_CONTEXT_CANDIDATES = 50;

// A Suggestion Context reduced to what verification needs: the match expression
// the rest of the reader's query plans to, and the filter clauses to apply
// against the `documents` alias.
interface SuggestContext {
  expr: string;
  filter: WhereClause;
}

// Plan a Suggestion Context, or null when there is none to plan. The context's
// last word is complete — the reader moved on to the word being suggested
// against — so trailing-prefix expansion is suppressed; everything else widens
// exactly as the same text would in a search. A context that yields no AST
// (blank, or nothing but exclusions) is no context at all, filters included.
function planSuggestContext(
  exec: Exec,
  schema: SchemaInfo,
  context: DredgeSuggestRequest["context"],
): SuggestContext | null {
  const query = (context?.query ?? "").trim();
  if (!query) {
    return null;
  }
  const plan = planMatch(exec, schema, query, { trailingPrefix: false });
  if (plan === null) {
    return null;
  }
  return {
    expr: plan.matchExpr,
    filter: buildFilterClauses(schema, context?.filters ?? {}, "d"),
  };
}

// How many documents hold this candidate alongside the context, under the
// reader's filters. One FTS count per candidate: the vocabulary view can list
// terms per document, but a short prefix over a large corpus yields millions of
// rows, while verifying a bounded pool costs one indexed count each.
function contextCount(exec: Exec, context: SuggestContext, candidate: string): number {
  const where = ["documents_fts MATCH ?", ...context.filter.sql];
  const rows = exec(
    `SELECT count(*) FROM documents_fts f JOIN documents d ON d.id = f.rowid ` +
      `WHERE ${where.join(" AND ")}`,
    [`(${context.expr}) AND ${ftsExactTerm(candidate)}`, ...context.filter.bind],
  );
  return Number(rows[0]?.[0] ?? 0);
}

// Keep only the candidates the context actually reaches, reporting the in-context
// count as the document frequency so ranking and the response agree on what the
// number means. Completions rank by that count; corrections keep distance first,
// because a nearer word is a better guess than a commoner one.
function verifyInContext(
  exec: Exec,
  context: SuggestContext,
  candidates: DredgeSuggestion[],
  kind: DredgeSuggestKind,
): DredgeSuggestion[] {
  const survivors: DredgeSuggestion[] = [];
  for (const candidate of candidates) {
    const count = contextCount(exec, context, candidate.term);
    if (count > 0) {
      survivors.push({ ...candidate, documentFrequency: count });
    }
  }
  survivors.sort(
    (a, b) =>
      (kind === "correction" ? a.distance - b.distance : 0) ||
      b.documentFrequency - a.documentFrequency ||
      (a.term < b.term ? -1 : a.term > b.term ? 1 : 0),
  );
  return survivors;
}

// Suggestions are drawn from the index's own vocabulary, so every one of them
// leads somewhere. Blank input suggests nothing rather than the whole corpus.
// With a Suggestion Context a wider pool is drawn and then verified against it,
// so every suggestion leads somewhere *in combination with* what the reader has
// already typed.
function collectSuggestions(
  exec: Exec,
  request: DredgeSuggestRequest,
  context: SuggestContext | null,
): DredgeSuggestion[] {
  const term = foldTerm(request.term.trim());
  if (term.length === 0) {
    return [];
  }
  const limit = Math.max(0, request.limit ?? SUGGESTION_LIMIT);
  if (limit === 0) {
    return [];
  }
  const pool = context
    ? Math.min(MAX_CONTEXT_CANDIDATES, CONTEXT_CANDIDATE_FACTOR * limit)
    : limit;
  const candidates =
    request.kind === "completion"
      ? completions(exec, term, pool)
      : corrections(exec, term, pool);
  if (!context) {
    return candidates;
  }
  return verifyInContext(exec, context, candidates, request.kind).slice(0, limit);
}

// Stateless suggestion entry point, the sibling of `search`. A SearchSession
// serves the worker instead, creating the vocabulary view once rather than per
// request.
export function suggest(exec: Exec, request: DredgeSuggestRequest): DredgeSuggestResponse {
  const started = performance.now();
  ensureVocabTable(exec);
  // Only a Suggestion Context needs the schema — to plan its query and to bind
  // its filters — so a request without one pays nothing for introspection.
  const context = request.context
    ? planSuggestContext(exec, introspectSchema(exec), request.context)
    : null;
  return {
    suggestions: collectSuggestions(exec, request, context),
    elapsedMs: performance.now() - started,
  };
}

// A tiny insertion-ordered LRU. Stored values are always defined objects, so a
// missing key is distinguishable by an `undefined` return.
class Lru<V> {
  private readonly map = new Map<string, V>();

  constructor(private readonly max: number) {}

  get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    this.map.set(key, value);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) {
        this.map.delete(oldest);
      }
    }
  }

  clear(): void {
    this.map.clear();
  }
}

// Cache sizes. The database is immutable for the life of a session, so nothing
// here can go stale; the bounds only cap memory over a long session.
const AGGREGATE_CACHE_SIZE = 16;
const RESPONSE_CACHE_SIZE = 32;

function canonicalFilters(filters: DredgeFilters | undefined): Array<[string, DredgeFilterValue]> {
  if (!filters) {
    return [];
  }
  const entries: Array<[string, DredgeFilterValue]> = [];
  for (const [name, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null) {
      entries.push([name, value]);
    }
  }
  // Stable key order so filters that differ only in property order share a key.
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries;
}

function canonicalSort(sort: DredgeSort | undefined): { field: string; direction: string } | null {
  if (!sort) {
    return null;
  }
  return { field: sort.field, direction: sort.direction === "desc" ? "desc" : "asc" };
}

// Session-scoped memoization over an immutable database. Three layers, keyed so
// that key equality matches semantic equality:
//   1. Match-table reuse — the FTS match temp table survives between requests,
//      keyed by (match expression, rank materialized, the two narrower
//      expressions the banding probes evaluate). A same-key
//      request reuses it; a different key rebuilds; reset/close drops it.
//   2. Aggregate cache — {total, facets} keyed by (match, filters, facet names),
//      so paginating a query re-runs only the hits page.
//   3. Response cache — whole responses keyed by the canonical request, so exact
//      repeats (re-renders, multi-tab relay) skip SQLite entirely.
// A worker owns one session and executes serially, so the single fixed match
// table name is safe. `elapsedMs` always reflects the serving request.
export class SearchSession {
  private matchState: {
    matchExpr: string;
    rank: boolean;
    exactExpr: string;
    variantExpr: string | null;
  } | null = null;
  private readonly aggregateCache = new Lru<Aggregate>(AGGREGATE_CACHE_SIZE);
  private readonly responseCache = new Lru<DredgeSearchResponse>(RESPONSE_CACHE_SIZE);
  // Unfiltered-browse facet totals: the buckets for the no-query, no-filter case
  // are corpus constants, so each requested facet is aggregated once — lazily, on
  // the first browse that asks for it — and served from this map thereafter. The
  // matching document total is likewise cached (`browseTotal`). Unlike the caches
  // above this is *data*, not connection state: it is not tied to the temp match
  // table or a particular connection, so ticket 04's same-database connection
  // swap may keep it. Only a close/reset to a *different* database clears it.
  private readonly browseFacetTotals = new Map<string, DredgeFacetBucket[]>();
  private browseTotal: number | undefined;
  // Whether this connection already carries the vocabulary view. It is a virtual
  // table over the index, so it is created once per session rather than per
  // keystroke, and re-created after a connection swap drops the temp schema.
  private vocabReady = false;

  constructor(
    private readonly exec: Exec,
    private readonly schema: SchemaInfo,
  ) {}

  search(request: DredgeSearchRequest): DredgeSearchResponse {
    const started = performance.now();
    this.ensureVocab();
    const plan = planMatch(this.exec, this.schema, (request.query ?? "").trim());
    const matchExpr = plan?.matchExpr ?? null;
    const facetNames = [
      ...new Set(facetNamesToCount(this.schema, request.includeFacets ?? false)),
    ];
    const filters = canonicalFilters(request.filters);

    const responseKey = JSON.stringify({
      m: matchExpr,
      // The banding probes are part of what a page of hits is ordered by, so two
      // reader inputs that widen to the same expression from different words
      // still get their own response.
      x: plan?.exactExpr ?? null,
      v: plan?.variantExpr ?? null,
      f: filters,
      fn: facetNames,
      l: Math.max(0, request.limit ?? 20),
      o: Math.max(0, request.offset ?? 0),
      s: canonicalSort(request.sort),
    });
    const cached = this.responseCache.get(responseKey);
    if (cached) {
      // Exact repeat: no SQLite touched. Every field is the cached response's;
      // only elapsedMs reflects this (serving) request.
      return { ...cached, elapsedMs: performance.now() - started };
    }

    const usesFts = plan !== null;
    if (plan) {
      this.ensureMatchTable(plan.matchExpr, !request.sort, plan.exactExpr, plan.variantExpr);
    }

    let aggregate: Aggregate;
    if (!usesFts && filters.length === 0) {
      // Unfiltered browse: total and facet buckets are corpus constants served
      // from the per-facet session map. Any active filter takes the general
      // aggregate path below instead.
      aggregate = this.browseAggregate(facetNames);
    } else {
      const aggregateKey = JSON.stringify({ m: matchExpr, f: filters, fn: facetNames });
      let cachedAggregate = this.aggregateCache.get(aggregateKey);
      if (!cachedAggregate) {
        cachedAggregate = computeAggregate(this.exec, this.schema, request, usesFts);
        this.aggregateCache.set(aggregateKey, cachedAggregate);
      }
      aggregate = cachedAggregate;
    }

    // The hits page is the only per-request work when the aggregate is cached.
    const hits = computeHits(this.exec, this.schema, request, usesFts, plan?.markForms ?? []);
    const response: DredgeSearchResponse = {
      total: aggregate.total,
      hits,
      facets: aggregate.facets,
      ...(plan && plan.corrections.length > 0 ? { corrections: plan.corrections } : {}),
      elapsedMs: performance.now() - started,
    };
    this.responseCache.set(responseKey, response);
    return response;
  }

  // The nearest corpus terms to a misspelling, or the terms extending a prefix.
  // A separate call from `search`: a reader typing does not need suggestions on
  // every keystroke, so the consumer decides when to ask.
  suggest(request: DredgeSuggestRequest): DredgeSuggestResponse {
    const started = performance.now();
    this.ensureVocab();
    return {
      suggestions: collectSuggestions(
        this.exec,
        request,
        planSuggestContext(this.exec, this.schema, request.context),
      ),
      elapsedMs: performance.now() - started,
    };
  }

  // Drop the connection-scoped caches and the corpus-constant browse map. Called
  // on database close/reset: no cache may span a database change, and a
  // *different* database must never serve stale browse totals (SPEC.md →
  // invalidation is close/reset). Ticket 04's same-database connection swap
  // clears only the connection-scoped caches (see `clearConnectionCaches`) and
  // keeps the browse map, which is data rather than connection state.
  clear(): void {
    this.clearConnectionCaches();
    this.browseFacetTotals.clear();
    this.browseTotal = undefined;
  }

  // Assemble the unfiltered-browse aggregate from the per-facet session map,
  // computing (and memoizing) only the facets not yet present. Each facet is
  // aggregated through the shared `computeAggregate` browse path so its buckets
  // — values, counts, and count-descending order — are byte-identical to a
  // freshly computed multi-facet response. Facets are returned in requested
  // order; the map keeps them independent so {A} then {A,B} computes only B.
  private browseAggregate(facetNames: string[]): Aggregate {
    let facets: Record<string, DredgeFacetBucket[]> | undefined;
    if (facetNames.length > 0) {
      facets = {};
      for (const name of facetNames) {
        let buckets = this.browseFacetTotals.get(name);
        if (buckets === undefined) {
          const computed = computeAggregate(this.exec, this.schema, { includeFacets: [name] }, false);
          buckets = computed.facets![name];
          this.browseFacetTotals.set(name, buckets);
          this.browseTotal ??= computed.total;
        }
        facets[name] = buckets;
      }
    }
    if (this.browseTotal === undefined) {
      this.browseTotal = computeAggregate(this.exec, this.schema, {}, false).total;
    }
    return { total: this.browseTotal, facets };
  }

  // Drop only the connection-scoped caches (match temp table, aggregate and
  // response LRUs), keeping the corpus-constant browse facet-totals map. Public
  // so ticket 04's memory→OPFS connection swap can clear these — the connection
  // changes but the database does not — without discarding the browse totals.
  clearConnectionCaches(): void {
    try {
      this.exec(`DROP TABLE IF EXISTS temp.${MATCH_TABLE}`);
    } catch {
      // The connection may already be gone (close/swap); JS state is reset below
      // regardless, and the temp table dies with its connection.
    }
    this.matchState = null;
    this.aggregateCache.clear();
    this.responseCache.clear();
    // The vocabulary view lives in `temp` and dies with the connection.
    this.vocabReady = false;
  }

  // The vocabulary view backs both suggestion and the out-of-vocabulary test
  // search planning runs, so it is created once per connection rather than per
  // request.
  private ensureVocab(): void {
    if (!this.vocabReady) {
      ensureVocabTable(this.exec);
      this.vocabReady = true;
    }
  }

  private ensureMatchTable(
    matchExpr: string,
    rank: boolean,
    exactExpr: string,
    variantExpr: string | null,
  ): void {
    if (
      this.matchState &&
      this.matchState.matchExpr === matchExpr &&
      this.matchState.rank === rank &&
      this.matchState.exactExpr === exactExpr &&
      this.matchState.variantExpr === variantExpr
    ) {
      return;
    }
    createMatchTable(this.exec, this.schema, matchExpr, rank, exactExpr, variantExpr);
    this.matchState = { matchExpr, rank, exactExpr, variantExpr };
  }
}

export function createSearchSession(exec: Exec, schema: SchemaInfo): SearchSession {
  return new SearchSession(exec, schema);
}
