from __future__ import annotations

import argparse
import bisect
import fnmatch
import html
import json
import os
import re
import shutil
from collections import Counter
from pathlib import Path
from typing import Any

from dredge.compiler import _extract_values, _normalize_text, _remove_non_indexable_content
from selectolax.parser import HTMLParser


BENCHMARK_ROOT = Path(__file__).resolve().parents[1]
DIST_ROOT = BENCHMARK_ROOT / "dist"
TOKEN_RE = re.compile(r"\b[a-z]{4,30}\b")

# Synthetic facet dimensions assigned deterministically by document index, with
# deliberately varied cardinality so counting "all" facets is meaningfully more
# work than counting "one". benchmark_group stays first and keeps its value
# format because the active-filter workload targets it.
FACET_DIMENSIONS = (
    ("benchmark_group", "group", 8),
    ("kind", "kind", 4),
    ("topic", "topic", 12),
)
LUNR_STOP_WORDS = set(
    """
    able about across after almost also among because been cannot could dear either else ever every
    from have however into just least like likely might most must neither often only other rather said
    says should since some than that their them then there these they this wants were what when where
    which while whom will with would your
    """.split()
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Prepare normalized static-site benchmark corpora")
    parser.add_argument("--site", choices=("small", "medium", "large", "xlarge", "all"), default="all")
    parser.add_argument("--limit", type=int, help="prepare at most this many pages per site")
    return parser.parse_args()


def load_sites() -> dict[str, dict[str, Any]]:
    return json.loads((BENCHMARK_ROOT / "sites.json").read_text(encoding="utf-8"))


def expand_source(value: str) -> Path:
    return Path(os.path.expandvars(os.path.expanduser(value))).resolve()


def selected_paths(config: dict[str, Any], limit: int | None) -> list[Path]:
    source = expand_source(config["source"])
    if not source.is_dir():
        raise SystemExit(f"built site does not exist: {source}")

    paths: set[Path] = set()
    for pattern in config["include"]:
        paths.update(path for path in source.glob(pattern) if path.is_file())

    selected = []
    for path in sorted(paths, key=lambda item: item.relative_to(source).as_posix()):
        relative = path.relative_to(source).as_posix()
        if any(fnmatch.fnmatch(relative, pattern) for pattern in config["exclude"]):
            continue
        selected.append(path)
        if limit is not None and len(selected) >= limit:
            break
    return selected


def extract_document(path: Path, source: Path, config: dict[str, Any], index: int) -> dict[str, str]:
    tree = HTMLParser(path.read_bytes())
    _remove_non_indexable_content(tree)
    title_values = _extract_values(tree, config["title"])
    body_values = _extract_values(tree, config["body"])
    for selector in config["search_fields"]:
        body_values.extend(_extract_values(tree, selector))

    relative = path.relative_to(source).as_posix()
    title = title_values[0] if title_values else relative
    body = _normalize_text(" ".join(body_values))
    facets = {
        name: f"{prefix}{(index - 1) % cardinality}"
        for name, prefix, cardinality in FACET_DIMENSIONS
    }
    return {
        "id": f"doc-{index:06d}",
        "url": f"/{relative.removesuffix('index.html')}",
        "title": title,
        "body": body,
        **facets,
    }


def write_html(document: dict[str, str], destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    title = html.escape(document["title"])
    body = html.escape(document["body"])
    facet_metas = "".join(
        f"<meta data-pagefind-filter=\"{name}[content]\" "
        f"content=\"{html.escape(document[name])}\">"
        for name, _prefix, _cardinality in FACET_DIMENSIONS
    )
    destination.write_text(
        "<!doctype html><html lang=\"en\"><head>"
        f"<meta charset=\"utf-8\"><title>{title}</title>"
        f"{facet_metas}"
        # Sort key so pagefind can return an alphabetical no-keyword browse, the
        # same ordering the other engines use when there is no query.
        f"<meta data-pagefind-sort=\"title[content]\" content=\"{title}\">"
        "</head>"
        f"<body><main data-pagefind-body><h1>{title}</h1><p>{body}</p></main></body></html>\n",
        encoding="utf-8",
    )


def valid_token(token: str) -> bool:
    return len(token) >= 4 and token not in LUNR_STOP_WORDS


def document_phrases(tokens: list[str]) -> set[tuple[str, ...]]:
    """Adjacent 2- and 3-token sequences whose every token is a valid query token."""
    phrases: set[tuple[str, ...]] = set()
    for size in (2, 3):
        for start in range(len(tokens) - size + 1):
            window = tuple(tokens[start : start + size])
            if all(valid_token(token) for token in window) and len(set(window)) == size:
                phrases.add(window)
    return phrases


def prefix_expansion(term: str, sorted_vocabulary: list[str], document_frequency: Counter[str]) -> int:
    """Upper bound on how many documents a prefix search for `term` can match.

    Every benchmarked engine except Lunr expands terms (prefix matching or
    stemming), so a term whose prefix also starts many other frequent tokens
    ("select" -> "selection", "selected", ...) silently turns a narrow band
    into a broad one. Summing the document frequencies of every token sharing
    the prefix overcounts (one document can hold several such tokens) but is a
    cheap, deterministic ceiling for rejecting explosive candidates.
    """
    start = bisect.bisect_left(sorted_vocabulary, term)
    end = bisect.bisect_right(sorted_vocabulary, term + "￿")
    return sum(document_frequency[token] for token in sorted_vocabulary[start:end])


def pick_band(
    candidates: list[tuple[Any, int]],
    target: int,
    chosen: set[Any],
) -> tuple[Any, int] | None:
    available = [item for item in candidates if item[0] not in chosen]
    if not available:
        return None
    return min(available, key=lambda item: (abs(item[1] - target), item[0]))


def choose_workload(
    document_frequency: Counter[str],
    grouped_frequency: Counter[tuple[str, str]],
    phrase_frequency: Counter[tuple[str, ...]],
    phrase_grouped_frequency: Counter[tuple[tuple[str, ...], str]],
    page_count: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Select the query workload: a couple of single tokens, mostly phrases.

    The product under test is rich faceted search, where real queries are
    predominantly multi-word. Single-token bands are kept only as endpoints
    (one rare, one broad); the rest are 2- and 3-word phrases drawn from text
    that actually appears in the corpus, banded by their adjacency document
    frequency (a floor for every engine's AND-of-terms match set).
    """
    token_targets = [
        ("rare", 1),
        ("broad", max(4, round(page_count * 0.10))),
    ]
    phrase_targets = [
        ("phrase-selective", max(2, round(page_count * 0.001))),
        ("phrase-moderate", max(3, round(page_count * 0.02))),
        ("phrase-broad", max(4, round(page_count * 0.10))),
    ]
    trigram_targets = [("phrase3", max(2, round(page_count * 0.005)))]

    token_candidates = [
        (term, count) for term, count in document_frequency.items() if valid_token(term)
    ]
    sorted_vocabulary = sorted(document_frequency)
    workload: list[dict[str, Any]] = []
    chosen_tokens: set[str] = set()
    for label, target in token_targets:
        # Rank the nearest candidates by band distance, then keep the first one
        # whose prefix expansion stays close to its own frequency, so the band
        # label still means something on prefix/stemming engines.
        available = sorted(
            (item for item in token_candidates if item[0] not in chosen_tokens),
            key=lambda item: (abs(item[1] - target), item[0]),
        )
        pick = None
        for term, count in available[:200]:
            if prefix_expansion(term, sorted_vocabulary, document_frequency) <= max(2 * count, count + 2):
                pick = (term, count)
                break
        if pick is None and available:
            pick = available[0]
        if pick is None:
            continue
        chosen_tokens.add(pick[0])
        workload.append(
            {"label": label, "type": "token", "query": pick[0], "document_frequency": pick[1]}
        )

    chosen_phrases: set[tuple[str, ...]] = set()
    for targets, size in ((phrase_targets, 2), (trigram_targets, 3)):
        candidates = [
            (phrase, count) for phrase, count in phrase_frequency.items() if len(phrase) == size
        ]
        for label, target in targets:
            pick = pick_band(candidates, target, chosen_phrases)
            if pick is None:
                continue
            chosen_phrases.add(pick[0])
            workload.append(
                {
                    "label": label,
                    "type": "phrase",
                    "query": " ".join(pick[0]),
                    "document_frequency": pick[1],
                }
            )

    filtered_workload = []
    for item in workload:
        key: Any = tuple(item["query"].split()) if item["type"] == "phrase" else item["query"]
        frequency = phrase_grouped_frequency if item["type"] == "phrase" else grouped_frequency
        groups = [(f"group{index}", frequency[(key, f"group{index}")]) for index in range(8)]
        group, count = max(groups, key=lambda candidate: (candidate[1], candidate[0]))
        filtered_workload.append(
            {
                **item,
                "filter": {"field": "benchmark_group", "value": group},
                "filtered_document_frequency": count,
            }
        )
    return workload, filtered_workload


def prepare_site(key: str, config: dict[str, Any], limit: int | None) -> None:
    source = expand_source(config["source"])
    output = DIST_ROOT / key
    normalized = output / "site"
    shutil.rmtree(output, ignore_errors=True)
    normalized.mkdir(parents=True)

    paths = selected_paths(config, limit)
    if not paths:
        raise SystemExit(f"no HTML files selected for {key} from {source}")

    frequencies: Counter[str] = Counter()
    grouped_frequencies: Counter[tuple[str, str]] = Counter()
    # Phrase candidates are mined from a deterministic sample of documents (a
    # bounded Counter), then counted exactly over the whole corpus in a second
    # streaming pass — full per-document phrase sets over every document would
    # not fit in memory on the extra-large corpus.
    sample_step = max(1, len(paths) // 2_500)
    candidate_phrases: Counter[tuple[str, ...]] = Counter()
    corpus_path = output / "corpus.ndjson"
    with corpus_path.open("w", encoding="utf-8") as corpus:
        for index, path in enumerate(paths, start=1):
            document = extract_document(path, source, config, index)
            corpus.write(json.dumps(document, ensure_ascii=False, separators=(",", ":")) + "\n")
            tokens = TOKEN_RE.findall(f"{document['title']} {document['body']}".lower())
            terms = set(tokens)
            frequencies.update(terms)
            grouped_frequencies.update((term, document["benchmark_group"]) for term in terms)
            if (index - 1) % sample_step == 0:
                candidate_phrases.update(document_phrases(tokens))
            shard = f"{index // 1000:04d}"
            write_html(document, normalized / shard / document["id"] / "index.html")
            if index % 10_000 == 0:
                print(f"{key}: prepared {index:,}/{len(paths):,} pages", flush=True)

    shortlist = {
        phrase
        for phrase, _count in candidate_phrases.most_common(20_000)
        if candidate_phrases[phrase] >= (2 if len(paths) > 2_500 else 1)
    }
    phrase_frequencies: Counter[tuple[str, ...]] = Counter()
    phrase_grouped_frequencies: Counter[tuple[tuple[str, ...], str]] = Counter()
    with corpus_path.open("r", encoding="utf-8") as corpus:
        for line in corpus:
            document = json.loads(line)
            tokens = TOKEN_RE.findall(f"{document['title']} {document['body']}".lower())
            present = document_phrases(tokens) & shortlist
            phrase_frequencies.update(present)
            phrase_grouped_frequencies.update(
                (phrase, document["benchmark_group"]) for phrase in present
            )

    queries, filtered_queries = choose_workload(
        frequencies,
        grouped_frequencies,
        phrase_frequencies,
        phrase_grouped_frequencies,
        len(paths),
    )
    workload = {
        "site": key,
        "source_name": config["name"],
        "page_count": len(paths),
        "queries": queries,
        "filtered_queries": filtered_queries,
        # Facet dimensions available for counting, in canonical order. The first
        # is the "one facet" case; the whole list is the "all facets" case.
        "facets": [
            {"name": name, "values": cardinality}
            for name, _prefix, cardinality in FACET_DIMENSIONS
        ],
    }
    (output / "workload.json").write_text(json.dumps(workload, indent=2) + "\n", encoding="utf-8")
    dredge_output = output / "artifacts" / "dredge"
    dredge_config = {
        "source_dir": str(normalized),
        "output_dir": str(dredge_output),
        "base_url": "/",
        "include": ["**/*.html"],
        "exclude": [],
        "selectors": {"title": "h1", "body": "main"},
        "facets": {
            name: {
                "type": "string",
                "source": f"meta[data-pagefind-filter='{name}[content]']@content",
                "required": True,
            }
            for name, _prefix, _cardinality in FACET_DIMENSIONS
        },
        "store_fields": {},
        "result_fields": ["title", "url"],
        "composite_indices": [],
    }
    (output / "dredge.config.json").write_text(
        json.dumps(dredge_config, indent=2) + "\n", encoding="utf-8"
    )
    print(f"{key}: prepared {len(paths):,} pages; workload={workload['queries']}")


def main() -> None:
    args = parse_args()
    sites = load_sites()
    keys = sites if args.site == "all" else [args.site]
    for key in keys:
        prepare_site(key, sites[key], args.limit)


if __name__ == "__main__":
    main()
