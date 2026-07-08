"""Free-text → FTS5 match-expression escaping.

TypeScript (`runtime/src/search.ts`) is the canonical owner of query
construction; the runtime builds and executes all search SQL. This module
retains only the one piece of genuinely duplicated logic — turning free-text
user input into an FTS5 MATCH expression — because the compiler's build-time
smoke queries need it and because tokenization drift between the two
implementations must fail a test rather than ship. The shared fixture
`tests/fixtures/query-vectors.json` pins this function against
`buildMatchExpression` in the runtime.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

TOKEN_RE = re.compile(r"[^\W_]+", re.UNICODE)
TOKEN_PART_RE = re.compile(r"[^\W_\d]+|\d+", re.UNICODE)
COMPACT_IDENTIFIER_RE = re.compile(
    r"^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9]+(?:[_-][A-Za-z0-9]+)*$"
)


@dataclass(frozen=True)
class _QueryToken:
    text: str
    subterms: tuple[str, ...]


@dataclass(frozen=True)
class _QueryTerm:
    subterms: tuple[str, ...]
    identifier: bool = False


def escape_fts_query(query: str | None) -> str | None:
    if query is None:
        return None
    text = unicodedata.normalize("NFC", query)
    terms = _query_terms(text)
    if not terms:
        return None
    return " AND ".join(_fts_term_expression(term) for term in terms)


def _query_tokens(text: str) -> list[_QueryToken]:
    tokens: list[_QueryToken] = []
    for chunk in text.split():
        subterms = tuple(match.group(0) for match in TOKEN_RE.finditer(chunk))
        if subterms:
            tokens.append(_QueryToken(text=chunk, subterms=subterms))
    return tokens


def _query_terms(text: str) -> list[_QueryTerm]:
    tokens = _query_tokens(text)
    terms: list[_QueryTerm] = []
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if _is_identifier_token(token):
            terms.append(_QueryTerm(token.subterms, identifier=True))
            index += 1
            continue

        if _can_start_spaced_identifier(token):
            subterms = list(token.subterms)
            next_index = index + 1
            while next_index < len(tokens) and _can_continue_identifier(
                tokens[next_index]
            ):
                subterms.extend(tokens[next_index].subterms)
                next_index += 1
            if next_index > index + 1 and _has_letters_and_digits(subterms):
                terms.append(_QueryTerm(tuple(subterms), identifier=True))
                index = next_index
                continue

        terms.extend(_QueryTerm((subterm,)) for subterm in token.subterms)
        index += 1
    return terms


def _is_identifier_token(token: _QueryToken) -> bool:
    compact = "".join(token.subterms)
    return bool(
        compact
        and _has_letters_and_digits(token.subterms)
        and (
            COMPACT_IDENTIFIER_RE.match(token.text)
            or len(token.subterms) > 1
            or len(_split_token_parts(token.subterms)) > 1
        )
    )


def _can_start_spaced_identifier(token: _QueryToken) -> bool:
    if len(token.subterms) != 1:
        return False
    subterm = token.subterms[0]
    has_letter = any(character.isalpha() for character in subterm)
    if not has_letter:
        return False
    return (
        any(character.isdigit() for character in subterm)
        or len(subterm) <= 3
        or subterm.isupper()
    )


def _can_continue_identifier(token: _QueryToken) -> bool:
    if len(token.subterms) != 1:
        return False
    subterm = token.subterms[0]
    return (
        subterm.isdigit()
        or (subterm.isalpha() and (len(subterm) <= 3 or subterm.isupper()))
        or (subterm.isalnum() and _has_letters_and_digits((subterm,)))
    )


def _has_letters_and_digits(subterms: tuple[str, ...] | list[str]) -> bool:
    text = "".join(subterms)
    return any(character.isalpha() for character in text) and any(
        character.isdigit() for character in text
    )


def _fts_term_expression(term: _QueryTerm) -> str:
    if not term.identifier:
        # A standalone single-character non-identifier term is emitted as an
        # exact token, not a prefix: '"a"*' would scan the entire term
        # dictionary. Identical to buildMatchExpression in the runtime; pinned
        # by the shared vectors (SPEC.md -> "Query execution", prefix gating).
        subterm = term.subterms[0]
        if len(subterm) == 1:
            return _fts_exact_term(subterm)
        return _fts_prefix_term(subterm)

    expressions = [_fts_prefix_term("".join(term.subterms))]
    if len(term.subterms) > 1:
        expressions.append(_fts_phrase(term.subterms))
    token_parts = _split_token_parts(term.subterms)
    if len(token_parts) > 1 and token_parts != term.subterms:
        expressions.append(_fts_phrase(token_parts))

    deduped = list(dict.fromkeys(expressions))
    if len(deduped) == 1:
        return deduped[0]
    return "(" + " OR ".join(deduped) + ")"


def _split_token_parts(subterms: tuple[str, ...]) -> tuple[str, ...]:
    parts: list[str] = []
    for subterm in subterms:
        parts.extend(match.group(0) for match in TOKEN_PART_RE.finditer(subterm))
    return tuple(parts)


def _fts_phrase(subterms: tuple[str, ...]) -> str:
    return " + ".join(_fts_prefix_term(subterm) for subterm in subterms)


def _fts_exact_term(token: str) -> str:
    return f'"{token.replace(chr(34), chr(34) + chr(34))}"'


def _fts_prefix_term(token: str) -> str:
    return f"{_fts_exact_term(token)}*"
