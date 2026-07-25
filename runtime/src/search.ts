import type { Exec } from "./db";

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
  [field: string]: string | number | boolean | null;
}

export interface DredgeSearchResponse {
  total: number;
  hits: DredgeHit[];
  facets?: Record<string, DredgeFacetBucket[]>;
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

export interface SchemaInfo {
  // Scalar facet columns living directly on the documents table.
  scalarColumns: string[];
  // Array facet name -> join table name (facet_<name>).
  arrayFacets: Map<string, string>;
  fields: Map<string, FieldInfo>;
  // All selectable document columns (excluding content_hash) in stable order.
  documentColumns: string[];
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

  return { scalarColumns, arrayFacets, fields, documentColumns };
}

// Build a forgiving FTS5 MATCH expression from free-text user input. Terms are
// sanitized into quoted searches, with compact/spaced identifier variants
// grouped together so `G7510`, `G 7510`, and `A644_NS` can find the same record.
// Typeahead semantics: only the final term is prefix-expanded — the word still
// being typed — while every earlier term matches exactly.
interface QueryToken {
  text: string;
  subterms: string[];
}

interface QueryTerm {
  subterms: string[];
  identifier: boolean;
}

const TOKEN_RE = /[\p{L}\p{N}]+/gu;
const TOKEN_PART_RE = /[\p{L}]+|\p{N}+/gu;

export function buildMatchExpression(query: string): string | null {
  const terms = queryTerms(query.normalize("NFC"));
  if (terms.length === 0) {
    return null;
  }
  const lastIndex = terms.length - 1;
  return terms
    .map((term, index) => ftsTermExpression(term, index === lastIndex))
    .join(" AND ");
}

function queryTokens(query: string): QueryToken[] {
  const tokens: QueryToken[] = [];
  for (const chunk of query.split(/\s+/)) {
    const subterms = chunk.match(TOKEN_RE) ?? [];
    if (subterms.length > 0) {
      tokens.push({ text: chunk, subterms });
    }
  }
  return tokens;
}

function queryTerms(query: string): QueryTerm[] {
  const tokens = queryTokens(query);
  const terms: QueryTerm[] = [];
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (isIdentifierToken(token)) {
      terms.push({ subterms: token.subterms, identifier: true });
      index += 1;
      continue;
    }

    if (canStartSpacedIdentifier(token)) {
      const subterms = [...token.subterms];
      let nextIndex = index + 1;
      while (nextIndex < tokens.length && canContinueIdentifier(tokens[nextIndex])) {
        subterms.push(...tokens[nextIndex].subterms);
        nextIndex += 1;
      }
      if (nextIndex > index + 1 && hasLettersAndDigits(subterms)) {
        terms.push({ subterms, identifier: true });
        index = nextIndex;
        continue;
      }
    }

    for (const subterm of token.subterms) {
      terms.push({ subterms: [subterm], identifier: false });
    }
    index += 1;
  }
  return terms;
}

function isIdentifierToken(token: QueryToken): boolean {
  const compact = token.subterms.join("");
  return (
    compact.length > 0 &&
    hasLettersAndDigits(token.subterms) &&
    (/^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9]+(?:[_-][A-Za-z0-9]+)*$/.test(token.text) ||
      token.subterms.length > 1 ||
      splitTokenParts(token.subterms).length > 1)
  );
}

function canStartSpacedIdentifier(token: QueryToken): boolean {
  if (token.subterms.length !== 1) {
    return false;
  }
  const subterm = token.subterms[0];
  if (!/[A-Za-z]/.test(subterm)) {
    return false;
  }
  return /\d/.test(subterm) || subterm.length <= 3 || subterm === subterm.toUpperCase();
}

function canContinueIdentifier(token: QueryToken): boolean {
  if (token.subterms.length !== 1) {
    return false;
  }
  const subterm = token.subterms[0];
  return (
    /^\d+$/.test(subterm) ||
    (/^[A-Za-z]+$/.test(subterm) &&
      (subterm.length <= 3 || subterm === subterm.toUpperCase())) ||
    (/^[A-Za-z0-9]+$/.test(subterm) && hasLettersAndDigits([subterm]))
  );
}

function hasLettersAndDigits(values: string[]): boolean {
  const text = values.join("");
  return /[A-Za-z]/.test(text) && /\d/.test(text);
}

// Emit one term's MATCH expression. `isFinal` selects prefix vs exact matching:
// only the final term of a query is prefix-expanded (typeahead — the word still
// being typed), every earlier term matches exactly. A single-character final
// non-identifier term still stays exact: `"a"*` would scan the entire term
// dictionary. Length is counted in code points so an astral character stays
// "length 1" and matches the Python side (SPEC.md → prefix policy).
function ftsTermExpression(term: QueryTerm, isFinal: boolean): string {
  const termExpr = isFinal ? ftsPrefixTerm : ftsExactTerm;
  if (!term.identifier) {
    const subterm = term.subterms[0];
    return isFinal && [...subterm].length > 1 ? ftsPrefixTerm(subterm) : ftsExactTerm(subterm);
  }

  const expressions = [termExpr(term.subterms.join(""))];
  if (term.subterms.length > 1) {
    expressions.push(ftsPhrase(term.subterms, termExpr));
  }
  const tokenParts = splitTokenParts(term.subterms);
  if (tokenParts.length > 1 && tokenParts.join("\0") !== term.subterms.join("\0")) {
    expressions.push(ftsPhrase(tokenParts, termExpr));
  }

  const deduped = [...new Set(expressions)];
  if (deduped.length === 1) {
    return deduped[0];
  }
  return `(${deduped.join(" OR ")})`;
}

