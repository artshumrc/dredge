from __future__ import annotations

import fnmatch
import hashlib
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import time
import unicodedata
from collections.abc import Callable, Iterator, Sequence
from concurrent.futures import ProcessPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass, field as dataclass_field
from datetime import date
from pathlib import Path, PurePosixPath
from typing import Any, TextIO
from urllib.parse import urljoin

from selectolax.parser import HTMLParser

import brotli

from .progress import CompileProgress

DB_SCHEMA_VERSION = 3
MANIFEST_VERSION = 1
# Oldest Runtime that can read what this compiler emits. Bump only when a
# format change actually breaks older Runtimes, not on every release.
RUNTIME_MIN_VERSION = "0.1.0"
SQLITE_PAGE_SIZE = 16_384
DB_COMPRESSION = "brotli"
BROTLI_MIN_QUALITY = 0
BROTLI_MAX_QUALITY = 11
BROTLI_QUALITY = 11
BATCH_SIZE = 10_000
INSERT_BATCH_SIZE = 5_000
PROGRESS_DOCUMENT_INTERVAL = 5_000
PROGRESS_TIME_INTERVAL_SECONDS = 10.0
METRICS_VERSION = 1
MAX_WARNING_SAMPLES = 3
PAYLOAD_HIGH_CARDINALITY_THRESHOLD = 1000
PAYLOAD_DUPLICATE_COLUMN_RATIO = 0.9

# The tokenizer the shipped index is built with. Declared variant terms are
# folded through it so a config's ``Ramessès`` keys the row the index stores.
FTS_TOKENIZER = "unicode61 remove_diacritics 2"
# Stemming tokenizer used only at build time, to group surface forms. No
# stemmer ever ships to the browser: the variant table is keyed on surface
# forms precisely so the Runtime never has to reproduce this.
VARIANT_STEM_TOKENIZER = f"porter {FTS_TOKENIZER}"

IDENTIFIER_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")
ATTRIBUTE_RE = re.compile(r"^[A-Za-z_:][-A-Za-z0-9_:.]*$")
TOKEN_RE = re.compile(r"[\w]+", re.UNICODE)

TOP_LEVEL_KEYS = {
    "$schema",
    "source_dir",
    "output_dir",
    "base_url",
    "include",
    "exclude",
    "selectors",
    "search_fields",
    "facets",
    "store_fields",
    "result_fields",
    "composite_indices",
    "client",
    "allow_output_in_source",
    "variant_generation",
    "synonym_groups",
    "suppressed_variants",
}
SELECTOR_KEYS = {"title", "body", "description"}
FACET_KEYS = {"type", "source", "required"}
CLIENT_KEYS = {"out", "worker_url"}
FACET_TYPES = {"string", "string_array", "integer", "number", "boolean", "date"}
STORE_FIELD_TYPES = {"string", "integer", "number", "boolean", "date"}
SCALAR_SQL_TYPES = {
    "string": "TEXT",
    "integer": "INTEGER",
    "number": "REAL",
    "boolean": "INTEGER",
    "date": "TEXT",
}


