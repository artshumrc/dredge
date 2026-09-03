// Reader query text -> Query AST -> FTS5 MATCH expression, in two separable
// stages. Nothing else in the runtime may build a match expression, and no
// reader text ever reaches MATCH unparsed: anything the parser rejects degrades
// to the all-terms reading of the raw input rather than raising.

// Columns of the FTS5 index a `field:` scope may name. The compiler's schema is
// fixed at (title, body); maintainer-named search columns arrive later.
export const FTS_COLUMNS = ["title", "body"] as const;

export type QueryNode =
  // A single bare word. `prefix` is the typeahead expansion; `wideable` marks
  // the term as eligible for morphological widening (read downstream, not here).
  | { kind: "term"; value: string; prefix: boolean; wideable: boolean }
  // A bare word that reads as a catalogue identifier, possibly spelled across
  // several whitespace-separated tokens (`G 7510`). Never wideable.
  | { kind: "identifier"; subterms: string[]; prefix: boolean; wideable: false }
  | { kind: "phrase"; terms: string[]; wideable: false }
  | { kind: "near"; children: QueryNode[]; distance: number }
  | { kind: "scoped"; column: string; child: QueryNode }
  | { kind: "and"; children: QueryNode[] }
  | { kind: "or"; children: QueryNode[] }
  | { kind: "not"; left: QueryNode; right: QueryNode };

const TOKEN_RE = /[\p{L}\p{N}]+/gu;
const TOKEN_PART_RE = /[\p{L}]+|\p{N}+/gu;
const FIELD_PREFIX_RE = /^([A-Za-z_][A-Za-z0-9_]*):/;
const DEFAULT_NEAR_DISTANCE = 10;

// Thrown by the parser and caught by `buildQueryAst`, which then degrades. A
// reader never sees a syntax error, so this type never escapes this module.
class QuerySyntaxError extends Error {}

/* -------------------------------------------------------------------------- */
/* Lexer                                                                       */
/* -------------------------------------------------------------------------- */

type Token =
  | { kind: "word"; text: string }
  | { kind: "phrase"; text: string }
  | { kind: "minus" }
  | { kind: "or" }
  | { kind: "lparen" }
  | { kind: "rparen" }
  | { kind: "comma" };

const DELIMITERS = new Set(["(", ")", ",", '"']);