function splitTokenParts(subterms: string[]): string[] {
  return subterms.flatMap((subterm) => subterm.match(TOKEN_PART_RE) ?? []);
}

function ftsPhrase(subterms: string[], termExpr: (token: string) => string): string {
  return subterms.map(termExpr).join(" + ");
}

function ftsExactTerm(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

function ftsPrefixTerm(token: string): string {
  return `${ftsExactTerm(token)}*`;
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

// Fixed bm25 column weights for the documents_fts(title, body) index: a title
// hit outranks a body mention by this constant factor. Not configurable in this
// release (SPEC.md → "Query execution (single pass)").
const FTS_TITLE_WEIGHT = 10.0;
const FTS_BODY_WEIGHT = 1.0;

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
// bm25 rank. Always drops any prior table first, so a leftover from a different
// match is replaced regardless of caller state.
function createMatchTable(
  exec: Exec,
  schema: SchemaInfo,
  matchExpr: string,
  rank: boolean,
): void {
  const rankColumn = rank
    ? [`bm25(documents_fts, ${FTS_TITLE_WEIGHT}, ${FTS_BODY_WEIGHT}) AS rank`]
    : [];
  const scalarColumns = schema.scalarColumns.map((name) => `d.${quoteIdentifier(name)}`);
  const matchColumns = ["f.rowid AS id", ...rankColumn, ...scalarColumns];
  exec(`DROP TABLE IF EXISTS temp.${MATCH_TABLE}`);
  exec(
    `CREATE TEMP TABLE ${MATCH_TABLE} AS SELECT ${matchColumns.join(", ")} ` +
      `FROM documents_fts f JOIN documents d ON d.id = f.rowid ` +
      `WHERE documents_fts MATCH ?`,
    [matchExpr],
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
): DredgeHit[] {
  const filters = request.filters ?? {};
  const limit = Math.max(0, request.limit ?? 20);
  const offset = Math.max(0, request.offset ?? 0);
  // bm25 rank exists (and is read as `score`, and orders the hits) only for a
  // keyword query with no explicit sort; otherwise it was never materialized.
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
    // after the join.
    const countFilter = buildFilterClauses(schema, filters, MATCH_TABLE);
    const pageWhere = countFilter.sql.length ? `WHERE ${countFilter.sql.join(" AND ")}` : "";
    hitSql =
      `SELECT ${select}, mm.rank AS score ` +
      `FROM (SELECT id, rank FROM ${MATCH_TABLE} ${pageWhere} ` +
      `ORDER BY rank, id LIMIT ? OFFSET ?) mm ` +
      `JOIN documents d ON d.id = mm.id ORDER BY mm.rank, d.id`;
    hitBind = [...countFilter.bind, limit, offset];
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
  const query = (request.query ?? "").trim();
  const matchExpr = query ? buildMatchExpression(query) : null;

  if (matchExpr === null) {
    // Browse: no text query, so no FTS evaluation and no temp table — read
    // directly from the documents table as before.
    const { total, facets } = computeAggregate(exec, schema, request, false);
    const hits = computeHits(exec, schema, request, false);
    return { total, hits, facets, elapsedMs: performance.now() - started };
  }

  // Single-pass: evaluate the FTS match exactly once into a temp table, then
  // read the count, hits page, and all facet counts from it.
  createMatchTable(exec, schema, matchExpr, !request.sort);
  try {
    const { total, facets } = computeAggregate(exec, schema, request, true);
    const hits = computeHits(exec, schema, request, true);
    return { total, hits, facets, elapsedMs: performance.now() - started };
  } finally {
    exec(`DROP TABLE IF EXISTS temp.${MATCH_TABLE}`);
  }
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
//      keyed by (match expression, rank materialized). A same-key request reuses
//      it; a different key rebuilds; reset/close drops it.
//   2. Aggregate cache — {total, facets} keyed by (match, filters, facet names),
//      so paginating a query re-runs only the hits page.
//   3. Response cache — whole responses keyed by the canonical request, so exact
//      repeats (re-renders, multi-tab relay) skip SQLite entirely.
// A worker owns one session and executes serially, so the single fixed match
// table name is safe. `elapsedMs` always reflects the serving request.
export class SearchSession {
  private matchState: { matchExpr: string; rank: boolean } | null = null;
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

  constructor(
    private readonly exec: Exec,
    private readonly schema: SchemaInfo,
  ) {}

  search(request: DredgeSearchRequest): DredgeSearchResponse {
    const started = performance.now();
    const query = (request.query ?? "").trim();
    const matchExpr = query ? buildMatchExpression(query) : null;
    const facetNames = [
      ...new Set(facetNamesToCount(this.schema, request.includeFacets ?? false)),
    ];
    const filters = canonicalFilters(request.filters);

    const responseKey = JSON.stringify({
      m: matchExpr,
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

    const usesFts = matchExpr !== null;
    if (usesFts) {
      this.ensureMatchTable(matchExpr, !request.sort);
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
    const hits = computeHits(this.exec, this.schema, request, usesFts);
    const response: DredgeSearchResponse = {
      total: aggregate.total,
      hits,
      facets: aggregate.facets,
      elapsedMs: performance.now() - started,
    };
    this.responseCache.set(responseKey, response);
    return response;
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
  }

  private ensureMatchTable(matchExpr: string, rank: boolean): void {
    if (this.matchState && this.matchState.matchExpr === matchExpr && this.matchState.rank === rank) {
      return;
    }
    createMatchTable(this.exec, this.schema, matchExpr, rank);
    this.matchState = { matchExpr, rank };
  }
}

export function createSearchSession(exec: Exec, schema: SchemaInfo): SearchSession {
  return new SearchSession(exec, schema);
}