class BuildError(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        path: Path | None = None,
        field: str | None = None,
        selector: str | None = None,
        value: Any | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.path = path
        self.field = field
        self.selector = selector
        self.value = value

    def __reduce__(
        self,
    ) -> tuple[Callable[..., "BuildError"], tuple[Any, ...]]:
        # The keyword-only fields are lost by Exception's default pickling
        # (which reconstructs from ``self.args``), so a BuildError raised in an
        # extraction worker would reach the parent stripped of its code/path.
        # Rebuild through the real constructor to keep them intact.
        return (
            _rebuild_build_error,
            (
                self.code,
                str(self),
                self.path,
                self.field,
                self.selector,
                self.value,
            ),
        )


def _rebuild_build_error(
    code: str,
    message: str,
    path: Path | None,
    field: str | None,
    selector: str | None,
    value: Any | None,
) -> "BuildError":
    return BuildError(
        code,
        message,
        path=path,
        field=field,
        selector=selector,
        value=value,
    )


@dataclass(frozen=True)
class BuildWarning:
    code: str
    message: str
    path: Path | None = None
    field: str | None = None
    selector: str | None = None
    count: int = 1
    sample_paths: tuple[Path, ...] = dataclass_field(default_factory=tuple)


@dataclass
class _WarningBucket:
    code: str
    message: str
    field: str | None
    selector: str | None
    count: int = 0
    sample_paths: list[Path] = dataclass_field(default_factory=list)


class _WarningCollector:
    def __init__(self, sample_limit: int = MAX_WARNING_SAMPLES) -> None:
        self._sample_limit = sample_limit
        self._buckets: dict[
            tuple[str, str | None, str | None, str], _WarningBucket
        ] = {}
        self._order: list[tuple[str, str | None, str | None, str]] = []

    def add(
        self,
        *,
        code: str,
        message: str,
        path: Path | None = None,
        field: str | None = None,
        selector: str | None = None,
    ) -> None:
        key = (code, field, selector, message)
        bucket = self._buckets.get(key)
        if bucket is None:
            bucket = _WarningBucket(
                code=code, message=message, field=field, selector=selector
            )
            self._buckets[key] = bucket
            self._order.append(key)

        bucket.count += 1
        if path is not None and len(bucket.sample_paths) < self._sample_limit:
            bucket.sample_paths.append(path)

    def to_warnings(self) -> tuple[BuildWarning, ...]:
        warnings: list[BuildWarning] = []
        for key in self._order:
            bucket = self._buckets[key]
            sample_paths = tuple(bucket.sample_paths)
            samples = ", ".join(str(path) for path in sample_paths)
            occurrence = "occurrence" if bucket.count == 1 else "occurrences"
            sample_label = "sample" if len(sample_paths) == 1 else "samples"
            if samples:
                message = f"{bucket.message} ({bucket.count} {occurrence}; {sample_label}: {samples})"
            else:
                message = f"{bucket.message} ({bucket.count} {occurrence})"
            warnings.append(
                BuildWarning(
                    code=bucket.code,
                    message=message,
                    path=sample_paths[0] if sample_paths else None,
                    field=bucket.field,
                    selector=bucket.selector,
                    count=bucket.count,
                    sample_paths=sample_paths,
                )
            )
        return tuple(warnings)


class _DocumentWarnings:
    """A per-document warning sink with the same ``add`` signature as
    :class:`_WarningCollector`.

    Extraction runs in worker processes, so a document's warnings are recorded
    here and returned to the parent, which replays them into the single
    :class:`_WarningCollector` in candidate order. Replaying in order reproduces
    the exact bucket counts and sample-path selection of a serial run.
    """

    def __init__(self) -> None:
        self.records: list[dict[str, Any]] = []

    def add(
        self,
        *,
        code: str,
        message: str,
        path: Path | None = None,
        field: str | None = None,
        selector: str | None = None,
    ) -> None:
        self.records.append(
            {
                "code": code,
                "message": message,
                "path": path,
                "field": field,
                "selector": selector,
            }
        )


@dataclass(frozen=True)
class FacetConfig:
    name: str
    type: str
    source: str
    required: bool = False

    @property
    def is_array(self) -> bool:
        return self.type == "string_array"


@dataclass(frozen=True)
class SearchFieldConfig:
    source: str


@dataclass(frozen=True)
class DredgeConfig:
    path: Path
    raw: dict[str, Any]
    source_dir: Path
    output_dir: Path
    base_url: str
    include: tuple[str, ...]
    exclude: tuple[str, ...]
    selectors: dict[str, str]
    search_fields: tuple[SearchFieldConfig, ...]
    facets: tuple[FacetConfig, ...]
    store_fields: tuple[FacetConfig, ...]
    result_fields: tuple[str, ...]
    composite_indices: tuple[tuple[str, ...], ...]
    client: dict[str, str]
    allow_output_in_source: bool
    variant_generation: bool
    synonym_groups: tuple[tuple[str, ...], ...]
    suppressed_variants: tuple[tuple[str, str], ...]
    config_hash: str

    @property
    def facet_map(self) -> dict[str, FacetConfig]:
        return {facet.name: facet for facet in self.facets}

    @property
    def store_field_map(self) -> dict[str, FacetConfig]:
        return {field.name: field for field in self.store_fields}

    @property
    def field_map(self) -> dict[str, FacetConfig]:
        return {field.name: field for field in (*self.facets, *self.store_fields)}

    @property
    def scalar_facets(self) -> tuple[FacetConfig, ...]:
        return tuple(facet for facet in self.facets if not facet.is_array)

    @property
    def array_facets(self) -> tuple[FacetConfig, ...]:
        return tuple(facet for facet in self.facets if facet.is_array)


@dataclass(frozen=True)
class FileCandidate:
    path: Path
    rel_path: str
    url: str


@dataclass(frozen=True)
class SkippedFile:
    path: Path
    reason: str


@dataclass
class ExtractedDocument:
    id: int
    url: str
    title: str
    description: str | None
    body: str
    scalar_facets: dict[str, str | int | float | None]
    array_facets: dict[str, tuple[str, ...]]
    store_fields: dict[str, str | int | float | None]


@dataclass(frozen=True)
class CompileResult:
    db_path: Path
    compressed_db_path: Path
    manifest_path: Path
    manifest: dict[str, Any]
    page_count: int
    client_path: Path | None = None
    asset_paths: tuple[Path, ...] = dataclass_field(default_factory=tuple)
    warnings: tuple[BuildWarning, ...] = dataclass_field(default_factory=tuple)
    skipped: tuple[SkippedFile, ...] = dataclass_field(default_factory=tuple)
    metrics: dict[str, Any] = dataclass_field(default_factory=dict)


class _MetricsRecorder:
    def __init__(self, config_path: Path) -> None:
        self._started_at = time.perf_counter()
        self.config_path = _absolute_path(config_path)
        self.phase_order: list[str] = []
        self.phases: dict[str, float] = {}
        self.candidate_count = 0
        self.ingest_documents = 0
        self.ingest_seconds = 0.0
        self.ingest_build_db_bytes: int | None = None
        self.ingest_peak_rss_bytes: int | None = None

    @contextmanager
    def phase(self, name: str) -> Iterator[None]:
        start = time.perf_counter()
        try:
            yield
        finally:
            elapsed = time.perf_counter() - start
            if name not in self.phases:
                self.phase_order.append(name)
                self.phases[name] = 0.0
            self.phases[name] += elapsed

    def record_ingest(
        self, *, documents: int, seconds: float, build_db_path: Path
    ) -> None:
        self.ingest_documents = documents
        self.ingest_seconds = seconds
        self.ingest_build_db_bytes = _path_size(build_db_path)
        self.ingest_peak_rss_bytes = _peak_rss_bytes()

    def to_payload(
        self,
        *,
        config: DredgeConfig,
        page_count: int,
        skipped_count: int,
        warning_count: int,
        db_path: Path,
        compressed_db_path: Path,
        manifest_path: Path,
        db_sha256: str,
        db_bytes: int,
        db_compressed_bytes: int,
        payload_report: dict[str, Any],
    ) -> dict[str, Any]:
        ingest_rate = (
            self.ingest_documents / self.ingest_seconds
            if self.ingest_seconds > 0
            else None
        )
        return {
            "metrics_version": METRICS_VERSION,
            "config_path": str(config.path),
            "source_dir": str(config.source_dir),
            "output_dir": str(config.output_dir),
            "candidate_count": self.candidate_count,
            "page_count": page_count,
            "skipped_count": skipped_count,
            "warning_count": warning_count,
            "total_elapsed_seconds": _round_seconds(
                time.perf_counter() - self._started_at
            ),
            "phase_order": list(self.phase_order),
            "phases": {
                name: _round_seconds(self.phases[name]) for name in self.phase_order
            },
            "ingest": {
                "documents": self.ingest_documents,
                "seconds": _round_seconds(self.ingest_seconds),
                "documents_per_second": _round_seconds(ingest_rate)
                if ingest_rate is not None
                else None,
                "build_db_bytes": self.ingest_build_db_bytes,
                "peak_rss_bytes": self.ingest_peak_rss_bytes,
            },
            "database": {
                "path": str(db_path),
                "compressed_path": str(compressed_db_path),
                "manifest_path": str(manifest_path),
                "db_file": compressed_db_path.name,
                "db_sha256": db_sha256,
                "db_bytes": db_bytes,
                "db_compressed_bytes": db_compressed_bytes,
                "db_compression": DB_COMPRESSION,
            },
            "payload_report": payload_report,
        }


class _ProgressReporter:
    def __init__(
        self, stream: TextIO | None, *, total_documents: int, build_db_path: Path
    ) -> None:
        self._stream = stream
        self._total_documents = total_documents
        self._build_db_path = build_db_path
        self._started_at = time.perf_counter()
        self._last_report_at = self._started_at
        self._last_document_count = 0

    def should_report(self, processed_documents: int) -> bool:
        if self._stream is None or processed_documents == self._last_document_count:
            return False

        now = time.perf_counter()
        final = processed_documents == self._total_documents
        enough_documents = (
            processed_documents - self._last_document_count
            >= PROGRESS_DOCUMENT_INTERVAL
        )
        enough_time = now - self._last_report_at >= PROGRESS_TIME_INTERVAL_SECONDS
        return final or enough_documents or enough_time

    def maybe_report(
        self, processed_documents: int, *, build_db_bytes: int | None = None
    ) -> None:
        if not self.should_report(processed_documents):
            return

        now = time.perf_counter()
        elapsed = max(now - self._started_at, 0.000001)
        documents_per_second = processed_documents / elapsed
        remaining_documents = max(self._total_documents - processed_documents, 0)
        eta_seconds = (
            remaining_documents / documents_per_second
            if documents_per_second > 0
            else None
        )
        print(
            "dredge: ingest "
            f"{processed_documents:,}/{self._total_documents:,} docs "
            f"({documents_per_second:,.1f} docs/s, "
            f"elapsed {_format_duration(elapsed)}, "
            f"eta {_format_duration(eta_seconds)}, "
            f"build_db {_format_bytes(build_db_bytes if build_db_bytes is not None else _path_size(self._build_db_path))}, "
            f"peak_rss {_format_bytes(_peak_rss_bytes())})",
            file=self._stream,
            flush=True,
        )
        self._last_report_at = now
        self._last_document_count = processed_documents


def load_config(config_path: Path) -> DredgeConfig:
    path = _absolute_path(config_path)
    if not path.exists():
        raise BuildError(
            "CONFIG_NOT_FOUND", f"configuration file does not exist: {path}", path=path
        )

    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise BuildError(
            "CONFIG_INVALID_JSON",
            f"invalid JSON in {path}: line {error.lineno}, column {error.colno}: {error.msg}",
        ) from error

    if not isinstance(raw, dict):
        raise BuildError(
            "CONFIG_INVALID", f"configuration root must be an object: {path}"
        )

    unknown = sorted(set(raw) - TOP_LEVEL_KEYS)
    if unknown:
        raise BuildError(
            "CONFIG_INVALID", f"unknown configuration key(s): {', '.join(unknown)}"
        )

    base_dir = path.parent
    source_dir = _required_path(raw, "source_dir", base_dir)
    output_dir = _required_path(raw, "output_dir", base_dir)

    if not source_dir.exists() or not source_dir.is_dir():
        raise BuildError(
            "CONFIG_INVALID", f"source_dir must be an existing directory: {source_dir}"
        )

    allow_output_in_source = _optional_bool(raw, "allow_output_in_source", False)
    if _same_or_child(output_dir, source_dir) and not allow_output_in_source:
        raise BuildError(
            "CONFIG_INVALID",
            "output_dir must be outside source_dir unless allow_output_in_source is true: "
            f"source_dir={source_dir}, output_dir={output_dir}",
        )

    base_url = _optional_string(raw, "base_url", "/")
    include = tuple(_optional_string_list(raw, "include", ["**/*.html"]))
    exclude = tuple(_optional_string_list(raw, "exclude", []))
    selectors = _load_selectors(raw)
    search_fields = tuple(_load_search_fields(raw))
    facets = _load_facets(raw)
    store_fields = _load_store_fields(raw)
    facet_map = {facet.name: facet for facet in facets}
    store_field_map = {field.name: field for field in store_fields}
    collisions = sorted(set(facet_map) & set(store_field_map))
    if collisions:
        raise BuildError(
            "CONFIG_INVALID",
            f"facets and store_fields share field name(s): {', '.join(collisions)}",
        )
    field_map = {**facet_map, **store_field_map}
    result_fields = tuple(
        _optional_string_list(raw, "result_fields", ["title", "url", "description"])
    )
    _validate_result_fields(result_fields, field_map)
    composite_indices = tuple(_load_composite_indices(raw, facet_map, store_field_map))
    client = _load_client(raw)
    variant_generation = _optional_bool(raw, "variant_generation", True)
    synonym_groups = _load_synonym_groups(raw)
    suppressed_variants = _load_suppressed_variants(raw)

    effective_config = {
        "$schema": raw.get("$schema"),
        "source_dir": raw["source_dir"],
        "output_dir": raw["output_dir"],
        "base_url": base_url,
        "include": list(include),
        "exclude": list(exclude),
        "selectors": selectors,
        "search_fields": [{"source": field.source} for field in search_fields],
        "facets": {
            facet.name: {
                "type": facet.type,
                "source": facet.source,
                "required": facet.required,
            }
            for facet in facets
        },
        "store_fields": {
            field.name: {
                "type": field.type,
                "source": field.source,
                "required": field.required,
            }
            for field in store_fields
        },
        "result_fields": list(result_fields),
        "composite_indices": [list(index) for index in composite_indices],
        "client": client,
        "allow_output_in_source": allow_output_in_source,
        "variant_generation": variant_generation,
        "synonym_groups": [list(group) for group in synonym_groups],
        "suppressed_variants": [list(pair) for pair in suppressed_variants],
    }
    config_hash = _sha256_text(
        json.dumps(
            effective_config, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        )
    )

    return DredgeConfig(
        path=path,
        raw=raw,
        source_dir=source_dir,
        output_dir=output_dir,
        base_url=base_url,
        include=include,
        exclude=exclude,
        selectors=selectors,
        search_fields=search_fields,
        facets=facets,
        store_fields=store_fields,
        result_fields=result_fields,
        composite_indices=composite_indices,
        client=client,
        allow_output_in_source=allow_output_in_source,
        variant_generation=variant_generation,
        synonym_groups=synonym_groups,
        suppressed_variants=suppressed_variants,
        config_hash=config_hash,
    )


def check_sqlite_capabilities() -> None:
    connection = sqlite3.connect(":memory:")
    try:
        connection.execute("CREATE VIRTUAL TABLE dredge_fts_check USING fts5(body)")
    except sqlite3.OperationalError as error:
        raise BuildError(
            "SQLITE_FTS5_UNAVAILABLE",
            "the active Python sqlite3 build does not support FTS5; use a Python build linked "
            "against SQLite with FTS5 enabled",
        ) from error

    try:
        connection.execute("CREATE TABLE dredge_strict_check(value TEXT) STRICT")
    except sqlite3.OperationalError as error:
        raise BuildError(
            "SQLITE_STRICT_UNAVAILABLE",
            "the active Python sqlite3 build does not support SQLite STRICT tables",
        ) from error
    finally:
        connection.close()


def validate_config(config_path: Path) -> DredgeConfig:
    config = load_config(config_path)
    check_sqlite_capabilities()
    return config


def discover_html_files(
    config: DredgeConfig,
) -> tuple[tuple[FileCandidate, ...], tuple[SkippedFile, ...]]:
    candidates: list[FileCandidate] = []
    skipped: list[SkippedFile] = []
    seen_urls: dict[str, Path] = {}
    output_inside_source = _same_or_child(config.output_dir, config.source_dir)

    for path in _discovery_paths(config):
        if path.is_dir():
            continue
        rel_path = path.relative_to(config.source_dir).as_posix()

        if path.is_symlink():
            skipped.append(SkippedFile(path=path, reason="symlink"))
            continue

        if output_inside_source and _same_or_child(path, config.output_dir):
            skipped.append(SkippedFile(path=path, reason="output_dir"))
            continue

        if not _matches_any(rel_path, config.include):
            continue

        if _matches_any(rel_path, config.exclude):
            skipped.append(SkippedFile(path=path, reason="excluded"))
            continue

        url = _canonical_url(config.base_url, rel_path)
        if url in seen_urls:
            raise BuildError(
                "DISCOVERY_DUPLICATE_URL",
                f"multiple HTML files resolve to URL {url!r}: {seen_urls[url]} and {path}",
            )
        seen_urls[url] = path
        candidates.append(FileCandidate(path=path, rel_path=rel_path, url=url))

    return tuple(
        sorted(candidates, key=lambda candidate: (candidate.url, candidate.rel_path))
    ), tuple(skipped)


def _discovery_paths(config: DredgeConfig) -> tuple[Path, ...]:
    if _can_use_include_glob_discovery(config.include):
        paths: set[Path] = set()
        for pattern in config.include:
            paths.update(config.source_dir.glob(pattern))
        return tuple(
            sorted(
                paths, key=lambda found: found.relative_to(config.source_dir).as_posix()
            )
        )

    return tuple(
        sorted(
            config.source_dir.rglob("*"),
            key=lambda found: found.relative_to(config.source_dir).as_posix(),
        )
    )


def _can_use_include_glob_discovery(include: tuple[str, ...]) -> bool:
    return all(_is_html_include_glob(pattern) for pattern in include)


def _is_html_include_glob(pattern: str) -> bool:
    pure_path = PurePosixPath(pattern)
    return (
        not pure_path.is_absolute()
        and ".." not in pure_path.parts
        and pattern.lower().endswith((".html", ".htm"))
    )


def compile_site(
    config_path: Path,
    *,
    metrics_json_path: Path | None = None,
    variants_json_path: Path | None = None,
    progress_stream: TextIO | None = None,
    brotli_quality: int = BROTLI_QUALITY,
    jobs: int | None = None,
    runtime_assets: bool = True,
    precompress_assets: bool = False,
) -> CompileResult:
    if not BROTLI_MIN_QUALITY <= brotli_quality <= BROTLI_MAX_QUALITY:
        raise ValueError(
            f"brotli_quality must be between {BROTLI_MIN_QUALITY} and "
            f"{BROTLI_MAX_QUALITY}; got {brotli_quality}"
        )
    ui = CompileProgress(progress_stream)
    with ui.activate():
        return _compile_site(
            config_path,
            metrics_json_path=metrics_json_path,
            variants_json_path=variants_json_path,
            progress_stream=progress_stream,
            ui=ui,
            brotli_quality=brotli_quality,
            jobs=jobs,
            runtime_assets=runtime_assets,
            precompress_assets=precompress_assets,
        )


def _compile_site(
    config_path: Path,
    *,
    metrics_json_path: Path | None,
    variants_json_path: Path | None,
    progress_stream: TextIO | None,
    ui: CompileProgress,
    brotli_quality: int,
    jobs: int | None,
    runtime_assets: bool,
    precompress_assets: bool,
) -> CompileResult:
    metrics = _MetricsRecorder(config_path)
    with metrics.phase("validation"):
        ui.set_phase("validation")
        config = validate_config(config_path)
    with metrics.phase("discovery"):
        ui.set_phase("discovery")
        candidates, skipped = discover_html_files(config)
    metrics.candidate_count = len(candidates)
    if not candidates:
        raise BuildError(
            "DISCOVERY_NO_FILES",
            f"no HTML files matched include/exclude patterns in {config.source_dir}",
        )
    resolved_jobs = _resolve_jobs(jobs, len(candidates))

    config.output_dir.mkdir(parents=True, exist_ok=True)
    temp_dir = Path(tempfile.mkdtemp(prefix=".dredge-build-", dir=config.output_dir))
    build_db_path = temp_dir / "build.db"
    compact_db_path = temp_dir / "compact.db"
    warnings = _WarningCollector()

    try:
        smoke_token: str | None = None
        smoke_filter: tuple[str, str, str | int | float] | None = None
        connection = sqlite3.connect(build_db_path)
        try:
            with metrics.phase("table_creation"):
                ui.set_phase("table_creation")
                _configure_build_database(connection)
                _create_tables(connection, config)
                connection.commit()
            insert_sql = _document_insert_sql(config)
            array_insert_sql = {
                facet.name: f"INSERT OR IGNORE INTO {_quote_identifier(_array_table_name(facet.name))} "
                "(document_id, value) VALUES (?, ?)"
                for facet in config.array_facets
            }
            batches = _InsertBatches.for_config(config)
            reporter = (
                None
                if ui.enabled
                else _ProgressReporter(
                    progress_stream,
                    total_documents=len(candidates),
                    build_db_path=build_db_path,
                )
            )
            files_advance = ui.begin_files(len(candidates))

            connection.execute("BEGIN")
            ingest_started_at = time.perf_counter()
            with metrics.phase("extraction_ingest"):
                ui.set_phase("extraction_ingest")
                extractions = _iter_extractions(candidates, config, resolved_jobs)
                for index, (candidate, document, warning_records) in enumerate(
                    extractions, start=1
                ):
                    for record in warning_records:
                        warnings.add(**record)
                    if smoke_token is None:
                        smoke_token = _first_search_token(
                            document.title
                        ) or _first_search_token(document.body)
                    if smoke_filter is None:
                        smoke_filter = _first_filter(document)
                    _queue_document_insert(batches, config, document)
                    report_due = (
                        reporter.should_report(index)
                        if reporter is not None
                        else index % PROGRESS_DOCUMENT_INTERVAL == 0
                    )
                    build_db_bytes = None
                    if len(batches.documents) >= INSERT_BATCH_SIZE or report_due:
                        _flush_insert_batches(
                            connection, insert_sql, array_insert_sql, batches
                        )
                        if report_due:
                            build_db_bytes = _sqlite_database_size_bytes(connection)
                    if index % BATCH_SIZE == 0:
                        _flush_insert_batches(
                            connection, insert_sql, array_insert_sql, batches
                        )
                        connection.commit()
                        if reporter is not None:
                            reporter.maybe_report(
                                index,
                                build_db_bytes=build_db_bytes
                                or _path_size(build_db_path),
                            )
                        connection.execute("BEGIN")
                    elif reporter is not None:
                        reporter.maybe_report(index, build_db_bytes=build_db_bytes)
                    files_advance(index, build_db_bytes)
                _flush_insert_batches(
                    connection, insert_sql, array_insert_sql, batches
                )
                connection.commit()
                final_db_bytes = _path_size(build_db_path)
                if reporter is not None:
                    reporter.maybe_report(
                        len(candidates), build_db_bytes=final_db_bytes
                    )
                files_advance(len(candidates), final_db_bytes)
            metrics.record_ingest(
                documents=len(candidates),
                seconds=time.perf_counter() - ingest_started_at,
                build_db_path=build_db_path,
            )
            with metrics.phase("index_creation"):
                ui.set_phase("index_creation")
                _create_indexes(connection, config)
            with metrics.phase("term_variants"):
                ui.set_phase("term_variants")
                variant_rows = _build_term_variants(connection, config)
            connection.commit()
            _finalize_database(connection, compact_db_path, metrics, ui)
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

        if variants_json_path is not None:
            _write_variants_json(variants_json_path, variant_rows)

        with metrics.phase("hashing"):
            ui.set_phase("hashing")
            db_sha256 = _sha256_file(compact_db_path)
            db_file = f"search.{db_sha256}.db.br"
            uncompressed_file = f"search.{db_sha256}.db"
            db_path = config.output_dir / uncompressed_file
            compact_db_path.replace(db_path)

        with metrics.phase("post_build_checks"):
            ui.set_phase("post_build_checks")
            payload_report = _run_post_build_checks(
                db_path, config, smoke_token, smoke_filter, warnings
            )

        with metrics.phase("compression"):
            ui.set_phase("compression")
            compressed_db_path = config.output_dir / db_file
            db_bytes = db_path.stat().st_size
            compress_advance = ui.begin_compression(db_bytes)
            db_compressed_bytes = _brotli_compress_file(
                db_path,
                compressed_db_path,
                quality=brotli_quality,
                on_chunk=compress_advance,
            )

        with metrics.phase("manifest_write"):
            ui.set_phase("manifest_write")
            manifest = {
                "manifest_version": MANIFEST_VERSION,
                "db_schema_version": DB_SCHEMA_VERSION,
                "db_file": db_file,
                "db_sha256": db_sha256,
                "db_bytes": db_bytes,
                "db_compressed_bytes": db_compressed_bytes,
                "db_compression": DB_COMPRESSION,
                "sqlite_page_size": SQLITE_PAGE_SIZE,
                "page_count": len(candidates),
                "config_hash": config.config_hash,
                "runtime_min_version": RUNTIME_MIN_VERSION,
            }
            manifest_path = config.output_dir / "search-manifest.json"
            manifest_path.write_text(
                json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
            )
        with metrics.phase("client_write"):
            ui.set_phase("client_write")
            client_path = _write_generated_client(config)

        with metrics.phase("runtime_assets"):
            ui.set_phase("runtime_assets")
            asset_paths = (
                _install_runtime_assets(config.output_dir, precompress_assets)
                if runtime_assets
                else ()
            )

        ui.finish()
        warning_tuple = warnings.to_warnings()
        metrics_payload = metrics.to_payload(
            config=config,
            page_count=len(candidates),
            skipped_count=len(skipped),
            warning_count=len(warning_tuple),
            db_path=db_path,
            compressed_db_path=compressed_db_path,
            manifest_path=manifest_path,
            db_sha256=db_sha256,
            db_bytes=manifest["db_bytes"],
            db_compressed_bytes=db_compressed_bytes,
            payload_report=payload_report,
        )
        if metrics_json_path is not None:
            _write_metrics_json(metrics_json_path, metrics_payload)

        return CompileResult(
            db_path=db_path,
            compressed_db_path=compressed_db_path,
            manifest_path=manifest_path,
            manifest=manifest,
            page_count=len(candidates),
            client_path=client_path,
            asset_paths=asset_paths,
            warnings=warning_tuple,
            skipped=skipped,
            metrics=metrics_payload,
        )
    except BuildError:
        raise
    except Exception as error:
        raise BuildError("DATABASE_BUILD_FAILED", str(error)) from error
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def _load_selectors(raw: dict[str, Any]) -> dict[str, str]:
    value = raw.get("selectors", {})
    if not isinstance(value, dict):
        raise BuildError("CONFIG_INVALID", "selectors must be an object")
    unknown = sorted(set(value) - SELECTOR_KEYS)
    if unknown:
        raise BuildError(
            "CONFIG_INVALID", f"unknown selector key(s): {', '.join(unknown)}"
        )

    selectors = {
        "title": "title, h1",
        "body": "body",
        "description": "meta[name='description']@content",
    }
    for key, selector in value.items():
        if not isinstance(selector, str) or not selector.strip():
            raise BuildError(
                "CONFIG_INVALID", f"selector {key!r} must be a non-empty string"
            )
        selectors[key] = selector.strip()
    for key, selector in selectors.items():
        _validate_selector_source(
            selector, f"selectors.{key}", allow_direct_attribute=False
        )
    return selectors


def _load_search_fields(raw: dict[str, Any]) -> list[SearchFieldConfig]:
    value = raw.get("search_fields", [])
    if not isinstance(value, list):
        raise BuildError("CONFIG_INVALID", "search_fields must be an array")
    fields: list[SearchFieldConfig] = []
    for index, item in enumerate(value, start=1):
        if isinstance(item, str):
            source = item
        elif isinstance(item, dict):
            unknown = sorted(set(item) - {"source"})
            if unknown:
                raise BuildError(
                    "CONFIG_INVALID",
                    f"unknown key(s) on search_fields[{index}]: {', '.join(unknown)}",
                )
            source = item.get("source")
        else:
            raise BuildError(
                "CONFIG_INVALID",
                f"search_fields[{index}] must be a string or object",
            )
        if not isinstance(source, str) or not source.strip():
            raise BuildError(
                "CONFIG_INVALID", f"search_fields[{index}].source must be a non-empty string"
            )
        _validate_selector_source(
            source.strip(), f"search_fields[{index}]", allow_direct_attribute=True
        )
        fields.append(SearchFieldConfig(source=source.strip()))
    return fields


def _load_facets(raw: dict[str, Any]) -> tuple[FacetConfig, ...]:
    value = raw.get("facets", {})
    if not isinstance(value, dict):
        raise BuildError("CONFIG_INVALID", "facets must be an object")

    facets: list[FacetConfig] = []
    for name in sorted(value):
        if not IDENTIFIER_RE.match(name):
            raise BuildError(
                "CONFIG_INVALID",
                f"facet name must match {IDENTIFIER_RE.pattern}: {name!r}",
            )
        facet_raw = value[name]
        if not isinstance(facet_raw, dict):
            raise BuildError("CONFIG_INVALID", f"facet {name!r} must be an object")
        unknown = sorted(set(facet_raw) - FACET_KEYS)
        if unknown:
            raise BuildError(
                "CONFIG_INVALID",
                f"unknown key(s) on facet {name!r}: {', '.join(unknown)}",
            )
        facet_type = facet_raw.get("type")
        if facet_type not in FACET_TYPES:
            raise BuildError(
                "CONFIG_INVALID", f"facet {name!r} has unsupported type: {facet_type!r}"
            )
        source = facet_raw.get("source")
        if not isinstance(source, str) or not source.strip():
            raise BuildError(
                "CONFIG_INVALID", f"facet {name!r} source must be a non-empty string"
            )
        required = facet_raw.get("required", False)
        if not isinstance(required, bool):
            raise BuildError(
                "CONFIG_INVALID", f"facet {name!r} required must be a boolean"
            )
        _validate_selector_source(
            source.strip(), f"facets.{name}.source", allow_direct_attribute=True
        )
        facets.append(
            FacetConfig(
                name=name, type=facet_type, source=source.strip(), required=required
            )
        )
    return tuple(facets)


def _load_store_fields(raw: dict[str, Any]) -> tuple[FacetConfig, ...]:
    value = raw.get("store_fields", {})
    if not isinstance(value, dict):
        raise BuildError("CONFIG_INVALID", "store_fields must be an object")

    fields: list[FacetConfig] = []
    for name in sorted(value):
        if not IDENTIFIER_RE.match(name):
            raise BuildError(
                "CONFIG_INVALID",
                f"store field name must match {IDENTIFIER_RE.pattern}: {name!r}",
            )
        field_raw = value[name]
        if not isinstance(field_raw, dict):
            raise BuildError("CONFIG_INVALID", f"store field {name!r} must be an object")
        unknown = sorted(set(field_raw) - FACET_KEYS)
        if unknown:
            raise BuildError(
                "CONFIG_INVALID",
                f"unknown key(s) on store field {name!r}: {', '.join(unknown)}",
            )
        field_type = field_raw.get("type")
        if field_type not in STORE_FIELD_TYPES:
            raise BuildError(
                "CONFIG_INVALID",
                f"store field {name!r} has unsupported type: {field_type!r}",
            )
        source = field_raw.get("source")
        if not isinstance(source, str) or not source.strip():
            raise BuildError(
                "CONFIG_INVALID", f"store field {name!r} source must be a non-empty string"
            )
        required = field_raw.get("required", False)
        if not isinstance(required, bool):
            raise BuildError(
                "CONFIG_INVALID", f"store field {name!r} required must be a boolean"
            )
        _validate_selector_source(
            source.strip(), f"store_fields.{name}.source", allow_direct_attribute=True
        )
        fields.append(
            FacetConfig(name=name, type=field_type, source=source.strip(), required=required)
        )
    return tuple(fields)


def _load_composite_indices(
    raw: dict[str, Any], facets: dict[str, FacetConfig], store_fields: dict[str, FacetConfig]
) -> list[tuple[str, ...]]:
    value = raw.get("composite_indices", [])
    if not isinstance(value, list):
        raise BuildError("CONFIG_INVALID", "composite_indices must be an array")
    indices: list[tuple[str, ...]] = []
    for index_number, index in enumerate(value, start=1):
        if (
            not isinstance(index, list)
            or len(index) < 2
            or not all(isinstance(name, str) for name in index)
        ):
            raise BuildError(
                "CONFIG_INVALID",
                f"composite_indices[{index_number}] must contain at least two facet names",
            )
        for name in index:
            if name in store_fields:
                raise BuildError(
                    "CONFIG_INVALID",
                    f"composite index cannot include store field: {name!r}",
                )
            facet = facets.get(name)
            if facet is None:
                raise BuildError(
                    "CONFIG_INVALID",
                    f"composite index references unknown facet: {name!r}",
                )
            if facet.is_array:
                raise BuildError(
                    "CONFIG_INVALID",
                    f"composite index cannot include array facet: {name!r}",
                )
        indices.append(tuple(index))
    return indices


def _load_client(raw: dict[str, Any]) -> dict[str, str]:
    value = raw.get("client", {})
    if not isinstance(value, dict):
        raise BuildError("CONFIG_INVALID", "client must be an object")
    unknown = sorted(set(value) - CLIENT_KEYS)
    if unknown:
        raise BuildError(
            "CONFIG_INVALID", f"unknown client key(s): {', '.join(unknown)}"
        )
    client: dict[str, str] = {}
    for key, item in value.items():
        if not isinstance(item, str) or not item.strip():
            raise BuildError(
                "CONFIG_INVALID", f"client.{key} must be a non-empty string"
            )
        client[key] = item
    return client


def _load_synonym_groups(raw: dict[str, Any]) -> tuple[tuple[str, ...], ...]:
    value = raw.get("synonym_groups", [])
    if not isinstance(value, list):
        raise BuildError(
            "CONFIG_INVALID", "synonym_groups must be an array of term arrays"
        )
    groups: list[tuple[str, ...]] = []
    for group in value:
        if (
            not isinstance(group, list)
            or len(group) < 2
            or not all(isinstance(term, str) and term.strip() for term in group)
        ):
            raise BuildError(
                "CONFIG_INVALID",
                "each synonym_groups entry must be an array of at least two "
                "non-empty terms",
            )
        groups.append(
            _normalize_variant_terms(
                [term.strip() for term in group], key="synonym_groups"
            )
        )
    return tuple(groups)


def _load_suppressed_variants(raw: dict[str, Any]) -> tuple[tuple[str, str], ...]:
    value = raw.get("suppressed_variants", [])
    if not isinstance(value, list):
        raise BuildError(
            "CONFIG_INVALID", "suppressed_variants must be an array of term pairs"
        )
    pairs: list[tuple[str, str]] = []
    for pair in value:
        if (
            not isinstance(pair, list)
            or len(pair) != 2
            or not all(isinstance(term, str) and term.strip() for term in pair)
        ):
            raise BuildError(
                "CONFIG_INVALID",
                "each suppressed_variants entry must be an array of exactly two "
                "non-empty terms",
            )
        left, right = _normalize_variant_terms(
            [term.strip() for term in pair], key="suppressed_variants"
        )
        pairs.append((left, right))
    return tuple(pairs)


def _normalize_variant_terms(terms: Sequence[str], *, key: str) -> tuple[str, ...]:
    """Fold declared terms to the surface forms the index actually stores.

    Runs each term through the index's own tokenizer, so a config naming
    ``Ramessès`` keys the ``ramesses`` row a reader's query will look up. A
    term that does not tokenize to exactly one token cannot key a row at all.
    """
    connection = sqlite3.connect(":memory:")
    try:
        connection.execute(
            f"CREATE VIRTUAL TABLE terms USING fts5(term, tokenize='{FTS_TOKENIZER}')"
        )
        connection.executemany(
            "INSERT INTO terms(rowid, term) VALUES (?, ?)",
            list(enumerate(terms, start=1)),
        )
        connection.execute(
            "CREATE VIRTUAL TABLE vocab USING fts5vocab(terms, 'instance')"
        )
        tokens: dict[int, list[str]] = {}
        for doc, token in connection.execute(
            "SELECT doc, term FROM vocab ORDER BY doc, offset"
        ):
            tokens.setdefault(int(doc), []).append(token)
    finally:
        connection.close()

    normalized: list[str] = []
    for index, term in enumerate(terms, start=1):
        found = tokens.get(index, [])
        if len(found) != 1:
            raise BuildError(
                "CONFIG_INVALID",
                f"{key} terms must each be a single searchable word: {term!r}",
                value=term,
            )
        normalized.append(found[0])
    return tuple(normalized)


def _validate_result_fields(
    result_fields: tuple[str, ...], facets: dict[str, FacetConfig]
) -> None:
    allowed = {"id", "title", "url", "description"} | set(facets)
    for field_name in result_fields:
        if field_name not in allowed:
            raise BuildError(
                "CONFIG_INVALID",
                f"result_fields references unknown field: {field_name!r}",
            )


def _configure_build_database(connection: sqlite3.Connection) -> None:
    connection.execute(f"PRAGMA page_size = {SQLITE_PAGE_SIZE}")
    connection.execute("PRAGMA journal_mode = OFF")
    connection.execute("PRAGMA synchronous = OFF")
    connection.execute("PRAGMA temp_store = MEMORY")
    connection.execute("PRAGMA foreign_keys = OFF")
    connection.execute(f"PRAGMA user_version = {DB_SCHEMA_VERSION}")


def _create_schema(connection: sqlite3.Connection, config: DredgeConfig) -> None:
    _create_tables(connection, config)
    _create_indexes(connection, config)


def _documents_column_defs(config: DredgeConfig) -> list[str]:
    scalar_columns = [
        f"{_quote_identifier(facet.name)} {SCALAR_SQL_TYPES[facet.type]}"
        for facet in config.scalar_facets
    ]
    store_columns = [
        f"{_quote_identifier(field.name)} {SCALAR_SQL_TYPES[field.type]}"
        for field in config.store_fields
    ]
    return [
        "id INTEGER PRIMARY KEY",
        "url TEXT NOT NULL",
        "title TEXT NOT NULL",
        "description TEXT",
        *scalar_columns,
        *store_columns,
    ]


def _create_dredge_fields_table(
    connection: sqlite3.Connection, config: DredgeConfig
) -> None:
    connection.execute(
        "CREATE TABLE dredge_fields ("
        "name TEXT PRIMARY KEY, "
        "role TEXT NOT NULL, "
        "type TEXT NOT NULL"
        ") STRICT"
    )
    connection.executemany(
        "INSERT INTO dredge_fields(name, role, type) VALUES (?, ?, ?)",
        [
            *((facet.name, "facet", facet.type) for facet in config.facets),
            *((field.name, "store", field.type) for field in config.store_fields),
        ],
    )


def _create_array_facet_tables(
    connection: sqlite3.Connection, config: DredgeConfig
) -> None:
    for facet in config.array_facets:
        table_name = _quote_identifier(_array_table_name(facet.name))
        connection.execute(
            f"CREATE TABLE {table_name} ("
            "document_id INTEGER NOT NULL, "
            "value TEXT NOT NULL, "
            "PRIMARY KEY (document_id, value)"
            ") WITHOUT ROWID"
        )


def _create_tables(connection: sqlite3.Connection, config: DredgeConfig) -> None:
    document_columns = _documents_column_defs(config)
    connection.execute(f"CREATE TABLE documents ({', '.join(document_columns)}) STRICT")
    _create_dredge_fields_table(connection, config)
    connection.execute(
        "CREATE VIRTUAL TABLE documents_fts USING fts5("
        f"title, body, content='', tokenize='{FTS_TOKENIZER}')"
    )
    # Keyed on the surface form rather than a stem, so the Runtime looks up the
    # word the reader typed and ships no stemmer of its own. Left empty when
    # variants are configured off.
    connection.execute(
        "CREATE TABLE dredge_term_variants ("
        "term TEXT PRIMARY KEY, "
        "variants TEXT NOT NULL"
        ") WITHOUT ROWID"
    )
    _create_array_facet_tables(connection, config)


def _create_indexes(connection: sqlite3.Connection, config: DredgeConfig) -> None:
    # Case-insensitive title index so match-all browse can stream results in
    # alphabetical order (ORDER BY title COLLATE NOCASE) without a full sort.
    connection.execute(
        "CREATE INDEX documents_title_nocase_idx ON documents(title COLLATE NOCASE, id)"
    )

    for facet in config.array_facets:
        table_name = _quote_identifier(_array_table_name(facet.name))
        connection.execute(
            f"CREATE INDEX {_quote_identifier(f'facet_{facet.name}_value_document_idx')} "
            f"ON {table_name}(value, document_id)"
        )

    for facet in config.scalar_facets:
        connection.execute(
            f"CREATE INDEX {_quote_identifier(f'documents_{facet.name}_idx')} "
            f"ON documents({_quote_identifier(facet.name)}, id)"
        )

    for index in config.composite_indices:
        name = _composite_index_name(index)
        columns = ", ".join(_quote_identifier(column) for column in index)
        connection.execute(
            f"CREATE INDEX {_quote_identifier(name)} ON documents({columns}, id)"
        )


def _document_insert_sql(config: DredgeConfig) -> str:
    columns = ["id", "url", "title", "description"] + [
        facet.name for facet in config.scalar_facets
    ] + [field.name for field in config.store_fields]
    placeholders = ", ".join("?" for _ in columns)
    sql_columns = ", ".join(_quote_identifier(column) for column in columns)
    return f"INSERT INTO documents ({sql_columns}) VALUES ({placeholders})"


@dataclass
class _InsertBatches:
    documents: list[tuple[Any, ...]]
    fts: list[tuple[int, str, str]]
    array_facets: dict[str, list[tuple[int, str]]]

    @classmethod
    def for_config(cls, config: DredgeConfig) -> _InsertBatches:
        return cls(
            documents=[],
            fts=[],
            array_facets={facet.name: [] for facet in config.array_facets},
        )


def _queue_document_insert(
    batches: _InsertBatches,
    config: DredgeConfig,
    document: ExtractedDocument,
) -> None:
    values: list[Any] = [
        document.id,
        document.url,
        document.title,
        document.description,
    ]
    values.extend(
        document.scalar_facets.get(facet.name) for facet in config.scalar_facets
    )
    values.extend(document.store_fields.get(field.name) for field in config.store_fields)
    batches.documents.append(tuple(values))
    batches.fts.append((document.id, document.title, document.body))
    for facet in config.array_facets:
        batches.array_facets[facet.name].extend(
            (document.id, value) for value in document.array_facets.get(facet.name, ())
        )


def _flush_insert_batches(
    connection: sqlite3.Connection,
    insert_sql: str,
    array_insert_sql: dict[str, str],
    batches: _InsertBatches,
) -> None:
    if batches.documents:
        connection.executemany(insert_sql, batches.documents)
        batches.documents.clear()
    if batches.fts:
        connection.executemany(
            "INSERT INTO documents_fts(rowid, title, body) VALUES (?, ?, ?)",
            batches.fts,
        )
        batches.fts.clear()
    for facet_name, rows in batches.array_facets.items():
        if rows:
            connection.executemany(array_insert_sql[facet_name], rows)
            rows.clear()


def _resolve_jobs(jobs: int | None, candidate_count: int) -> int:
    """Resolve the extraction worker count.

    ``None`` means auto: one worker per core. Any resolved value is clamped to
    the number of candidates, so a small site (or ``--jobs`` larger than the
    work) never spins up idle workers and falls through to the serial path.
    """

    if jobs is None:
        jobs = os.cpu_count() or 1
    elif jobs < 1:
        raise ValueError(f"jobs must be at least 1; got {jobs}")
    return max(1, min(jobs, candidate_count))


_EXTRACTION_CONFIG: DredgeConfig | None = None


def _init_extraction_worker(config: DredgeConfig) -> None:
    global _EXTRACTION_CONFIG
    _EXTRACTION_CONFIG = config


def _extract_document_worker(
    task: tuple[int, FileCandidate],
) -> tuple[ExtractedDocument, list[dict[str, Any]]]:
    document_id, candidate = task
    config = _EXTRACTION_CONFIG
    assert config is not None, "extraction worker used before initialization"
    sink = _DocumentWarnings()
    document = _extract_document(document_id, candidate, config, sink)
    return document, sink.records


def _iter_extractions(
    candidates: Sequence[FileCandidate],
    config: DredgeConfig,
    jobs: int,
) -> Iterator[tuple[FileCandidate, ExtractedDocument, list[dict[str, Any]]]]:
    """Yield ``(candidate, document, warning_records)`` in candidate order.

    ``jobs == 1`` is the serial path (no process pool). Otherwise extraction
    fans out across processes; ``ProcessPoolExecutor.map`` preserves input
    order, so document ids and insert order match a serial compile exactly.
    """

    if jobs == 1:
        for index, candidate in enumerate(candidates, start=1):
            sink = _DocumentWarnings()
            document = _extract_document(index, candidate, config, sink)
            yield candidate, document, sink.records
        return

    tasks = [
        (index, candidate) for index, candidate in enumerate(candidates, start=1)
    ]
    chunksize = max(1, len(tasks) // (jobs * 4))
    with ProcessPoolExecutor(
        max_workers=jobs,
        initializer=_init_extraction_worker,
        initargs=(config,),
    ) as executor:
        results = executor.map(_extract_document_worker, tasks, chunksize=chunksize)
        for candidate, (document, records) in zip(candidates, results):
            yield candidate, document, records


def _extract_document(
    document_id: int,
    candidate: FileCandidate,
    config: DredgeConfig,
    warnings: _WarningCollector | _DocumentWarnings,
) -> ExtractedDocument:
    try:
        html_bytes = candidate.path.read_bytes()
    except OSError as error:
        raise BuildError(
            "HTML_READ_FAILED",
            f"failed to read {candidate.path}: {error}",
            path=candidate.path,
        ) from error

    tree = HTMLParser(html_bytes)
    facet_raw_values = {
        facet.name: _extract_values(tree, facet.source) for facet in config.facets
    }
    store_field_raw_values = {
        field.name: _extract_values(tree, field.source) for field in config.store_fields
    }
    _remove_non_indexable_content(tree)

    title_values = _extract_values(tree, config.selectors["title"])
    if title_values:
        title = title_values[0]
    else:
        title = candidate.url
        warnings.add(
            code="SELECTOR_MISS",
            message="title selector matched no text; using URL as title",
            path=candidate.path,
            field="title",
            selector=config.selectors["title"],
        )

    description_values = _extract_values(tree, config.selectors["description"])
    description = description_values[0] if description_values else None
    if not description_values:
        warnings.add(
            code="SELECTOR_MISS",
            message="description selector matched no text",
            path=candidate.path,
            field="description",
            selector=config.selectors["description"],
        )

    body_values = _extract_values(tree, config.selectors["body"])
    extra_search_values: list[str] = []
    for field in config.search_fields:
        extra_search_values.extend(_extract_values(tree, field.source))
    body = _normalize_text(" ".join((*body_values, *extra_search_values)))
    if not body_values:
        warnings.add(
            code="SELECTOR_MISS",
            message="body selector matched no text",
            path=candidate.path,
            field="body",
            selector=config.selectors["body"],
        )

    scalar_facets: dict[str, str | int | float | None] = {}
    array_facets: dict[str, tuple[str, ...]] = {}
    for facet in config.facets:
        raw_values = facet_raw_values[facet.name]
        if facet.is_array:
            values = _normalize_array_values(raw_values)
            if facet.required and not values:
                raise BuildError(
                    "FACET_REQUIRED_MISSING",
                    f"missing required facet {facet.name!r} in {candidate.path} from source {facet.source!r}",
                    path=candidate.path,
                    field=facet.name,
                    selector=facet.source,
                )
            array_facets[facet.name] = tuple(values)
            continue

        if not raw_values:
            if facet.required:
                raise BuildError(
                    "FACET_REQUIRED_MISSING",
                    f"missing required facet {facet.name!r} in {candidate.path} from source {facet.source!r}",
                    path=candidate.path,
                    field=facet.name,
                    selector=facet.source,
                )
            scalar_facets[facet.name] = None
            continue

        if len(raw_values) > 1:
            warnings.add(
                code="FACET_MULTIPLE_VALUES",
                message=f"facet {facet.name!r} found multiple values; using the first value",
                path=candidate.path,
                field=facet.name,
                selector=facet.source,
            )
        scalar_facets[facet.name] = _coerce_scalar_facet(
            facet, raw_values[0], candidate.path
        )

    store_fields: dict[str, str | int | float | None] = {}
    for field in config.store_fields:
        raw_values = store_field_raw_values[field.name]
        if not raw_values:
            if field.required:
                raise BuildError(
                    "FIELD_REQUIRED_MISSING",
                    f"missing required store field {field.name!r} in {candidate.path} from source {field.source!r}",
                    path=candidate.path,
                    field=field.name,
                    selector=field.source,
                )
            store_fields[field.name] = None
            continue
        if len(raw_values) > 1:
            warnings.add(
                code="FIELD_MULTIPLE_VALUES",
                message=f"store field {field.name!r} found multiple values; using the first value",
                path=candidate.path,
                field=field.name,
                selector=field.source,
            )
        store_fields[field.name] = _coerce_scalar_facet(field, raw_values[0], candidate.path)

    return ExtractedDocument(
        id=document_id,
        url=candidate.url,
        title=title,
        description=description,
        body=body,
        scalar_facets=scalar_facets,
        array_facets=array_facets,
        store_fields=store_fields,
    )


def _remove_non_indexable_content(tree: HTMLParser) -> None:
    for tag in tree.css("script, style, noscript, template"):
        tag.decompose()
    for tag in tree.css("[data-pagefind-ignore]"):
        tag.decompose()
    for tag in tree.css("[hidden], [aria-hidden='true']"):
        tag.decompose()
    for tag in tree.css("[style]"):
        style = str(tag.attributes.get("style", "")).replace(" ", "").lower()
        if "display:none" in style or "visibility:hidden" in style:
            tag.decompose()


def _extract_values(tree: HTMLParser, source: str) -> list[str]:
    kind, selector, attribute = _parse_source(source, allow_direct_attribute=True)
    values: list[str] = []
    if kind == "attribute":
        for tag in tree.css(f"[{attribute}]"):
            values.extend(_normalize_attribute_value(tag.attributes.get(attribute)))
    elif kind == "selector_attribute":
        for tag in tree.css(selector):
            if attribute in tag.attributes:
                values.extend(_normalize_attribute_value(tag.attributes.get(attribute)))
    else:
        for tag in tree.css(selector):
            values.append(tag.text(separator=" ", strip=True))
    return [value for value in (_normalize_text(value) for value in values) if value]


def _normalize_attribute_value(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item) for item in value]
    return [str(value)]


def _normalize_array_values(values: list[str]) -> list[str]:
    normalized: set[str] = set()
    for value in values:
        for item in value.split(","):
            text = _normalize_text(item)
            if text:
                normalized.add(text)
    return sorted(normalized)


def _coerce_scalar_facet(
    facet: FacetConfig, value: str, path: Path
) -> str | int | float:
    text = _normalize_text(value)
    if facet.type == "string":
        return text
    if facet.type == "integer":
        try:
            if not re.fullmatch(r"[-+]?\d+", text):
                raise ValueError
            return int(text, 10)
        except ValueError as error:
            raise BuildError(
                "FACET_VALUE_INVALID",
                f"invalid integer value for facet {facet.name!r} in {path}: {value!r}",
                path=path,
                field=facet.name,
                selector=facet.source,
                value=value,
            ) from error
    if facet.type == "number":
        try:
            return float(text)
        except ValueError as error:
            raise BuildError(
                "FACET_VALUE_INVALID",
                f"invalid number value for facet {facet.name!r} in {path}: {value!r}",
                path=path,
                field=facet.name,
                selector=facet.source,
                value=value,
            ) from error
    if facet.type == "boolean":
        lowered = text.lower()
        if lowered in {"true", "1", "yes", "y", "on"}:
            return 1
        if lowered in {"false", "0", "no", "n", "off"}:
            return 0
        raise BuildError(
            "FACET_VALUE_INVALID",
            f"invalid boolean value for facet {facet.name!r} in {path}: {value!r}",
            path=path,
            field=facet.name,
            selector=facet.source,
            value=value,
        )
    if facet.type == "date":
        try:
            return date.fromisoformat(text).isoformat()
        except ValueError as error:
            raise BuildError(
                "FACET_VALUE_INVALID",
                f"invalid ISO date value for facet {facet.name!r} in {path}: {value!r}",
                path=path,
                field=facet.name,
                selector=facet.source,
                value=value,
            ) from error
    raise BuildError("CONFIG_INVALID", f"unsupported scalar facet type: {facet.type}")


def _build_term_variants(
    connection: sqlite3.Connection, config: DredgeConfig
) -> list[tuple[str, str]]:
    """Populate ``dredge_term_variants`` and return the rows written.

    Groups are generated from the finished index, merged with the declared
    synonym groups, then have the suppressed pairings removed — in that order,
    so a suppression can break a generated group apart (``statue``/``status``).
    """
    adjacency: dict[str, set[str]] = {}
    if config.variant_generation:
        for group in _generated_variant_groups(connection):
            _link_variant_group(adjacency, group)
    for group in config.synonym_groups:
        _link_variant_group(adjacency, group)
    for left, right in config.suppressed_variants:
        adjacency.get(left, set()).discard(right)
        adjacency.get(right, set()).discard(left)

    rows = sorted(
        (term, " ".join(sorted(variants)))
        for term, variants in adjacency.items()
        if variants
    )
    connection.executemany(
        "INSERT INTO dredge_term_variants(term, variants) VALUES (?, ?)", rows
    )
    return rows


def _link_variant_group(adjacency: dict[str, set[str]], group: Sequence[str]) -> None:
    members = set(group)
    for term in members:
        adjacency.setdefault(term, set()).update(members - {term})


def _generated_variant_groups(
    connection: sqlite3.Connection,
) -> list[tuple[str, ...]]:
    """Group the index's own surface terms by the stem SQLite's porter gives them.

    Each surface term goes into a scratch porter-tokenized FTS table as its own
    row; ``fts5vocab`` then reports which rows share a stem. The stems are a
    build-time grouping key only and are never written anywhere.
    """
    connection.execute(
        "CREATE VIRTUAL TABLE temp.dredge_surface_vocab USING "
        "fts5vocab('main', 'documents_fts', 'row')"
    )
    try:
        terms = [
            row[0]
            for row in connection.execute("SELECT term FROM temp.dredge_surface_vocab")
        ]
        connection.execute(
            "CREATE VIRTUAL TABLE temp.dredge_stems USING "
            f"fts5(term, tokenize='{VARIANT_STEM_TOKENIZER}')"
        )
        try:
            connection.executemany(
                "INSERT INTO temp.dredge_stems(rowid, term) VALUES (?, ?)",
                list(enumerate(terms, start=1)),
            )
            connection.execute(
                "CREATE VIRTUAL TABLE temp.dredge_stem_vocab USING "
                "fts5vocab('temp', 'dredge_stems', 'instance')"
            )
            try:
                by_stem: dict[str, set[str]] = {}
                for stem, doc in connection.execute(
                    "SELECT term, doc FROM temp.dredge_stem_vocab"
                ):
                    by_stem.setdefault(stem, set()).add(terms[int(doc) - 1])
            finally:
                connection.execute("DROP TABLE temp.dredge_stem_vocab")
        finally:
            connection.execute("DROP TABLE temp.dredge_stems")
    finally:
        connection.execute("DROP TABLE temp.dredge_surface_vocab")

    return [tuple(members) for members in by_stem.values() if len(members) > 1]


def _write_variants_json(
    variants_json_path: Path, rows: Sequence[tuple[str, str]]
) -> None:
    path = _absolute_path(variants_json_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "row_count": len(rows),
        "terms": {term: variants.split(" ") for term, variants in rows},
    }
    temporary_path = path.with_name(f"{path.name}.tmp")
    temporary_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temporary_path.replace(path)


def _finalize_database(
    connection: sqlite3.Connection,
    compact_db_path: Path,
    metrics: _MetricsRecorder,
    ui: CompileProgress,
) -> None:
    with metrics.phase("fts_optimize"):
        ui.set_phase("fts_optimize")
        connection.execute(
            "INSERT INTO documents_fts(documents_fts) VALUES('optimize')"
        )
    with metrics.phase("analyze"):
        connection.execute("ANALYZE")
        connection.execute("PRAGMA optimize")
    connection.commit()
    if compact_db_path.exists():
        compact_db_path.unlink()
    with metrics.phase("vacuum_into"):
        ui.set_phase("vacuum_into")
        connection.execute(f"VACUUM INTO {_quote_sql_string(str(compact_db_path))}")


def format_payload_report(report: dict[str, Any]) -> str:
    """Render a payload report (from ``result.metrics['payload_report']``) as text."""
    lines = ["payload report:"]
    if report["dbstat_available"]:
        total = report["total_bytes"] or 0
        lines.append(f"  size by table/index ({_format_bytes(total)} total):")
        for entry in report["tables"]:
            lines.append(
                f"    {entry['name']:<28} {_format_bytes(entry['bytes']):>12} "
                f"{entry['percent']:>6.2f}%"
            )
    else:
        lines.append("  size by table/index: unavailable (dbstat not compiled in)")

    variants = report["term_variants"]
    variant_bytes = (
        _format_bytes(variants["bytes"]) if variants["bytes"] is not None else "unknown"
    )
    lines.append(
        f"  term variants: {variants['row_count']:,} rows, {variant_bytes}"
    )

    lines.append(f"  documents columns ({report['row_count']:,} rows):")
    for column in report["columns"]:
        lines.append(
            f"    {column['name']:<28} {_format_bytes(column['total_bytes']):>12} "
            f"{column['distinct_count']:>10,} distinct"
        )
    return "\n".join(lines)


def _run_post_build_checks(
    db_path: Path,
    config: DredgeConfig,
    smoke_token: str | None,
    smoke_filter: tuple[str, str, str | int | float] | None,
    warnings: _WarningCollector,
) -> dict[str, Any]:
    connection = sqlite3.connect(f"file:{db_path}?mode=ro&immutable=1", uri=True)
    try:
        integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise BuildError(
                "DATABASE_INTEGRITY_CHECK_FAILED",
                f"PRAGMA integrity_check returned {integrity!r}",
            )
        _run_smoke_queries(connection, smoke_token, smoke_filter)
        _verify_query_plans(connection, config)
        return _build_payload_report(connection, config, warnings)
    finally:
        connection.close()


def _build_payload_report(
    connection: sqlite3.Connection,
    config: DredgeConfig,
    warnings: _WarningCollector,
) -> dict[str, Any]:
    """Summarize where the shipped database's bytes went and flag config smells.

    Runs on the read-only connection to the finished artifact. Warnings are
    emitted through ``warnings`` so they surface in ``CompileResult.warnings``
    alongside other build warnings; the size/column data is returned for the
    metrics JSON and the human-readable summary.
    """
    tables, dbstat_available, total_bytes = _payload_table_breakdown(connection)
    row_count = int(connection.execute("SELECT COUNT(*) FROM documents").fetchone()[0])
    columns = _payload_column_stats(connection, row_count)
    _emit_payload_warnings(connection, config, columns, row_count, warnings)
    return {
        "dbstat_available": dbstat_available,
        "total_bytes": total_bytes,
        "row_count": row_count,
        "tables": tables,
        "columns": columns,
        "term_variants": _payload_term_variant_stats(connection, tables),
    }


def _payload_term_variant_stats(
    connection: sqlite3.Connection, tables: list[dict[str, Any]]
) -> dict[str, Any]:
    """What the variant table costs, so its price is visible before publishing."""
    variant_bytes = next(
        (
            entry["bytes"]
            for entry in tables
            if entry["name"] == "dredge_term_variants"
        ),
        None,
    )
    return {
        "row_count": int(
            connection.execute(
                "SELECT COUNT(*) FROM dredge_term_variants"
            ).fetchone()[0]
        ),
        "bytes": variant_bytes,
    }


def _payload_table_breakdown(
    connection: sqlite3.Connection,
) -> tuple[list[dict[str, Any]], bool, int | None]:
    try:
        rows = connection.execute(
            "SELECT name, SUM(pgsize) FROM dbstat GROUP BY name ORDER BY SUM(pgsize) DESC"
        ).fetchall()
    except sqlite3.OperationalError:
        # dbstat is a compile-time option; degrade to skipping the table
        # breakdown rather than failing the build.
        return [], False, None
    total = sum(int(row[1]) for row in rows)
    tables = [
        {
            "name": row[0],
            "bytes": int(row[1]),
            "percent": round(int(row[1]) / total * 100, 2) if total else 0.0,
        }
        for row in rows
    ]
    return tables, True, total


def _payload_column_stats(
    connection: sqlite3.Connection, row_count: int
) -> list[dict[str, Any]]:
    column_names = [row[1] for row in connection.execute("PRAGMA table_info(documents)")]
    columns: list[dict[str, Any]] = []
    for name in column_names:
        quoted = _quote_identifier(name)
        total_bytes, distinct_count = connection.execute(
            f"SELECT total(length(cast({quoted} AS BLOB))), count(distinct {quoted}) "
            "FROM documents"
        ).fetchone()
        total_bytes = int(total_bytes)
        columns.append(
            {
                "name": name,
                "total_bytes": total_bytes,
                "average_bytes": round(total_bytes / row_count, 2) if row_count else 0.0,
                "distinct_count": int(distinct_count),
            }
        )
    return columns


def _emit_payload_warnings(
    connection: sqlite3.Connection,
    config: DredgeConfig,
    columns: list[dict[str, Any]],
    row_count: int,
    warnings: _WarningCollector,
) -> None:
    distinct_by_name = {column["name"]: column["distinct_count"] for column in columns}
    for facet in config.scalar_facets:
        distinct = distinct_by_name.get(facet.name)
        if distinct is not None and distinct > PAYLOAD_HIGH_CARDINALITY_THRESHOLD:
            warnings.add(
                code="PAYLOAD_HIGH_CARDINALITY_FACET",
                message=(
                    f"facet {facet.name!r} has {distinct:,} distinct values "
                    f"(threshold {PAYLOAD_HIGH_CARDINALITY_THRESHOLD:,}); consider "
                    "declaring it a store_field if you do not filter or count on it"
                ),
                field=facet.name,
            )

    if row_count == 0:
        return
    threshold = PAYLOAD_DUPLICATE_COLUMN_RATIO * row_count
    names = [column["name"] for column in columns if column["name"] != "id"]
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            left = _quote_identifier(names[i])
            right = _quote_identifier(names[j])
            match_rows, nonnull_equal = connection.execute(
                f"SELECT SUM(CASE WHEN {left} IS {right} THEN 1 ELSE 0 END), "
                f"SUM(CASE WHEN {left} = {right} THEN 1 ELSE 0 END) FROM documents"
            ).fetchone()
            match_rows = int(match_rows or 0)
            nonnull_equal = int(nonnull_equal or 0)
            # Require some non-null overlap so two all-empty columns (equal only
            # by shared nullness) are not flagged as duplicates.
            if match_rows >= threshold and nonnull_equal > 0:
                percent = round(match_rows / row_count * 100, 1)
                warnings.add(
                    code="PAYLOAD_DUPLICATE_COLUMNS",
                    message=(
                        f"columns {names[i]!r} and {names[j]!r} are equal on "
                        f"{percent}% of rows; consider dropping one"
                    ),
                )


def _write_generated_client(config: DredgeConfig) -> Path | None:
    from .codegen import write_client

    return write_client(config)


def _install_runtime_assets(output_dir: Path, precompress: bool) -> tuple[Path, ...]:
    from .runtime_assets import install_runtime_assets

    return install_runtime_assets(output_dir, precompress=precompress)


def _run_smoke_queries(
    connection: sqlite3.Connection,
    smoke_token: str | None,
    smoke_filter: tuple[str, str, str | int | float] | None,
) -> None:
    if smoke_token is None:
        raise BuildError(
            "SMOKE_QUERY_FAILED", "could not find a token for the FTS smoke query"
        )

    fts_count = connection.execute(
        "SELECT COUNT(*) FROM documents_fts WHERE documents_fts MATCH ?",
        (smoke_token,),
    ).fetchone()[0]
    if fts_count < 1:
        raise BuildError(
            "SMOKE_QUERY_FAILED",
            f"FTS smoke query returned no rows for token {smoke_token!r}",
        )

    if smoke_filter is None:
        filtered_count = connection.execute(
            "SELECT COUNT(*) FROM documents WHERE id = 1"
        ).fetchone()[0]
    elif smoke_filter[0] == "array":
        _, name, value = smoke_filter
        filtered_count = connection.execute(
            f"SELECT COUNT(*) FROM {_quote_identifier(_array_table_name(name))} WHERE value = ?",
            (value,),
        ).fetchone()[0]
    else:
        _, name, value = smoke_filter
        filtered_count = connection.execute(
            f"SELECT COUNT(*) FROM documents WHERE {_quote_identifier(name)} = ?",
            (value,),
        ).fetchone()[0]
    if filtered_count < 1:
        raise BuildError("SMOKE_QUERY_FAILED", "filtered smoke query returned no rows")


def _verify_query_plans(connection: sqlite3.Connection, config: DredgeConfig) -> None:
    for facet in config.scalar_facets:
        index_name = f"documents_{facet.name}_idx"
        facet_column = _quote_identifier(facet.name)
        sql = (
            f"SELECT id FROM documents INDEXED BY {_quote_identifier(index_name)} "
            f"WHERE {facet_column} = ? ORDER BY id LIMIT 10"
        )
        _assert_query_plan_uses_index(
            connection, f"scalar facet {facet.name!r}", sql, (None,), index_name
        )

    for facet in config.array_facets:
        table_name = _quote_identifier(_array_table_name(facet.name))
        index_name = f"facet_{facet.name}_value_document_idx"
        sql = (
            f"SELECT document_id FROM {table_name} INDEXED BY {_quote_identifier(index_name)} "
            "WHERE value = ? ORDER BY document_id LIMIT 10"
        )
        _assert_query_plan_uses_index(
            connection, f"array facet {facet.name!r}", sql, (None,), index_name
        )

    for index in config.composite_indices:
        index_name = _composite_index_name(index)
        where_clause = " AND ".join(
            f"{_quote_identifier(column)} = ?" for column in index
        )
        sql = (
            f"SELECT id FROM documents INDEXED BY {_quote_identifier(index_name)} "
            f"WHERE {where_clause} ORDER BY id LIMIT 10"
        )
        _assert_query_plan_uses_index(
            connection,
            f"composite index {', '.join(index)!r}",
            sql,
            tuple(None for _ in index),
            index_name,
        )


def _assert_query_plan_uses_index(
    connection: sqlite3.Connection,
    label: str,
    sql: str,
    parameters: tuple[Any, ...],
    index_name: str,
) -> None:
    details = _query_plan_details(connection, sql, parameters)
    if any("SEARCH" in detail.upper() and index_name in detail for detail in details):
        return
    detail_text = " | ".join(details)
    raise BuildError(
        "QUERY_PLAN_VERIFICATION_FAILED",
        f"{label} query plan did not use generated index {index_name!r}: {detail_text}",
    )


def _query_plan_details(
    connection: sqlite3.Connection, sql: str, parameters: tuple[Any, ...]
) -> tuple[str, ...]:
    return tuple(
        str(row[3])
        for row in connection.execute(f"EXPLAIN QUERY PLAN {sql}", parameters)
    )


def _first_search_token(text: str) -> str | None:
    for match in TOKEN_RE.finditer(text):
        token = match.group(0)
        if len(token) > 1:
            return token
    return None


def _first_filter(
    document: ExtractedDocument,
) -> tuple[str, str, str | int | float] | None:
    for name, value in document.scalar_facets.items():
        if value is not None:
            return ("scalar", name, value)
    for name, values in document.array_facets.items():
        if values:
            return ("array", name, values[0])
    return None


def _parse_source(source: str, allow_direct_attribute: bool) -> tuple[str, str, str]:
    if "@" in source:
        selector, attribute = source.rsplit("@", 1)
        return "selector_attribute", selector.strip(), attribute.strip()
    if allow_direct_attribute and source.startswith("data-"):
        return "attribute", "", source
    return "selector_text", source, ""


def _validate_selector_source(
    source: str, field_name: str, allow_direct_attribute: bool
) -> None:
    kind, selector, attribute = _parse_source(
        source, allow_direct_attribute=allow_direct_attribute
    )
    if kind == "attribute":
        if not ATTRIBUTE_RE.match(attribute):
            raise BuildError(
                "CONFIG_INVALID",
                f"{field_name} has invalid attribute source: {source!r}",
            )
        return
    if kind == "selector_attribute" and not ATTRIBUTE_RE.match(attribute):
        raise BuildError(
            "CONFIG_INVALID", f"{field_name} has invalid attribute name: {attribute!r}"
        )
    if not selector:
        raise BuildError("CONFIG_INVALID", f"{field_name} has an empty CSS selector")
    try:
        HTMLParser("").css(selector)
    except Exception as error:
        raise BuildError(
            "CONFIG_INVALID",
            f"{field_name} has invalid CSS selector {selector!r}: {error}",
        ) from error


def _required_path(raw: dict[str, Any], key: str, base_dir: Path) -> Path:
    value = raw.get(key)
    if not isinstance(value, str) or not value.strip():
        raise BuildError("CONFIG_INVALID", f"{key} must be a non-empty string")
    return _resolve_path(value, base_dir)


def _resolve_path(value: str, base_dir: Path) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = base_dir / path
    return path.resolve()


def _absolute_path(path: Path) -> Path:
    path = path.expanduser()
    if not path.is_absolute():
        path = Path.cwd() / path
    return path.resolve()


def _optional_string(raw: dict[str, Any], key: str, default: str) -> str:
    value = raw.get(key, default)
    if not isinstance(value, str) or not value.strip():
        raise BuildError("CONFIG_INVALID", f"{key} must be a non-empty string")
    return value.strip()


def _optional_bool(raw: dict[str, Any], key: str, default: bool) -> bool:
    value = raw.get(key, default)
    if not isinstance(value, bool):
        raise BuildError("CONFIG_INVALID", f"{key} must be a boolean")
    return value


def _optional_string_list(
    raw: dict[str, Any], key: str, default: list[str]
) -> list[str]:
    value = raw.get(key, default)
    if not isinstance(value, list) or not all(
        isinstance(item, str) and item.strip() for item in value
    ):
        raise BuildError(
            "CONFIG_INVALID", f"{key} must be an array of non-empty strings"
        )
    return [item.strip() for item in value]


def _same_or_child(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def _matches_any(rel_path: str, patterns: tuple[str, ...]) -> bool:
    pure_path = PurePosixPath(rel_path)
    for pattern in patterns:
        if pure_path.match(pattern) or fnmatch.fnmatchcase(rel_path, pattern):
            return True
        if pattern.startswith("**/"):
            root_pattern = pattern[3:]
            if pure_path.match(root_pattern) or fnmatch.fnmatchcase(
                rel_path, root_pattern
            ):
                return True
    return False


def _canonical_url(base_url: str, rel_path: str) -> str:
    if rel_path == "index.html":
        url_path = ""
    elif rel_path.endswith("/index.html"):
        url_path = rel_path[: -len("index.html")]
    else:
        url_path = rel_path
    base = base_url if base_url.endswith("/") else f"{base_url}/"
    return urljoin(base, url_path)


def _normalize_text(value: str) -> str:
    return unicodedata.normalize("NFC", " ".join(value.split()))


def _write_metrics_json(metrics_json_path: Path, metrics: dict[str, Any]) -> None:
    path = _absolute_path(metrics_json_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_name(f"{path.name}.tmp")
    temporary_path.write_text(
        json.dumps(metrics, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    temporary_path.replace(path)


def _round_seconds(value: float) -> float:
    return round(value, 6)


def _path_size(path: Path) -> int | None:
    try:
        return path.stat().st_size
    except OSError:
        return None


def _sqlite_database_size_bytes(connection: sqlite3.Connection) -> int | None:
    page_count = connection.execute("PRAGMA page_count").fetchone()
    page_size = connection.execute("PRAGMA page_size").fetchone()
    if page_count is None or page_size is None:
        return None
    return int(page_count[0]) * int(page_size[0])


def _peak_rss_bytes() -> int | None:
    try:
        import resource
    except ImportError:
        return None

    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    if peak <= 0:
        return None
    if sys.platform == "darwin":
        return int(peak)
    return int(peak * 1024)


def _format_duration(seconds: float | None) -> str:
    if seconds is None:
        return "unknown"
    total_seconds = max(int(seconds), 0)
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    if hours:
        return f"{hours:d}:{minutes:02d}:{seconds:02d}"
    return f"{minutes:02d}:{seconds:02d}"


def _format_bytes(size: int | None) -> str:
    if size is None:
        return "unknown"
    value = float(size)
    for unit in ("B", "KiB", "MiB", "GiB"):
        if value < 1024 or unit == "GiB":
            return f"{value:.1f} {unit}" if unit != "B" else f"{int(value)} B"
        value /= 1024
    return f"{value:.1f} GiB"


def _sha256_text(value: str) -> str:
    return _sha256_bytes(value.encode("utf-8"))


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _brotli_compress_file(
    source: Path,
    destination: Path,
    *,
    quality: int = BROTLI_QUALITY,
    on_chunk: Callable[[int], None] | None = None,
) -> int:
    compressor = brotli.Compressor(quality=quality)
    with source.open("rb") as src, destination.open("wb") as dst:
        for chunk in iter(lambda: src.read(1024 * 1024), b""):
            compressed = compressor.process(chunk)
            if compressed:
                dst.write(compressed)
            if on_chunk is not None:
                on_chunk(len(chunk))
        tail = compressor.finish()
        if tail:
            dst.write(tail)
    return destination.stat().st_size


def _array_table_name(facet_name: str) -> str:
    return f"facet_{facet_name}"


def _composite_index_name(index: tuple[str, ...]) -> str:
    return "documents_" + "_".join(index) + "_idx"


def _quote_identifier(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _quote_sql_string(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"