function lex(input: string): Token[] {
  // A `-` opens an exclusion only where a term could start; elsewhere it is an
  // ordinary character so `14-11-206` keeps the shape the reader typed.
  const opensTerm = (at: number) => at === 0 || /[\s(]/.test(input[at - 1]);
  const tokens: Token[] = [];
  let index = 0;
  while (index < input.length) {
    const char = input[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "(") {
      tokens.push({ kind: "lparen" });
      index += 1;
      continue;
    }
    if (char === ")") {
      tokens.push({ kind: "rparen" });
      index += 1;
      continue;
    }
    if (char === ",") {
      tokens.push({ kind: "comma" });
      index += 1;
      continue;
    }
    if (char === '"') {
      const close = input.indexOf('"', index + 1);
      if (close === -1) {
        throw new QuerySyntaxError("unterminated quote");
      }
      tokens.push({ kind: "phrase", text: input.slice(index + 1, close) });
      index = close + 1;
      continue;
    }
    if (char === "-" && opensTerm(index)) {
      tokens.push({ kind: "minus" });
      index += 1;
      continue;
    }
    let end = index;
    while (end < input.length && !/\s/.test(input[end]) && !DELIMITERS.has(input[end])) {
      end += 1;
    }
    const text = input.slice(index, end);
    tokens.push(text === "OR" ? { kind: "or" } : { kind: "word", text });
    index = end;
  }
  return tokens;
}

/* -------------------------------------------------------------------------- */
/* Parser                                                                      */
/* -------------------------------------------------------------------------- */

class Parser {
  private index = 0;
  // Every leaf node in the order the reader typed it. Only the final one is a
  // prefix candidate, and only when it is a bare term rather than a phrase.
  readonly leaves: QueryNode[] = [];

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private next(): Token {
    const token = this.tokens[this.index];
    if (!token) {
      throw new QuerySyntaxError("unexpected end of query");
    }
    this.index += 1;
    return token;
  }

  parse(): QueryNode | null {
    const node = this.parseOr();
    if (this.index !== this.tokens.length) {
      throw new QuerySyntaxError("trailing input");
    }
    return node;
  }

  private parseOr(): QueryNode | null {
    const children: QueryNode[] = [];
    const first = this.parseAnd();
    if (first) {
      children.push(first);
    }
    while (this.peek()?.kind === "or") {
      this.next();
      const node = this.parseAnd();
      if (!node) {
        throw new QuerySyntaxError("empty OR operand");
      }
      children.push(node);
    }
    if (children.length === 0) {
      return null;
    }
    return children.length === 1 ? children[0] : { kind: "or", children };
  }

  private parseAnd(): QueryNode | null {
    const positives: QueryNode[] = [];
    const negatives: QueryNode[] = [];
    // Consecutive bare words are grouped before term construction so a spaced
    // identifier (`G 7510`) is still recognised as one term.
    let bareWords: string[] = [];
    const flush = () => {
      if (bareWords.length > 0) {
        positives.push(...this.plainNodes(bareWords));
        bareWords = [];
      }
    };

    for (;;) {
      const token = this.peek();
      if (!token || token.kind === "or" || token.kind === "rparen" || token.kind === "comma") {
        break;
      }
      if (token.kind === "minus") {
        this.next();
        flush();
        negatives.push(this.parsePrimary());
        continue;
      }
      if (token.kind === "word" && !this.startsOperator()) {
        bareWords.push(token.text);
        this.next();
        continue;
      }
      flush();
      positives.push(this.parsePrimary());
    }
    flush();

    if (positives.length === 0) {
      if (negatives.length === 0) {
        return null;
      }
      // FTS5's NOT is binary: a query of nothing but exclusions has no left
      // operand and cannot be emitted at all.
      throw new QuerySyntaxError("exclusion without a term to exclude from");
    }

    let left: QueryNode =
      positives.length === 1 ? positives[0] : { kind: "and", children: positives };
    for (const right of negatives) {
      left = { kind: "not", left, right };
    }
    return left;
  }

  // True when the word at the cursor opens a construct rather than being a bare
  // term: `near(`, or a `field:` scope.
  private startsOperator(): boolean {
    const token = this.peek();
    if (token?.kind !== "word") {
      return false;
    }
    if (token.text.toLowerCase() === "near" && this.tokens[this.index + 1]?.kind === "lparen") {
      return true;
    }
    return FIELD_PREFIX_RE.test(token.text);
  }

  private parsePrimary(): QueryNode {
    const token = this.next();
    if (token.kind === "phrase") {
      return this.leaf(phraseNode(token.text));
    }
    if (token.kind === "lparen") {
      const node = this.parseOr();
      if (this.next().kind !== "rparen") {
        throw new QuerySyntaxError("unbalanced parenthesis");
      }
      if (!node) {
        throw new QuerySyntaxError("empty group");
      }
      return node;
    }
    if (token.kind !== "word") {
      throw new QuerySyntaxError(`unexpected ${token.kind}`);
    }
    if (token.text.toLowerCase() === "near" && this.peek()?.kind === "lparen") {
      return this.parseNear();
    }
    const scope = FIELD_PREFIX_RE.exec(token.text);
    if (scope) {
      return this.parseScoped(scope[1], token.text.slice(scope[0].length));
    }
    const nodes = this.plainNodes([token.text]);
    if (nodes.length !== 1) {
      throw new QuerySyntaxError("operand is not a single term");
    }
    return nodes[0];
  }

  private parseScoped(column: string, rest: string): QueryNode {
    if (!(FTS_COLUMNS as readonly string[]).includes(column)) {
      throw new QuerySyntaxError(`unknown field ${column}`);
    }
    let child: QueryNode;
    if (rest.length > 0) {
      const nodes = this.plainNodes([rest]);
      if (nodes.length !== 1) {
        throw new QuerySyntaxError("scoped operand is not a single term");
      }
      child = nodes[0];
    } else {
      child = this.parsePrimary();
    }
    // A `field:` scope is the reader's opt-out from widening, exactly as
    // quotation marks are, so nothing beneath it stays wideable.
    markNotWideable(child);
    return { kind: "scoped", column, child };
  }

  private parseNear(): QueryNode {
    this.next(); // lparen
    const children: QueryNode[] = [];
    while (this.peek() && this.peek()!.kind !== "comma" && this.peek()!.kind !== "rparen") {
      const token = this.next();
      if (token.kind === "phrase") {
        children.push(this.leaf(phraseNode(token.text)));
        continue;
      }
      if (token.kind !== "word") {
        throw new QuerySyntaxError("NEAR takes terms and phrases only");
      }
      const subterms = tokenSubterms(token.text);
      if (subterms.length === 0) {
        throw new QuerySyntaxError("empty NEAR operand");
      }
      // NEAR operands are positional, so they are never widened.
      children.push(
        this.leaf(
          subterms.length === 1
            ? { kind: "term", value: subterms[0], prefix: false, wideable: false }
            : { kind: "phrase", terms: subterms, wideable: false },
        ),
      );
    }
    let distance = DEFAULT_NEAR_DISTANCE;
    if (this.peek()?.kind === "comma") {
      this.next();
      const token = this.next();
      if (token.kind !== "word" || !/^\d+$/.test(token.text)) {
        throw new QuerySyntaxError("NEAR distance is not a number");
      }
      distance = Number(token.text);
    }
    if (this.next().kind !== "rparen") {
      throw new QuerySyntaxError("unbalanced NEAR");
    }
    if (children.length < 2) {
      throw new QuerySyntaxError("NEAR needs at least two operands");
    }
    return { kind: "near", children, distance };
  }

  private leaf(node: QueryNode): QueryNode {
    this.leaves.push(node);
    return node;
  }

  private plainNodes(words: string[]): QueryNode[] {
    return queryTerms(words).map((term) => this.leaf(termNode(term)));
  }
}

function markNotWideable(node: QueryNode): void {
  switch (node.kind) {
    case "term":
      node.wideable = false;
      return;
    case "identifier":
    case "phrase":
      return;
    case "near":
    case "and":
    case "or":
      node.children.forEach(markNotWideable);
      return;
    case "scoped":
      markNotWideable(node.child);
      return;
    case "not":
      markNotWideable(node.left);
      markNotWideable(node.right);
      return;
  }
}

function phraseNode(text: string): QueryNode {
  const terms = tokenSubterms(text);
  if (terms.length === 0) {
    throw new QuerySyntaxError("empty phrase");
  }
  return { kind: "phrase", terms, wideable: false };
}

function tokenSubterms(text: string): string[] {
  return text.match(TOKEN_RE) ?? [];
}

/* -------------------------------------------------------------------------- */
/* Bare-word terms and identifier grouping                                     */
/* -------------------------------------------------------------------------- */

interface QueryToken {
  text: string;
  subterms: string[];
}

interface QueryTerm {
  subterms: string[];
  identifier: boolean;
}

function queryTokens(words: string[]): QueryToken[] {
  const tokens: QueryToken[] = [];
  for (const chunk of words) {
    const subterms = tokenSubterms(chunk);
    if (subterms.length > 0) {
      tokens.push({ text: chunk, subterms });
    }
  }
  return tokens;
}

// Group bare words into terms, folding compact and spaced identifier spellings
// (`G7510`, `G 7510`, `A644_NS`) into one identifier term so they can find the
// same record.
function queryTerms(words: string[]): QueryTerm[] {
  const tokens = queryTokens(words);
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

function termNode(term: QueryTerm): QueryNode {
  if (term.identifier) {
    return { kind: "identifier", subterms: term.subterms, prefix: false, wideable: false };
  }
  return { kind: "term", value: term.subterms[0], prefix: false, wideable: true };
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

function splitTokenParts(subterms: string[]): string[] {
  return subterms.flatMap((subterm) => subterm.match(TOKEN_PART_RE) ?? []);
}

/* -------------------------------------------------------------------------- */
/* AST construction                                                            */
/* -------------------------------------------------------------------------- */

// Typeahead: only the last term the reader typed is prefix-expanded — the word
// still being typed — while every earlier term matches exactly. A single-code-
// point final term stays exact, because `"a"*` would scan the whole term
// dictionary. Length is counted in code points so an astral character stays
// "length 1".
function applyTrailingPrefix(leaves: QueryNode[]): void {
  const last = leaves[leaves.length - 1];
  if (!last) {
    return;
  }
  if (last.kind === "identifier" || (last.kind === "term" && [...last.value].length > 1)) {
    last.prefix = true;
  }
}

// Parse reader text into a Query AST. Unparseable input degrades to the
// all-terms reading of the raw string — the behaviour before a grammar existed —
// so a reader never sees a syntax error. Returns null when there is nothing to
// search for.
export function parseQuery(input: string): QueryNode | null {
  const query = input.normalize("NFC");
  try {
    const parser = new Parser(lex(query));
    const node = parser.parse();
    if (!node) {
      return null;
    }
    applyTrailingPrefix(parser.leaves);
    return node;
  } catch (error) {
    if (!(error instanceof QuerySyntaxError)) {
      throw error;
    }
    return degradeQuery(query);
  }
}

function degradeQuery(query: string): QueryNode | null {
  const nodes = queryTerms(query.split(/\s+/)).map(termNode);
  if (nodes.length === 0) {
    return null;
  }
  applyTrailingPrefix(nodes);
  return nodes.length === 1 ? nodes[0] : { kind: "and", children: nodes };
}

/* -------------------------------------------------------------------------- */
/* Emitter                                                                     */
/* -------------------------------------------------------------------------- */

function ftsExactTerm(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

function ftsPrefixTerm(token: string): string {
  return `${ftsExactTerm(token)}*`;
}

function ftsPhrase(subterms: string[], termExpr: (token: string) => string): string {
  return subterms.map(termExpr).join(" + ");
}

// A catalogue identifier matches its compact spelling, its spaced spelling, and
// its letter/digit split, so `G7510`, `G 7510` and `A644_NS` all find the same
// record.
function emitIdentifier(subterms: string[], prefix: boolean): string {
  const termExpr = prefix ? ftsPrefixTerm : ftsExactTerm;
  const expressions = [termExpr(subterms.join(""))];
  if (subterms.length > 1) {
    expressions.push(ftsPhrase(subterms, termExpr));
  }
  const tokenParts = splitTokenParts(subterms);
  if (tokenParts.length > 1 && tokenParts.join("\0") !== subterms.join("\0")) {
    expressions.push(ftsPhrase(tokenParts, termExpr));
  }
  const deduped = [...new Set(expressions)];
  return deduped.length === 1 ? deduped[0] : `(${deduped.join(" OR ")})`;
}

// The other surface forms of a term's Variant Group, or nothing when the term
// belongs to no group. Supplied by the runtime, which reads the artifact's
// `dredge_term_variants` table; an artifact without that table supplies none.
export type VariantLookup = (term: string) => readonly string[] | undefined;

// FTS5 binds NOT tighter than AND, and AND tighter than OR, so a node is
// parenthesised only where the emitted string would otherwise regroup.
function emitOperand(node: QueryNode, looserThan: "and" | "not", widen?: VariantLookup): string {
  const needsParens =
    node.kind === "or" || (looserThan === "not" && (node.kind === "and" || node.kind === "not"));
  const emitted = emitNode(node, widen);
  return needsParens ? `(${emitted})` : emitted;
}

// A wideable term matches its whole Variant Group. The alternation is always
// parenthesised so it stays one operand wherever it sits. The reader's own form
// leads, and the prefix rule applies to every form alike: whether the term is
// the one still being typed is a property of the query, not of the group.
function emitTerm(node: Extract<QueryNode, { kind: "term" }>, widen?: VariantLookup): string {
  const termExpr = node.prefix ? ftsPrefixTerm : ftsExactTerm;
  const variants = node.wideable && widen ? widen(node.value) : undefined;
  if (!variants || variants.length === 0) {
    return termExpr(node.value);
  }
  return `(${[node.value, ...variants].map(termExpr).join(" OR ")})`;
}

function emitNode(node: QueryNode, widen?: VariantLookup): string {
  switch (node.kind) {
    case "term":
      return emitTerm(node, widen);
    case "identifier":
      return emitIdentifier(node.subterms, node.prefix);
    case "phrase":
      return ftsPhrase(node.terms, ftsExactTerm);
    case "near":
      return `NEAR(${node.children.map((child) => emitNode(child)).join(" ")}, ${node.distance})`;
    case "scoped":
      return `{${node.column}}:${emitOperand(node.child, "not", widen)}`;
    case "and":
      return node.children.map((child) => emitOperand(child, "and", widen)).join(" AND ");
    case "or":
      return node.children.map((child) => emitNode(child, widen)).join(" OR ");
    case "not":
      return `${emitOperand(node.left, "not", widen)} NOT ${emitOperand(node.right, "not", widen)}`;
  }
}

// Emit the FTS5 match expression for a Query AST. With no `widen` the expression
// is the reader's own terms and nothing else, which is what the banding probe
// evaluates.
export function emitMatchExpression(node: QueryNode, widen?: VariantLookup): string {
  return emitNode(node, widen);
}

export function buildMatchExpression(query: string, widen?: VariantLookup): string | null {
  const node = parseQuery(query);
  return node === null ? null : emitMatchExpression(node, widen);
}
