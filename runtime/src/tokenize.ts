// The index's own tokenization, reproduced for clients that match text the way
// the index does: NFC (as the Compiler applies before indexing), then FTS5's
// `unicode61 remove_diacritics 2`, read code point by code point from tables
// generated out of SQLite itself. `stemVariant` ports the porter stemmer the
// Compiler groups Term Variants with.

import { FOLDS, SEPARATORS } from "./unicode61";

export interface DredgeToken {
  // The term as the index holds it.
  term: string;
  // UTF-16 offsets into the text that was tokenized.
  start: number;
  end: number;
}

const separatorStarts: number[] = [];
const separatorEnds: number[] = [];
for (let index = 0, end = 0; index < SEPARATORS.length; index += 2) {
  const start = end + SEPARATORS[index];
  end = start + SEPARATORS[index + 1];
  separatorStarts.push(start);
  separatorEnds.push(end);
}

const foldStarts: number[] = [];
for (let index = 0, start = 0; index < FOLDS.length; index += 4) {
  start += FOLDS[index];
  foldStarts.push(start);
}

// The last index in `starts` at or below `cp`, or -1.
function floorIndex(starts: number[], cp: number): number {
  let low = 0;
  let high = starts.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (starts[middle] <= cp) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

function isSeparator(cp: number): boolean {
  if (cp >= 0xd800 && cp <= 0xdfff) {
    return true;
  }
  const index = floorIndex(separatorStarts, cp);
  return index >= 0 && cp <= separatorEnds[index];
}

// The folded code point, or 0 where folding removes it.
function fold(cp: number): number {
  const index = floorIndex(foldStarts, cp);
  if (index < 0) {
    return cp;
  }
  const offset = cp - foldStarts[index];
  const count = FOLDS[index * 4 + 1];
  const stride = FOLDS[index * 4 + 2];
  const delta = FOLDS[index * 4 + 3];
  if (offset % stride !== 0 || offset / stride >= count) {
    return cp;
  }
  return delta === 0 ? 0 : cp + delta;
}

// Tokenize text that is already NFC, mapping each code point to the source
// range `ranges` gives it.
function tokenizeUnits(
  text: string,
  ranges: (offset: number, length: number) => [number, number],
): DredgeToken[] {
  const tokens: DredgeToken[] = [];
  let term = "";
  let start = -1;
  let end = -1;
  const flush = () => {
    if (term) {
      tokens.push({ term, start, end });
    }
    term = "";
    start = -1;
  };
  for (let offset = 0; offset < text.length; ) {
    const cp = text.codePointAt(offset)!;
    const length = cp > 0xffff ? 2 : 1;
    if (isSeparator(cp)) {
      flush();
    } else {
      const [from, to] = ranges(offset, length);
      if (start < 0) {
        start = from;
      }
      end = to;
      const folded = fold(cp);
      if (folded) {
        term += String.fromCodePoint(folded);
      }
    }
    offset += length;
  }
  flush();
  return tokens;
}

/** Split text into the terms the index would hold for it, with their offsets. */
export function tokenize(text: string): DredgeToken[] {
  const composed = text.normalize("NFC");
  if (composed === text) {
    return tokenizeUnits(text, (offset, length) => [offset, offset + length]);
  }
  // NFC never composes across a grapheme cluster, so composing cluster by
  // cluster keeps a map back to the caller's offsets.
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let source = "";
  const starts: number[] = [];
  const ends: number[] = [];
  for (const { segment, index } of segmenter.segment(text)) {
    const normalized = segment.normalize("NFC");
    for (let unit = 0; unit < normalized.length; unit += 1) {
      starts.push(index);
      ends.push(index + segment.length);
    }
    source += normalized;
  }
  return tokenizeUnits(source, (offset, length) => [starts[offset], ends[offset + length - 1]]);
}

/** The index's terms for text, space separated: `Café TEACHERS` -> `cafe teachers`. */
export function normalize(text: string): string {
  return tokenize(text)
    .map((token) => token.term)
    .join(" ");
}

/* -------------------------------------------------------------------------- */
/* Porter stemmer (SQLite's fts5_porter, over UTF-8 bytes as SQLite reads it)  */
/* -------------------------------------------------------------------------- */

const MAX_STEMMED_BYTES = 64;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const A = 0x61;
const E = 0x65;
const I = 0x69;
const L = 0x6c;
const O = 0x6f;
const S = 0x73;
const T = 0x74;
const U = 0x75;
const W = 0x77;
const X = 0x78;
const Y = 0x79;
const Z = 0x7a;

function isVowel(c: number, yIsVowel: boolean): boolean {
  return c === A || c === E || c === I || c === O || c === U || (yIsVowel && c === Y);
}

// The length of the leading [C]VC, or 0 when the stem holds none.
function gobbleVC(stem: Uint8Array, from: number, length: number, previousConsonant: boolean): number {
  let consonant = previousConsonant;
  let index = 0;
  for (; index < length; index += 1) {
    consonant = !isVowel(stem[from + index], consonant);
    if (!consonant) {
      break;
    }
  }
  for (index += 1; index < length; index += 1) {
    consonant = !isVowel(stem[from + index], consonant);
    if (consonant) {
      return index + 1;
    }
  }
  return 0;
}

function mGt0(stem: Uint8Array, length: number): boolean {
  return gobbleVC(stem, 0, length, false) > 0;
}

function mGt1(stem: Uint8Array, length: number): boolean {
  const n = gobbleVC(stem, 0, length, false);
  return n > 0 && gobbleVC(stem, n, length - n, true) > 0;
}

function mEq1(stem: Uint8Array, length: number): boolean {
  const n = gobbleVC(stem, 0, length, false);
  return n > 0 && gobbleVC(stem, n, length - n, true) === 0;
}

function oStar(stem: Uint8Array, length: number): boolean {
  const last = stem[length - 1];
  if (last === W || last === X || last === Y) {
    return false;
  }
  let mask = 0;
  let consonant = false;
  for (let index = 0; index < length; index += 1) {
    consonant = !isVowel(stem[index], consonant);
    mask = ((mask << 1) + (consonant ? 1 : 0)) & 0x7;
  }
  return mask === 0x5;
}

function hasVowel(stem: Uint8Array, length: number): boolean {
  for (let index = 0; index < length; index += 1) {
    if (isVowel(stem[index], index > 0)) {
      return true;
    }
  }
  return false;
}

type Condition = (stem: Uint8Array, length: number) => boolean;
// [suffix, replacement, condition], tried in order until one suffix matches.
type Rule = [string, string, Condition];

const always: Condition = () => true;
const mGt1SorT: Condition = (stem, length) =>
  (stem[length - 1] === S || stem[length - 1] === T) && mGt1(stem, length);

const STEP2: Rule[] = [
  ["ational", "ate", mGt0], ["tional", "tion", mGt0], ["enci", "ence", mGt0],
  ["anci", "ance", mGt0], ["izer", "ize", mGt0], ["logi", "log", mGt0],
  ["bli", "ble", mGt0], ["alli", "al", mGt0], ["entli", "ent", mGt0], ["eli", "e", mGt0],
  ["ousli", "ous", mGt0], ["ization", "ize", mGt0], ["ation", "ate", mGt0],
  ["ator", "ate", mGt0], ["alism", "al", mGt0], ["iveness", "ive", mGt0],
  ["fulness", "ful", mGt0], ["ousness", "ous", mGt0], ["aliti", "al", mGt0],
  ["iviti", "ive", mGt0], ["biliti", "ble", mGt0],
];

const STEP3: Rule[] = [
  ["ical", "ic", mGt0], ["ness", "", mGt0], ["icate", "ic", mGt0], ["iciti", "ic", mGt0],
  ["ful", "", mGt0], ["ative", "", mGt0], ["alize", "al", mGt0],
];

const STEP4: Rule[] = [
  ["al", "", mGt1], ["ance", "", mGt1], ["ence", "", mGt1], ["er", "", mGt1],
  ["ic", "", mGt1], ["able", "", mGt1], ["ible", "", mGt1], ["ant", "", mGt1],
  ["ement", "", mGt1], ["ment", "", mGt1], ["ent", "", mGt1], ["ion", "", mGt1SorT],
  ["ou", "", mGt1], ["ism", "", mGt1], ["ate", "", mGt1], ["iti", "", mGt1],
  ["ous", "", mGt1], ["ive", "", mGt1], ["ize", "", mGt1],
];

const STEP1B2: Rule[] = [
  ["at", "ate", always], ["bl", "ble", always], ["iz", "ize", always],
];

function endsWith(buffer: Uint8Array, length: number, suffix: string): boolean {
  if (length <= suffix.length) {
    return false;
  }
  for (let index = 0; index < suffix.length; index += 1) {
    if (buffer[length - suffix.length + index] !== suffix.charCodeAt(index)) {
      return false;
    }
  }
  return true;
}

// SQLite dispatches each step on the second-to-last letter and stops at the
// first suffix in that group that matches, whether or not its condition holds.
// Grouping by that letter reproduces the dispatch; the rule tables keep
// SQLite's order within each group. Returns the new length and whether a rule
// fired.
function applyStep(buffer: Uint8Array, length: number, rules: Rule[]): [number, boolean] {
  const key = buffer[length - 2];
  for (const [suffix, replacement, condition] of rules) {
    if (suffix.charCodeAt(suffix.length - 2) !== key) {
      continue;
    }
    if (!endsWith(buffer, length, suffix)) {
      continue;
    }
    const stem = length - suffix.length;
    if (!condition(buffer, stem)) {
      return [length, false];
    }
    for (let index = 0; index < replacement.length; index += 1) {
      buffer[stem + index] = replacement.charCodeAt(index);
    }
    return [stem + replacement.length, true];
  }
  return [length, false];
}

/** The stem SQLite's porter tokenizer gives a term the index holds. */
export function stemVariant(term: string): string {
  const bytes = encoder.encode(term);
  if (bytes.length > MAX_STEMMED_BYTES || bytes.length < 3) {
    return term;
  }
  const buffer = new Uint8Array(bytes.length + 2);
  buffer.set(bytes);
  let n = bytes.length;

  // Step 1a.
  if (buffer[n - 1] === S) {
    if (buffer[n - 2] === E) {
      n = (n > 4 && buffer[n - 4] === S && buffer[n - 3] === S) || (n > 3 && buffer[n - 3] === I)
        ? n - 2
        : n - 1;
    } else if (buffer[n - 2] !== S) {
      n -= 1;
    }
  }

  // Step 1b.
  let stripped = false;
  if (buffer[n - 2] === E && endsWith(buffer, n, "eed")) {
    if (mGt0(buffer, n - 3)) {
      n -= 1;
    }
  } else if (buffer[n - 2] === E && endsWith(buffer, n, "ed")) {
    if (hasVowel(buffer, n - 2)) {
      n -= 2;
      stripped = true;
    }
  } else if (buffer[n - 2] === 0x6e && endsWith(buffer, n, "ing")) {
    if (hasVowel(buffer, n - 3)) {
      n -= 3;
      stripped = true;
    }
  }
  if (stripped) {
    let fired: boolean;
    [n, fired] = applyStep(buffer, n, STEP1B2);
    if (!fired) {
      const c = buffer[n - 1];
      if (!isVowel(c, false) && c !== L && c !== S && c !== Z && c === buffer[n - 2]) {
        n -= 1;
      } else if (mEq1(buffer, n) && oStar(buffer, n)) {
        buffer[n] = E;
        n += 1;
      }
    }
  }

  // Step 1c.
  if (buffer[n - 1] === Y && hasVowel(buffer, n - 1)) {
    buffer[n - 1] = I;
  }

  [n] = applyStep(buffer, n, STEP2);
  [n] = applyStep(buffer, n, STEP3);
  [n] = applyStep(buffer, n, STEP4);

  // Step 5a.
  if (buffer[n - 1] === E && (mGt1(buffer, n - 1) || (mEq1(buffer, n - 1) && !oStar(buffer, n - 1)))) {
    n -= 1;
  }

  // Step 5b.
  if (n > 1 && buffer[n - 1] === L && buffer[n - 2] === L && mGt1(buffer, n - 1)) {
    n -= 1;
  }

  return decoder.decode(buffer.subarray(0, n));
}
