// Mark where a reader's query matched the text a hit already carries. The index
// is contentless, so `snippet()` and `highlight()` return NULL against it and
// there is nothing to quote from FTS5; this is a function over the response.
//
// Folding and token boundaries come from the same helpers the match expression
// is built with, because a mark that disagrees with why the row matched is worse
// than no mark. Marks are spans, never markup: Dredge does not own the
// consumer's DOM.

import type { CorrectionLookup, QueryNode, TokenSpan, VariantLookup } from "./query";
import { splitTokenParts, tokenSpans } from "./query";

export interface DredgeMark {
  // Offsets into the field's own string, as returned on the hit.
  start: number;
  length: number;
}

export type DredgeMarks = Record<string, DredgeMark[]>;

// The text fields a hit returns, and so the whole of what can be marked.
const MARKED_FIELDS = ["title", "description"] as const;

// One surface form the query can match in text: subterms that must fall on
// consecutive tokens, with `prefix` applying to the last of them.
export interface MarkForm {
  subterms: string[];
  prefix: boolean;
}

export type MarkForms = readonly MarkForm[];

// The index folds case and strips diacritics (`unicode61 remove_diacritics 2`),
// so text has to be folded the same way before it can be compared with anything
// that matched it.
export function foldTerm(term: string): string {
  return term.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

// Folded text plus, per folded code unit, the source range it came from. Folding
// one code point at a time is what keeps that map: a mark is reported in the
// coordinates of the string the consumer holds, not of the folded copy.
interface FoldedText {
  text: string;
  starts: number[];
  ends: number[];
}

function foldText(source: string): FoldedText {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let index = 0;
  for (const codePoint of source) {
    const folded = foldTerm(codePoint);
    for (let unit = 0; unit < folded.length; unit += 1) {
      starts.push(index);
      ends.push(index + codePoint.length);
    }
    text += folded;
    index += codePoint.length;
  }
  return { text, starts, ends };
}

// Every surface form the query could have matched, in the same shapes the
// emitter matches on: a wideable term plus its Variant Group and its
// corrections, an identifier's three spellings, a phrase's adjacent terms. The
// right side of an exclusion is never collected — it is not why the row is here,
// and cannot be on it.
export function markForms(
  node: QueryNode,
  widen?: VariantLookup,
  correct?: CorrectionLookup,
): MarkForm[] {
  const forms: MarkForm[] = [];
  collectForms(node, widen, correct, forms);
  return forms;
}

function collectForms(
  node: QueryNode,
  widen: VariantLookup | undefined,
  correct: CorrectionLookup | undefined,
  forms: MarkForm[],
): void {
  switch (node.kind) {
    case "term": {
      pushForm(forms, [node.value], node.prefix);
      if (node.wideable) {
        for (const form of [...(widen?.(node.value) ?? []), ...(correct?.(node.value) ?? [])]) {
          pushForm(forms, [form], node.prefix);
        }
      }
      return;
    }
    case "identifier": {
      pushForm(forms, [node.subterms.join("")], node.prefix);
      if (node.subterms.length > 1) {
        pushForm(forms, node.subterms, node.prefix);
      }
      const parts = splitTokenParts(node.subterms);
      if (parts.length > 1) {
        pushForm(forms, parts, node.prefix);
      }
      return;
    }
    case "phrase":
      pushForm(forms, node.terms, false);
      return;
    case "near":
    case "and":
    case "or":
      for (const child of node.children) {
        collectForms(child, widen, correct, forms);
      }
      return;
    case "scoped":
      collectForms(node.child, widen, correct, forms);
      return;
    case "not":
      collectForms(node.left, widen, correct, forms);
      return;
  }
}

function pushForm(forms: MarkForm[], subterms: string[], prefix: boolean): void {
  forms.push({ subterms: subterms.map(foldTerm), prefix });
}

// Marks for one field's text, in that string's own offsets, ordered and with
// overlaps merged so a term and one of its variants landing on the same word
// mark once.
export function markText(source: string, forms: MarkForms): DredgeMark[] {
  if (forms.length === 0) {
    return [];
  }
  const folded = foldText(source);
  const tokens = tokenSpans(folded.text);
  const spans: DredgeMark[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    for (const form of forms) {
      const end = matchFormAt(tokens, index, form);
      if (end !== null) {
        const start = folded.starts[tokens[index].start];
        spans.push({ start, length: folded.ends[end - 1] - start });
      }
    }
  }
  return mergeSpans(spans);
}

// The folded offset just past the form's match starting at token `index`, or
// null where it does not match there. Every subterm but the last must equal its
// token; the last may match a prefix of it, and then marks only as far as it
// matched — so typeahead marking grows with the word instead of flickering over
// the whole of it between keystrokes.
function matchFormAt(
  tokens: readonly TokenSpan[],
  index: number,
  form: MarkForm,
): number | null {
  const last = form.subterms.length - 1;
  if (index + last >= tokens.length) {
    return null;
  }
  for (let offset = 0; offset < last; offset += 1) {
    if (tokens[index + offset].value !== form.subterms[offset]) {
      return null;
    }
  }
  const token = tokens[index + last];
  const subterm = form.subterms[last];
  if (token.value === subterm) {
    return token.end;
  }
  if (form.prefix && subterm.length > 0 && token.value.startsWith(subterm)) {
    return token.start + subterm.length;
  }
  return null;
}

function mergeSpans(spans: DredgeMark[]): DredgeMark[] {
  spans.sort((a, b) => a.start - b.start || b.length - a.length);
  const merged: DredgeMark[] = [];
  for (const span of spans) {
    const previous = merged[merged.length - 1];
    if (previous && span.start <= previous.start + previous.length) {
      previous.length = Math.max(previous.length, span.start + span.length - previous.start);
      continue;
    }
    merged.push({ ...span });
  }
  return merged;
}

// Marks for a hit's marked fields. A field with no match gets no entry at all,
// so absence — not an empty span or an empty string — is how "nothing matched
// here" reads.
export function markFields(values: Record<string, unknown>, forms: MarkForms): DredgeMarks {
  const marks: DredgeMarks = {};
  for (const field of MARKED_FIELDS) {
    const value = values[field];
    if (typeof value !== "string") {
      continue;
    }
    const spans = markText(value, forms);
    if (spans.length > 0) {
      marks[field] = spans;
    }
  }
  return marks;
}
