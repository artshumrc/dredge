from __future__ import annotations

import gzip
import hashlib
import json
import shutil
import sqlite3
import subprocess
from pathlib import Path
from typing import Any

import brotli
import pytest

from dredge import compiler
from dredge.codegen import CLIENT_TEMPLATE_RESOURCE, generate_client_source
from dredge.cli import main
from dredge.compiler import BuildError, compile_site, load_config

def test_compile_fixture_site_and_query_results(tmp_path: Path) -> None:
    config_path, output_dir = _write_fixture_project(tmp_path)

    result = compile_site(config_path)

    assert result.page_count == 2
    assert result.manifest_path == output_dir / "search-manifest.json"
    assert result.compressed_db_path == output_dir / result.manifest["db_file"]
    assert result.manifest["db_file"].endswith(".db.br")
    assert result.manifest["db_sha256"] in result.manifest["db_file"]
    assert result.manifest["db_compression"] == "brotli"
    assert result.manifest["db_bytes"] == result.db_path.stat().st_size
    assert (
        result.manifest["db_compressed_bytes"]
        == result.compressed_db_path.stat().st_size
    )
    assert "range_required" not in result.manifest
    assert "range_block_bytes" not in result.manifest
    assert result.manifest["db_schema_version"] == 3

    decompressed = brotli.decompress(result.compressed_db_path.read_bytes())
    assert decompressed == result.db_path.read_bytes()
    assert len(decompressed) == result.manifest["db_bytes"]

    connection = sqlite3.connect(result.db_path)
    try:
        fts_rows = connection.execute(
            """
            SELECT d.url
            FROM documents_fts
            JOIN documents d ON d.id = documents_fts.rowid
            WHERE documents_fts MATCH ?
            ORDER BY d.id
            """,
            ("golden",),
        ).fetchall()
        assert fts_rows == [("/",)]

        filtered_rows = connection.execute(
            "SELECT url FROM documents WHERE category = ? AND year = ?",
            ("guide", 2024),
        ).fetchall()
        assert filtered_rows == [("/",)]

        typed_facet_rows = connection.execute(
            "SELECT rating, featured, published FROM documents WHERE id = 1"
        ).fetchall()
        assert typed_facet_rows == [(4.5, 1, "2024-01-30")]

        tag_rows = connection.execute(
            "SELECT value FROM facet_tags WHERE document_id = 1 ORDER BY value"
        ).fetchall()
        assert tag_rows == [("ancient",), ("burial",)]

        field_rows = connection.execute(
            "SELECT name, role, type FROM dredge_fields ORDER BY name"
        ).fetchall()
        assert field_rows == [
            ("category", "facet", "string"),
            ("featured", "facet", "boolean"),
            ("image", "store", "string"),
            ("published", "facet", "date"),
            ("rating", "facet", "number"),
            ("tags", "facet", "string_array"),
            ("year", "facet", "integer"),
        ]
        assert connection.execute(
            "SELECT image FROM documents WHERE id = 1"
        ).fetchone() == ("/images/alpha.jpg",)

        script_rows = connection.execute(
            """
            SELECT d.url
            FROM documents_fts
            JOIN documents d ON d.id = documents_fts.rowid
            WHERE documents_fts MATCH ?
            """,
            ("secret",),
        ).fetchall()
        assert script_rows == []
    finally:
        connection.close()


def test_cli_validate_and_compile(tmp_path: Path) -> None:
    config_path, output_dir = _write_fixture_project(tmp_path)

    assert main(["validate", "--config", str(config_path)]) == 0
    assert main(["compile", "--config", str(config_path)]) == 0
    assert (output_dir / "search-manifest.json").exists()


def test_cli_compile_prints_payload_report(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    config_path, _ = _write_fixture_project(tmp_path)

    assert main(["compile", "--config", str(config_path)]) == 0

    output = capsys.readouterr().out
    assert "payload report" in output.lower()
    assert "documents" in output
    assert "image" in output


def test_cli_compile_accepts_low_brotli_quality(tmp_path: Path) -> None:
    config_path, output_dir = _write_fixture_project(tmp_path)

    assert (
        main(
            [
                "compile",
                "--config",
                str(config_path),
                "--brotli-quality",
                "1",
            ]
        )
        == 0
    )

    manifest = json.loads(
        (output_dir / "search-manifest.json").read_text(encoding="utf-8")
    )
    compressed_path = output_dir / manifest["db_file"]
    db_path = output_dir / manifest["db_file"].removesuffix(".br")
    assert brotli.decompress(compressed_path.read_bytes()) == db_path.read_bytes()


def test_cli_compile_writes_metrics_json(tmp_path: Path) -> None:
    config_path, _ = _write_fixture_project(tmp_path)
    metrics_path = tmp_path / "metrics.json"

    assert (
        main(
            [
                "compile",
                "--config",
                str(config_path),
                "--metrics-json",
                str(metrics_path),
            ]
        )
        == 0
    )

    metrics = json.loads(metrics_path.read_text(encoding="utf-8"))
    assert metrics["metrics_version"] == 1
    assert metrics["candidate_count"] == 2
    assert metrics["page_count"] == 2
    assert metrics["ingest"]["documents"] == 2
    assert metrics["ingest"]["documents_per_second"] > 0
    assert metrics["database"]["db_file"].startswith("search.")
    assert metrics["database"]["db_file"].endswith(".db.br")
    assert metrics["database"]["db_compression"] == "brotli"
    assert metrics["database"]["db_compressed_bytes"] > 0
    for phase in (
        "validation",
        "discovery",
        "extraction_ingest",
        "index_creation",
        "fts_optimize",
        "analyze",
        "vacuum_into",
        "hashing",
        "post_build_checks",
        "compression",
        "manifest_write",
    ):
        assert phase in metrics["phases"]
        assert metrics["phases"][phase] >= 0


def test_compile_is_deterministic_for_unchanged_input(tmp_path: Path) -> None:
    config_path, output_dir = _write_fixture_project(tmp_path)

    first = compile_site(config_path)
    first_manifest = first.manifest_path.read_bytes()
    first_db_hash = first.manifest["db_sha256"]

    second = compile_site(config_path)
    second_manifest = second.manifest_path.read_bytes()

    assert second.manifest["db_sha256"] == first_db_hash
    assert second_manifest == first_manifest

    connection = sqlite3.connect(second.db_path)
    try:
        rows = connection.execute(
            "SELECT id, url FROM documents ORDER BY id"
        ).fetchall()
    finally:
        connection.close()
    assert rows == [(1, "/"), (2, "/collections/beta/")]


def test_final_database_schema_indexes_and_query_plans(tmp_path: Path) -> None:
    config_path, _ = _write_fixture_project(tmp_path)

    result = compile_site(config_path)

    connection = sqlite3.connect(f"file:{result.db_path}?mode=ro&immutable=1", uri=True)
    try:
        assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        assert connection.execute("PRAGMA page_size").fetchone() == (16_384,)

        fts_sql = connection.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'documents_fts'"
        ).fetchone()[0]
        assert "content=''" in fts_sql

        index_names = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex%'"
            )
        }
        assert {
            "documents_category_idx",
            "documents_category_year_idx",
            "documents_featured_idx",
            "documents_published_idx",
            "documents_rating_idx",
            "documents_year_idx",
            "facet_tags_value_document_idx",
        } <= index_names
        assert "documents_image_idx" not in index_names

        assert connection.execute("SELECT COUNT(*) FROM sqlite_stat1").fetchone()[0] > 0

        assert _plan_uses_index(
            connection,
            "SELECT id FROM documents INDEXED BY documents_year_idx WHERE year = ? ORDER BY id",
            (2024,),
            "documents_year_idx",
        )
        assert _plan_uses_index(
            connection,
            """
            SELECT id
            FROM documents INDEXED BY documents_category_year_idx
            WHERE category = ? AND year = ?
            ORDER BY id
            """,
            ("guide", 2024),
            "documents_category_year_idx",
        )
        assert _plan_uses_index(
            connection,
            """
            SELECT document_id
            FROM facet_tags INDEXED BY facet_tags_value_document_idx
            WHERE value = ?
            ORDER BY document_id
            """,
            ("ancient",),
            "facet_tags_value_document_idx",
        )
    finally:
        connection.close()


def test_compile_emits_single_database_and_indexes_search_fields(
    tmp_path: Path,
) -> None:
    config_path, output_dir = _write_fixture_project(tmp_path)

    result = compile_site(config_path)

    manifest = result.manifest
    # A single database artifact is emitted — no hot tier.
    assert manifest["db_file"].startswith("search.")
    assert manifest["db_file"].endswith(".db.br")
    assert not any(key.startswith("hot_") for key in manifest)

    compressed = output_dir / manifest["db_file"]
    assert compressed.exists()
    decompressed = brotli.decompress(compressed.read_bytes())
    assert hashlib.sha256(decompressed).hexdigest() == manifest["db_sha256"]

    connection = sqlite3.connect(
        f"file:{result.db_path}?mode=ro&immutable=1", uri=True
    )
    try:
        # The one FTS index covers title and body.
        fts_columns = [
            row[1] for row in connection.execute("PRAGMA table_info(documents_fts)")
        ]
        assert fts_columns == ["title", "body"]

        # Title tokens match.
        assert connection.execute(
            "SELECT COUNT(*) FROM documents_fts WHERE documents_fts MATCH ?",
            ("tombs",),
        ).fetchone()[0] == 1
        # Search-field text (from data-dredge-catalog) is folded into the body FTS.
        assert connection.execute(
            "SELECT d.id FROM documents_fts "
            "JOIN documents d ON d.id = documents_fts.rowid "
            "WHERE documents_fts MATCH ? ORDER BY d.id",
            ("zeta9000",),
        ).fetchall() == [(1,)]
        # Body content is searchable too.
        assert connection.execute(
            "SELECT COUNT(*) FROM documents_fts WHERE documents_fts MATCH ?",
            ("golden",),
        ).fetchone()[0] == 1
    finally:
        connection.close()


def test_compile_without_search_fields_indexes_title_and_body(tmp_path: Path) -> None:
    config_path, _ = _write_fixture_project(tmp_path, search_field=False)

    result = compile_site(config_path)

    assert not any(key.startswith("hot_") for key in result.manifest)
    connection = sqlite3.connect(
        f"file:{result.db_path}?mode=ro&immutable=1", uri=True
    )
    try:
        fts_columns = [
            row[1] for row in connection.execute("PRAGMA table_info(documents_fts)")
        ]
        assert fts_columns == ["title", "body"]
        assert connection.execute(
            "SELECT COUNT(*) FROM documents_fts WHERE documents_fts MATCH ?",
            ("tombs",),
        ).fetchone()[0] == 1
    finally:
        connection.close()


# The two-column index every config produced before Search Columns existed. A
# config that names none must still compile to exactly this, byte for byte.
DEFAULT_FTS_SQL = (
    "CREATE VIRTUAL TABLE documents_fts USING fts5("
    "title, body, content='', tokenize='unicode61 remove_diacritics 2')"
)


def test_config_naming_no_search_columns_keeps_the_two_column_index(
    tmp_path: Path,
) -> None:
    config_path, _ = _write_fixture_project(tmp_path)

    result = compile_site(config_path)

    connection = sqlite3.connect(f"file:{result.db_path}?mode=ro&immutable=1", uri=True)
    try:
        assert (
            connection.execute(
                "SELECT sql FROM sqlite_master WHERE name = 'documents_fts'"
            ).fetchone()[0]
            == DEFAULT_FTS_SQL
        )
        assert [
            row[1] for row in connection.execute("PRAGMA table_info(documents_fts)")
        ] == ["title", "body"]
        # The default weights ship in the artifact, so the Runtime reads them
        # rather than holding ranking constants of its own.
        assert connection.execute(
            "SELECT name, position, weight FROM dredge_search_columns ORDER BY position"
        ).fetchall() == [("title", 0, 10.0), ("body", 1, 1.0)]
        # An unnamed search field is still folded into the body column.
        assert connection.execute(
            "SELECT COUNT(*) FROM documents_fts WHERE documents_fts MATCH ?",
            ("{body}:zeta9000",),
        ).fetchone()[0] == 1
    finally:
        connection.close()


def test_named_search_fields_become_weighted_search_columns(tmp_path: Path) -> None:
    config_path, _ = _write_fixture_project(
        tmp_path,
        search_fields=[
            {"source": "data-dredge-catalog", "name": "catalog"},
            {"source": "data-dredge-image", "name": "imageref"},
        ],
        search_weights={"title": 4.0, "catalog": 25.0},
    )

    result = compile_site(config_path)

    connection = sqlite3.connect(f"file:{result.db_path}?mode=ro&immutable=1", uri=True)
    try:
        # Named fields become columns after the built-ins, in config order, and
        # each carries its own weight — one declared, one left at the default.
        assert [
            row[1] for row in connection.execute("PRAGMA table_info(documents_fts)")
        ] == ["title", "body", "catalog", "imageref"]
        assert connection.execute(
            "SELECT name, position, weight FROM dredge_search_columns ORDER BY position"
        ).fetchall() == [
            ("title", 0, 4.0),
            ("body", 1, 1.0),
            ("catalog", 2, 25.0),
            ("imageref", 3, 1.0),
        ]
        assert connection.execute(
            "SELECT COUNT(*) FROM documents_fts WHERE documents_fts MATCH ?",
            ("{imageref}:alpha",),
        ).fetchone()[0] == 1

        # The named field's text left the body for its own column, so a scope
        # separates it from the same string in prose.
        assert connection.execute(
            "SELECT COUNT(*) FROM documents_fts WHERE documents_fts MATCH ?",
            ("{catalog}:zeta9000",),
        ).fetchone()[0] == 1
        assert connection.execute(
            "SELECT COUNT(*) FROM documents_fts WHERE documents_fts MATCH ?",
            ("{body}:zeta9000",),
        ).fetchone()[0] == 0
        # Unscoped search still reaches it.
        assert connection.execute(
            "SELECT COUNT(*) FROM documents_fts WHERE documents_fts MATCH ?",
            ("zeta9000",),
        ).fetchone()[0] == 1
    finally:
        connection.close()


def test_payload_report_prices_each_search_column(tmp_path: Path) -> None:
    config_path, _ = _write_fixture_project(
        tmp_path,
        search_fields=[{"source": "data-dredge-catalog", "name": "catalog"}],
        search_weights={"catalog": 25.0},
    )

    result = compile_site(config_path)

    report = result.metrics["payload_report"]["search_columns"]
    assert [column["name"] for column in report["columns"]] == [
        "title",
        "body",
        "catalog",
    ]
    by_name = {column["name"]: column for column in report["columns"]}
    assert by_name["catalog"]["weight"] == 25.0
    assert by_name["catalog"]["postings"] > 0
    assert sum(column["bytes"] for column in report["columns"]) > 0
    assert report["index_bytes"] > 0

    rendered = compiler.format_payload_report(result.metrics["payload_report"])
    assert "search columns" in rendered
    assert "catalog" in rendered


@pytest.mark.parametrize(
    ("field_name", "weights", "message"),
    [
        ("title", None, "is reserved"),
        ("not an identifier", None, "must be an identifier"),
        ("catalog", {"nosuch": 2.0}, "unknown Search Column"),
        ("catalog", {"catalog": -1.0}, "finite non-negative"),
        ("catalog", {"catalog": "heavy"}, "must be a number"),
    ],
)
def test_search_column_config_is_validated(
    tmp_path: Path,
    field_name: str,
    weights: dict[str, float] | None,
    message: str,
) -> None:
    config_path, _ = _write_fixture_project(
        tmp_path,
        search_fields=[{"source": "data-dredge-catalog", "name": field_name}],
        search_weights=weights,
    )

    with pytest.raises(BuildError) as error:
        load_config(config_path)

    assert error.value.code == "CONFIG_INVALID"
    assert message in str(error.value)


def test_declared_boosts_ship_in_the_artifact(tmp_path: Path) -> None:
    config_path, _ = _write_fixture_project(
        tmp_path,
        boosts={
            "category": {"values": {"collection": 2.5, "guide": 0.5}},
            "year": {"values": {"2024": 3.0}},
            "published": {"recency": {"max": 4.0, "half_life_days": 90}},
        },
    )

    result = compile_site(config_path)

    connection = sqlite3.connect(f"file:{result.db_path}?mode=ro&immutable=1", uri=True)
    try:
        rows = connection.execute(
            "SELECT facet, shape, value, multiplier, half_life_days "
            "FROM dredge_boosts ORDER BY rowid"
        ).fetchall()
        assert rows == [
            ("category", "value", "collection", 2.5, None),
            ("category", "value", "guide", 0.5, None),
            ("published", "recency", None, 4.0, 90.0),
            ("year", "value", 2024, 3.0, None),
        ]
        # A boost on an integer facet has to reach the Runtime as an integer, or
        # the comparison it compiles into never matches the column.
        assert isinstance(rows[3][2], int)
    finally:
        connection.close()


def test_recency_boost_defaults_its_curve(tmp_path: Path) -> None:
    config_path, _ = _write_fixture_project(
        tmp_path, boosts={"published": {"recency": {}}}
    )

    result = compile_site(config_path)

    connection = sqlite3.connect(f"file:{result.db_path}?mode=ro&immutable=1", uri=True)
    try:
        assert connection.execute(
            "SELECT multiplier, half_life_days FROM dredge_boosts"
        ).fetchall() == [(2.0, 730.0)]
    finally:
        connection.close()


def test_config_declaring_no_boost_ships_an_empty_boost_table(tmp_path: Path) -> None:
    config_path, _ = _write_fixture_project(tmp_path)

    result = compile_site(config_path)

    connection = sqlite3.connect(f"file:{result.db_path}?mode=ro&immutable=1", uri=True)
    try:
        assert (
            connection.execute("SELECT COUNT(*) FROM dredge_boosts").fetchone()[0] == 0
        )
    finally:
        connection.close()


@pytest.mark.parametrize(
    ("boosts", "message"),
    [
        ({"image": {"values": {"a": 2.0}}}, "names a store field"),
        ({"nosuch": {"values": {"a": 2.0}}}, "names unknown facet"),
        ({"tags": {"values": {"burial": 2.0}}}, "names array facet"),
        ({"year": {"recency": {}}}, "needs a date facet"),
        ({"category": {}}, "must declare exactly one of"),
        (
            {"category": {"values": {"guide": 2.0}, "recency": {}}},
            "must declare exactly one of",
        ),
        ({"category": {"curve": {}}}, "unknown key(s) on boosts[category]"),
        ({"category": {"values": {}}}, "must be a non-empty object"),
        ({"category": {"values": {"guide": 0}}}, "finite positive multiplier"),
        ({"category": {"values": {"guide": "heavy"}}}, "must be a number"),
        ({"year": {"values": {"soon": 2.0}}}, "is not a valid integer"),
        ({"published": {"recency": {"max": 0.5}}}, "must be at least 1.0"),
        (
            {"published": {"recency": {"half_life_days": 0}}},
            "finite positive number of days",
        ),
        (
            {"published": {"recency": {"decay": 2}}},
            "unknown key(s) on boosts[published].recency",
        ),
    ],
)
def test_boost_config_is_validated(
    tmp_path: Path, boosts: dict[str, Any], message: str
) -> None:
    config_path, _ = _write_fixture_project(tmp_path, boosts=boosts)

    with pytest.raises(BuildError) as error:
        load_config(config_path)

    assert error.value.code == "CONFIG_INVALID"
    assert message in str(error.value)


def test_artifact_omits_content_hash_and_url_autoindex(tmp_path: Path) -> None:
    config_path, _ = _write_fixture_project(tmp_path)

    result = compile_site(config_path)

    connection = sqlite3.connect(f"file:{result.db_path}?mode=ro&immutable=1", uri=True)
    try:
        columns = {
            row[1] for row in connection.execute("PRAGMA table_info(documents)")
        }
        assert "content_hash" not in columns
        assert "url" in columns

        document_autoindexes = [
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'index' "
                "AND name LIKE 'sqlite_autoindex_documents_%'"
            )
        ]
        assert document_autoindexes == []

        documents_sql = connection.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'documents'"
        ).fetchone()[0]
        assert "UNIQUE" not in documents_sql.upper()
    finally:
        connection.close()

    assert "content_hash" not in result.manifest


def test_duplicate_urls_fail_at_discovery(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # URL uniqueness is enforced at discovery time; the shipped documents table
    # no longer carries a UNIQUE(url) constraint. Force a URL collision to prove
    # discovery remains the sole guard.
    import dredge.compiler as compiler_module

    monkeypatch.setattr(
        compiler_module, "_canonical_url", lambda base_url, rel_path: "/dupe/"
    )
    config_path, output_dir = _write_fixture_project(tmp_path)

    with pytest.raises(BuildError) as error:
        compile_site(config_path)

    assert error.value.code == "DISCOVERY_DUPLICATE_URL"
    assert not (output_dir / "search-manifest.json").exists()


def test_invalid_config_fails_before_output(tmp_path: Path) -> None:
    output_dir = tmp_path / "search"
    config_path = tmp_path / "dredge.config.json"
    config_path.write_text(
        json.dumps(
            {"source_dir": str(tmp_path / "missing"), "output_dir": str(output_dir)}
        ),
        encoding="utf-8",
    )

    with pytest.raises(BuildError) as error:
        compile_site(config_path)

    assert error.value.code == "CONFIG_INVALID"
    assert not output_dir.exists()


def test_cli_validate_invalid_config_fails_before_output(tmp_path: Path) -> None:
    output_dir = tmp_path / "search"
    config_path = tmp_path / "dredge.config.json"
    config_path.write_text(
        json.dumps(
            {"source_dir": str(tmp_path / "missing"), "output_dir": str(output_dir)}
        ),
        encoding="utf-8",
    )

    assert main(["validate", "--config", str(config_path)]) == 1
    assert not output_dir.exists()


def test_missing_required_facet_reports_file_path(tmp_path: Path) -> None:
    config_path, output_dir = _write_fixture_project(
        tmp_path,
        index_attrs="data-dredge-year='2024'",
    )

    with pytest.raises(BuildError) as error:
        compile_site(config_path)

    assert error.value.code == "FACET_REQUIRED_MISSING"
    assert error.value.path is not None
    assert error.value.path.name == "index.html"
    assert error.value.field == "category"
    assert error.value.selector == "data-dredge-category"
    assert "index.html" in str(error.value)
    assert not (output_dir / "search-manifest.json").exists()


def test_malformed_facet_value_reports_file_path(tmp_path: Path) -> None:
    config_path, output_dir = _write_fixture_project(
        tmp_path,
        index_attrs="data-dredge-category='guide' data-dredge-year='twenty-four'",
    )

    with pytest.raises(BuildError) as error:
        compile_site(config_path)

    assert error.value.code == "FACET_VALUE_INVALID"
    assert error.value.path is not None
    assert error.value.path.name == "index.html"
    assert error.value.field == "year"
    assert error.value.selector == "data-dredge-year"
    assert error.value.value == "twenty-four"
    assert "index.html" in str(error.value)
    assert "twenty-four" in str(error.value)
    assert not (output_dir / "search-manifest.json").exists()


def test_selector_warnings_are_aggregated_with_samples(tmp_path: Path) -> None:
    config_path, _ = _write_fixture_project(tmp_path, include_descriptions=False)

    result = compile_site(config_path)

    description_warnings = [
        warning for warning in result.warnings if warning.field == "description"
    ]
    assert len(description_warnings) == 1
    warning = description_warnings[0]
    assert warning.code == "SELECTOR_MISS"
    assert warning.count == 2
    assert len(warning.sample_paths) == 2
    assert "2 occurrences" in warning.message
    assert "index.html" in warning.message


def test_payload_report_structure_present_in_metrics(tmp_path: Path) -> None:
    config_path, _ = _write_fixture_project(tmp_path)

    result = compile_site(config_path)

    report = result.metrics["payload_report"]
    assert report["dbstat_available"] is True
    assert report["row_count"] == 2
    assert report["total_bytes"] > 0

    # Per-table/per-index breakdown covers documents and its FTS shadow tables,
    # with percentages that sum to ~100.
    table_names = {entry["name"] for entry in report["tables"]}
    assert "documents" in table_names
    assert all(entry["bytes"] > 0 for entry in report["tables"])
    assert abs(sum(entry["percent"] for entry in report["tables"]) - 100.0) < 1.0

    # Per-documents-column stats cover every column, including the store field.
    columns = {entry["name"]: entry for entry in report["columns"]}
    assert {"id", "url", "title", "description", "category", "image"} <= set(columns)
    assert columns["url"]["distinct_count"] == 2
    assert columns["image"]["total_bytes"] > 0
    assert columns["image"]["average_bytes"] > 0


def test_payload_report_warns_on_high_cardinality_facet(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path, _ = _write_fixture_project(tmp_path)
    monkeypatch.setattr(compiler, "PAYLOAD_HIGH_CARDINALITY_THRESHOLD", 1)

    result = compile_site(config_path)

    high_cardinality = [
        warning
        for warning in result.warnings
        if warning.code == "PAYLOAD_HIGH_CARDINALITY_FACET"
    ]
    category_warning = next(
        warning for warning in high_cardinality if warning.field == "category"
    )
    assert "distinct values" in category_warning.message
    assert "store_field" in category_warning.message


def test_payload_report_warns_on_near_duplicate_columns(tmp_path: Path) -> None:
    source_dir = tmp_path / "site"
    output_dir = tmp_path / "search"
    source_dir.mkdir()
    for index in range(1, 4):
        (source_dir / f"page-{index}.html").write_text(
            f"""
            <!doctype html>
            <html>
              <head><title>Page {index}</title></head>
              <body>
                <main data-dredge-image="/images/{index}.jpg">
                  <p>Searchable body text for page {index}.</p>
                </main>
              </body>
            </html>
            """,
            encoding="utf-8",
        )
    config = {
        "source_dir": str(source_dir),
        "output_dir": str(output_dir),
        "base_url": "/",
        "selectors": {"title": "title", "body": "main"},
        "store_fields": {
            "image": {"type": "string", "source": "data-dredge-image"},
            "thumbnail": {"type": "string", "source": "data-dredge-image"},
        },
        "result_fields": ["title", "url", "image", "thumbnail"],
    }
    config_path = tmp_path / "dredge.config.json"
    config_path.write_text(json.dumps(config), encoding="utf-8")

    result = compile_site(config_path)

    duplicate_warnings = [
        warning
        for warning in result.warnings
        if warning.code == "PAYLOAD_DUPLICATE_COLUMNS"
    ]
    assert len(duplicate_warnings) == 1
    message = duplicate_warnings[0].message
    assert "image" in message
    assert "thumbnail" in message
    assert "100.0%" in message


def test_compile_writes_generated_types_worker_protocol_and_stale_handling(
    tmp_path: Path,
) -> None:
    client_path = tmp_path / "src" / "dredge-client.ts"
    config_path, _ = _write_fixture_project(
        tmp_path,
        client={
            "out": str(client_path),
            "worker_url": "/search/dredge-worker.abc123.js",
        },
    )

    result = compile_site(config_path)

    assert result.client_path == client_path
    source = client_path.read_text(encoding="utf-8")
    assert "export interface DredgeFilters" in source
    assert "category?: string | string[];" in source
    assert "image?:" not in source.split("export interface DredgeFilters", 1)[1].split("}", 1)[0]
    assert "tags?: string | string[];" in source
    assert "year?: number | number[] | DredgeRange<number>;" in source
    assert "published?: string | string[] | DredgeRange<string>;" in source
    assert "export type DredgeWorkerRequest" in source
    assert "image?: string;" in source
    assert '"SCHEMA_VERSION_MISMATCH"' in source
    assert '"FILTER_INVALID"' in source
    assert '"QUERY_INVALID"' in source
    assert "export type DredgeWorkerResponse" in source
    assert "pendingSearch" in source
    assert "STALE_RESPONSE" in source
    assert 'const DEFAULT_WORKER_URL = "/search/dredge-worker.abc123.js";' in source


def test_generated_client_matches_golden(tmp_path: Path) -> None:
    config_path, _ = _write_fixture_project(
        tmp_path, client={"out": str(tmp_path / "dredge-client.ts")}
    )
    config = load_config(config_path)

    source = generate_client_source(config)

    golden_path = Path(__file__).parent / "fixtures" / "generated-client.golden.ts"
    expected = golden_path.read_text(encoding="utf-8")
    assert source == expected, (
        "generated client drifted from the golden file. If this change is "
        "intended, regenerate tests/fixtures/generated-client.golden.ts."
    )


def test_compile_installs_runtime_assets(tmp_path: Path) -> None:
    config_path, output_dir = _write_fixture_project(tmp_path)

    result = compile_site(config_path)

    worker = output_dir / "dredge-worker.js"
    assert worker in result.asset_paths
    assert (output_dir / "dredge-client.js").exists()
    assert any(path.suffix == ".wasm" for path in result.asset_paths)
    assert not (output_dir / "dredge-worker.js.br").exists()


def test_compile_precompresses_runtime_assets_on_request(tmp_path: Path) -> None:
    config_path, output_dir = _write_fixture_project(tmp_path)

    compile_site(config_path, precompress_assets=True)

    worker = (output_dir / "dredge-worker.js").read_bytes()
    # The bytes stored in the package are reused verbatim as the .br sidecar, so
    # it must decompress back to exactly the file served to clients without one.
    assert (
        brotli.decompress((output_dir / "dredge-worker.js.br").read_bytes()) == worker
    )
    assert gzip.decompress((output_dir / "dredge-worker.js.gz").read_bytes()) == worker


def test_install_retires_superseded_runtime_assets(tmp_path: Path) -> None:
    config_path, output_dir = _write_fixture_project(tmp_path)
    result = compile_site(config_path, precompress_assets=True)

    # A previous version's content-hashed payload, and its sidecars.
    stale = output_dir / "dredge-sqlite3-0old0hash.wasm"
    for path in (
        stale,
        output_dir / f"{stale.name}.br",
        output_dir / f"{stale.name}.gz",
    ):
        path.write_bytes(b"stale")
    unrelated = output_dir / "site-styles.css"
    unrelated.write_bytes(b"not ours")

    main(["install", "--config", str(config_path)])

    assert not stale.exists()
    assert not (output_dir / f"{stale.name}.br").exists()
    # Turning precompression back off retires the sidecars from the earlier run.
    assert not (output_dir / "dredge-worker.js.br").exists()
    assert (output_dir / "dredge-worker.js").exists()
    # Neither the database artifacts nor anything the site owns is touched.
    assert result.compressed_db_path.exists()
    assert result.manifest_path.exists()
    assert unrelated.read_bytes() == b"not ours"


def test_compile_can_skip_runtime_assets(tmp_path: Path) -> None:
    config_path, output_dir = _write_fixture_project(tmp_path)

    result = compile_site(config_path, runtime_assets=False)

    assert result.asset_paths == ()
    assert not (output_dir / "dredge-worker.js").exists()


def test_vendored_assets_match_runtime_sources() -> None:
    # `pnpm run vendor` stamps the sources it built from; if the working tree has
    # moved on, the vendored assets in src/dredge/vendor/runtime are stale and
    # the wheel would ship a runtime that does not match this checkout.
    runtime = Path(__file__).parents[1] / "runtime"
    if not (runtime / "src").is_dir():
        pytest.skip("runtime workspace not present in this checkout")

    stamp = json.loads(
        (
            Path(__file__).parents[1] / "src" / "dredge" / "vendor" / "sources.json"
        ).read_text(encoding="utf-8")
    )
    digest = hashlib.sha256()
    for relative_path in stamp["inputs"]:
        content = hashlib.sha256((runtime / relative_path).read_bytes()).hexdigest()
        digest.update(f"{relative_path}\0{content}\n".encode())

    assert digest.hexdigest() == stamp["hash"], (
        "vendored runtime assets are stale for this checkout; "
        "re-run `pnpm run vendor` in runtime/."
    )


def test_vendored_client_template_matches_runtime_source() -> None:
    # The template is authored (and typechecked) in the runtime workspace and
    # vendored into the package; codegen only ever reads the vendored copy.
    source = Path(__file__).parents[1] / "runtime" / "src" / "client.template.ts"
    if not source.exists():
        pytest.skip("runtime workspace not present in this checkout")

    assert CLIENT_TEMPLATE_RESOURCE.read_text(encoding="utf-8") == source.read_text(
        encoding="utf-8"
    ), (
        "vendored client template drifted from runtime/src/client.template.ts; "
        "re-run `pnpm run vendor` in runtime/."
    )


def test_pagefind_compatible_attributes_extract_and_ignore_content(
    tmp_path: Path,
) -> None:
    source_dir = tmp_path / "site"
    output_dir = tmp_path / "search"
    source_dir.mkdir()
    (source_dir / "index.html").write_text(
        """
        <!doctype html>
        <html>
        <head>
          <title>Fallback Title</title>
          <meta name="description" content="Catalog description">
          <meta data-pagefind-meta="catalog_id[content]" content="abc-123">
          <meta data-pagefind-sort="title[content]" content="Pagefind Title">
        </head>
        <body>
          <h1 data-pagefind-body>Pagefind Title</h1>
          <p data-pagefind-body>Visible golden content.</p>
          <div data-pagefind-ignore>Ignored secret content.</div>
          <div aria-hidden="true"><span data-pagefind-filter="category">Objects</span></div>
        </body>
        </html>
        """,
        encoding="utf-8",
    )
    config_path = tmp_path / "dredge.config.json"
    config_path.write_text(
        json.dumps(
            {
                "source_dir": str(source_dir),
                "output_dir": str(output_dir),
                "selectors": {
                    "title": "h1[data-pagefind-body]",
                    "body": "body",
                    "description": "meta[name='description']@content",
                },
                "facets": {
                    "catalog_id": {
                        "type": "string",
                        "source": "meta[data-pagefind-meta='catalog_id[content]']@content",
                    },
                    "category": {
                        "type": "string",
                        "source": "[data-pagefind-filter='category']",
                    },
                    "sort_title": {
                        "type": "string",
                        "source": "meta[data-pagefind-sort='title[content]']@content",
                    },
                },
                "result_fields": [
                    "title",
                    "url",
                    "description",
                    "category",
                    "catalog_id",
                    "sort_title",
                ],
            }
        ),
        encoding="utf-8",
    )

    result = compile_site(config_path)

    connection = sqlite3.connect(result.db_path)
    try:
        assert connection.execute(
            "SELECT title, category, catalog_id, sort_title FROM documents"
        ).fetchone() == (
            "Pagefind Title",
            "Objects",
            "abc-123",
            "Pagefind Title",
        )
        assert connection.execute(
            "SELECT COUNT(*) FROM documents_fts WHERE documents_fts MATCH ?",
            ("golden",),
        ).fetchone() == (1,)
        assert connection.execute(
            "SELECT COUNT(*) FROM documents_fts WHERE documents_fts MATCH ?",
            ("secret",),
        ).fetchone() == (0,)
    finally:
        connection.close()


def test_codegen_cli_requires_client_output(tmp_path: Path) -> None:
    config_path, _ = _write_fixture_project(tmp_path)

    assert main(["codegen", "--config", str(config_path)]) == 1


def test_config_rejects_invalid_store_fields(tmp_path: Path) -> None:
    config_path, _ = _write_fixture_project(tmp_path)
    raw = json.loads(config_path.read_text(encoding="utf-8"))

    raw["store_fields"] = {"category": {"type": "string", "source": "data-image"}}
    config_path.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(BuildError) as error:
        load_config(config_path)
    assert error.value.code == "CONFIG_INVALID"
    assert "share field name" in str(error.value)

    raw["store_fields"] = {"gallery": {"type": "string_array", "source": "data-gallery"}}
    config_path.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(BuildError) as error:
        load_config(config_path)
    assert error.value.code == "CONFIG_INVALID"
    assert "store field 'gallery' has unsupported type" in str(error.value)

    raw["store_fields"] = {"image": {"type": "string", "source": "data-dredge-image"}}
    raw["composite_indices"] = [["category", "image"]]
    config_path.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(BuildError) as error:
        load_config(config_path)
    assert error.value.code == "CONFIG_INVALID"
    assert "composite index cannot include store field" in str(error.value)


def test_generated_client_typechecks_fixture_app_with_pnpm(tmp_path: Path) -> None:
    pnpm = shutil.which("pnpm")
    if pnpm is None:
        pytest.skip("pnpm is not installed")

    client_path = tmp_path / "dredge-client.ts"
    config_path, _ = _write_fixture_project(tmp_path, client={"out": str(client_path)})
    config = load_config(config_path)
    client_path.write_text(generate_client_source(config), encoding="utf-8")
    app_path = tmp_path / "fixture-app.ts"
    app_path.write_text(
        """
        import { DredgeSearchClient, type DredgeSearchRequest } from "./dredge-client";

        const client = new DredgeSearchClient({ workerUrl: "/search/dredge-worker.js" });
        const request: DredgeSearchRequest = {
          query: "golden",
          filters: {
            category: ["guide", "collection"],
            featured: false,
            published: { min: "2023-01-01", max: "2024-12-31" },
            rating: { min: 3, max: 5 },
            tags: "ancient",
            year: { min: 2023, max: 2024 },
          },
          includeFacets: ["category", "tags"],
        };

        async function runSearch() {
          const response = await client.search(request);
          const firstTitle: string | undefined = response.hits[0]?.title;
          const firstImage: string | undefined = response.hits[0]?.image;
          void firstImage;
          return firstTitle;
        }

        void runSearch();
        """,
        encoding="utf-8",
    )

    subprocess.run(
        [
            pnpm,
            "dlx",
            "--package",
            "typescript",
            "tsc",
            "--strict",
            "--target",
            "ES2020",
            "--lib",
            "ES2020,DOM",
            "--noEmit",
            str(app_path),
        ],
        check=True,
    )


def _write_variant_site(
    tmp_path: Path,
    *,
    variant_generation: bool | None = None,
    synonym_groups: list[list[str]] | None = None,
    suppressed_variants: list[list[str]] | None = None,
) -> tuple[Path, Path]:
    """Write a site whose prose carries the variant cases worth guarding.

    ``photograph``/``photographs``/``photographing`` share a porter stem;
    ``statue``/``status`` share one they should not; ``khufu``/``cheops`` share
    none and only pair through config.
    """

    source_dir = tmp_path / "site"
    output_dir = tmp_path / "search"
    source_dir.mkdir(parents=True)
    (source_dir / "index.html").write_text(
        """
        <!doctype html>
        <html>
          <head><title>Photographs of Khufu</title></head>
          <body>
            <main data-dredge-category="plates">
              <h1>Photographs of Khufu</h1>
              <p>A photograph of a statue, photographing its status, and
                 the name Cheops beside it.</p>
            </main>
          </body>
        </html>
        """,
        encoding="utf-8",
    )

    config: dict[str, object] = {
        "source_dir": str(source_dir),
        "output_dir": str(output_dir),
        "base_url": "/",
        "selectors": {"title": "title, h1", "body": "main"},
        "facets": {"category": {"type": "string", "source": "data-dredge-category"}},
        "result_fields": ["title", "url"],
    }
    if variant_generation is not None:
        config["variant_generation"] = variant_generation
    if synonym_groups is not None:
        config["synonym_groups"] = synonym_groups
    if suppressed_variants is not None:
        config["suppressed_variants"] = suppressed_variants
    config_path = tmp_path / "dredge.config.json"
    config_path.write_text(json.dumps(config, indent=2), encoding="utf-8")
    return config_path, output_dir


def _term_variants(db_path: Path) -> dict[str, list[str]]:
    connection = sqlite3.connect(f"file:{db_path}?mode=ro&immutable=1", uri=True)
    try:
        return {
            term: variants.split(" ")
            for term, variants in connection.execute(
                "SELECT term, variants FROM dredge_term_variants"
            )
        }
    finally:
        connection.close()


def test_term_variants_group_surface_forms_sharing_a_stem(tmp_path: Path) -> None:
    config_path, _ = _write_variant_site(tmp_path)

    result = compile_site(config_path)

    variants = _term_variants(result.db_path)
    assert set(variants["photograph"]) == {"photographing", "photographs"}
    assert set(variants["photographs"]) == {"photograph", "photographing"}
    # One row per surface form, not one per group: the Runtime looks up the word
    # the reader typed and never stems it.
    assert "photograp" not in variants
    # Single-form groups are not written.
    assert "cheops" not in variants


def test_declared_synonym_group_ships_without_a_shared_stem(tmp_path: Path) -> None:
    config_path, _ = _write_variant_site(
        tmp_path, synonym_groups=[["Khufu", "Cheops"]]
    )

    result = compile_site(config_path)

    variants = _term_variants(result.db_path)
    assert variants["khufu"] == ["cheops"]
    assert variants["cheops"] == ["khufu"]


def test_suppressed_pairing_breaks_a_generated_group_apart(tmp_path: Path) -> None:
    unsuppressed_path, _ = _write_variant_site(tmp_path / "unsuppressed")
    assert _term_variants(compile_site(unsuppressed_path).db_path)["statue"] == [
        "status"
    ]

    config_path, _ = _write_variant_site(
        tmp_path / "suppressed", suppressed_variants=[["statue", "status"]]
    )

    variants = _term_variants(compile_site(config_path).db_path)

    # A two-member group loses its only pairing, so neither form is written.
    assert "statue" not in variants
    assert "status" not in variants
    # Suppressing one pairing leaves the rest of the table alone.
    assert set(variants["photograph"]) == {"photographing", "photographs"}


def test_variant_generation_disabled_writes_no_rows(tmp_path: Path) -> None:
    config_path, _ = _write_variant_site(tmp_path, variant_generation=False)

    result = compile_site(config_path)

    assert _term_variants(result.db_path) == {}
    assert result.metrics["payload_report"]["term_variants"]["row_count"] == 0


def test_variant_generation_disabled_still_ships_declared_synonyms(
    tmp_path: Path,
) -> None:
    config_path, _ = _write_variant_site(
        tmp_path, variant_generation=False, synonym_groups=[["khufu", "cheops"]]
    )

    variants = _term_variants(compile_site(config_path).db_path)

    assert variants == {"cheops": ["khufu"], "khufu": ["cheops"]}


def test_compiled_artifact_stamps_the_current_schema_version(tmp_path: Path) -> None:
    config_path, _ = _write_variant_site(tmp_path)

    result = compile_site(config_path)

    connection = sqlite3.connect(f"file:{result.db_path}?mode=ro&immutable=1", uri=True)
    try:
        assert connection.execute("PRAGMA user_version").fetchone() == (
            compiler.DB_SCHEMA_VERSION,
        )
    finally:
        connection.close()
    assert result.manifest["db_schema_version"] == compiler.DB_SCHEMA_VERSION


def test_payload_report_carries_variant_table_cost(tmp_path: Path) -> None:
    config_path, _ = _write_variant_site(tmp_path)

    result = compile_site(config_path)

    stats = result.metrics["payload_report"]["term_variants"]
    assert stats["row_count"] == len(_term_variants(result.db_path))
    assert stats["row_count"] > 0
    assert stats["bytes"] > 0
    assert f"term variants: {stats['row_count']:,} rows" in compiler.format_payload_report(
        result.metrics["payload_report"]
    )


def test_variants_json_records_the_pairings_a_build_produced(tmp_path: Path) -> None:
    config_path, _ = _write_variant_site(tmp_path)
    variants_json_path = tmp_path / "variants.json"

    result = compile_site(config_path, variants_json_path=variants_json_path)

    audit = json.loads(variants_json_path.read_text(encoding="utf-8"))
    assert audit["terms"] == _term_variants(result.db_path)
    assert audit["row_count"] == len(audit["terms"])


def test_declared_variant_terms_must_be_single_words(tmp_path: Path) -> None:
    config_path, _ = _write_variant_site(
        tmp_path, synonym_groups=[["great pyramid", "khufu"]]
    )

    with pytest.raises(BuildError) as error:
        load_config(config_path)

    assert error.value.code == "CONFIG_INVALID"
    assert "single searchable word" in str(error.value)


def _write_multi_page_site(
    tmp_path: Path,
    *,
    page_count: int,
    missing_description_ids: frozenset[int] = frozenset(),
    missing_category_ids: frozenset[int] = frozenset(),
) -> tuple[Path, Path]:
    """Write a deterministic multi-page site for parallel-extraction tests.

    Pages live under sorted, shard-free paths so document ids track sorted URL
    order. ``missing_*`` ids omit a field to provoke a warning or build error on
    a specific (non-first) page.
    """

    source_dir = tmp_path / "site"
    output_dir = tmp_path / "search"
    (source_dir / "pages").mkdir(parents=True)
    for doc_id in range(page_count):
        category_attr = (
            "" if doc_id in missing_category_ids else "data-dredge-category='guide' "
        )
        description = (
            ""
            if doc_id in missing_description_ids
            else f'<meta name="description" content="Page {doc_id:04d} summary">'
        )
        (source_dir / "pages" / f"page-{doc_id:04d}.html").write_text(
            f"""
            <!doctype html>
            <html>
              <head>
                <title>Page {doc_id:04d}</title>
                {description}
              </head>
              <body>
                <main {category_attr}data-dredge-catalog='cat{doc_id:04d}'>
                  <h1>Page {doc_id:04d}</h1>
                  <p>Body text for searchable page number {doc_id}.</p>
                </main>
              </body>
            </html>
            """,
            encoding="utf-8",
        )

    config = {
        "source_dir": str(source_dir),
        "output_dir": str(output_dir),
        "base_url": "/",
        "include": ["**/*.html"],
        "exclude": [],
        "selectors": {
            "title": "title, h1",
            "body": "main",
            "description": "meta[name='description']@content",
        },
        "facets": {
            "category": {
                "type": "string",
                "source": "data-dredge-category",
                "required": True,
            },
        },
        "store_fields": {},
        "result_fields": ["title", "url", "description", "category"],
        "composite_indices": [],
        "search_fields": [{"source": "data-dredge-catalog"}],
    }
    config_path = tmp_path / "dredge.config.json"
    config_path.write_text(json.dumps(config, indent=2), encoding="utf-8")
    return config_path, output_dir


def _warning_signature(
    warnings: tuple[compiler.BuildWarning, ...],
) -> list[tuple[object, ...]]:
    return [
        (w.code, w.field, w.selector, w.message, w.count, tuple(w.sample_paths))
        for w in warnings
    ]


def test_parallel_and_serial_compiles_are_byte_identical(tmp_path: Path) -> None:
    # One site compiled twice: byte-identical output is the parallelism contract.
    config_path, _ = _write_multi_page_site(tmp_path, page_count=40)

    serial = compile_site(config_path, jobs=1)
    parallel = compile_site(config_path, jobs=4)

    assert parallel.page_count == serial.page_count == 40
    assert parallel.manifest["db_sha256"] == serial.manifest["db_sha256"]


def test_parallel_extraction_preserves_warning_buckets(tmp_path: Path) -> None:
    # Several non-first pages miss descriptions: one SELECTOR_MISS bucket whose
    # count and (capped) sample paths must match between serial and parallel.
    missing = frozenset({3, 7, 11, 19, 25})
    config_path, _ = _write_multi_page_site(
        tmp_path, page_count=30, missing_description_ids=missing
    )

    serial = compile_site(config_path, jobs=1)
    parallel = compile_site(config_path, jobs=4)

    description_warnings = [w for w in serial.warnings if w.field == "description"]
    assert len(description_warnings) == 1
    assert description_warnings[0].count == len(missing)
    # Sample paths honor the collector cap and appear in sorted-URL order.
    assert len(description_warnings[0].sample_paths) == 3
    assert _warning_signature(parallel.warnings) == _warning_signature(serial.warnings)


def test_build_error_propagates_from_extraction_worker(tmp_path: Path) -> None:
    # The missing-facet page is not the first candidate, so the failure comes
    # back from a worker process and must keep its code/path/field/selector.
    config_path, output_dir = _write_multi_page_site(
        tmp_path, page_count=12, missing_category_ids=frozenset({6})
    )

    with pytest.raises(BuildError) as error:
        compile_site(config_path, jobs=4)

    assert error.value.code == "FACET_REQUIRED_MISSING"
    assert error.value.path is not None
    assert error.value.path.name == "page-0006.html"
    assert error.value.field == "category"
    assert error.value.selector == "data-dredge-category"
    assert not (output_dir / "search-manifest.json").exists()


def test_compile_rejects_jobs_below_one(tmp_path: Path) -> None:
    config_path, _ = _write_fixture_project(tmp_path)

    with pytest.raises(ValueError, match="jobs must be at least 1"):
        compile_site(config_path, jobs=0)


def test_cli_compile_accepts_jobs_flag(tmp_path: Path) -> None:
    config_path, output_dir = _write_fixture_project(tmp_path)

    assert main(["compile", "--config", str(config_path), "--jobs", "2"]) == 0
    assert (output_dir / "search-manifest.json").exists()


def _plan_uses_index(
    connection: sqlite3.Connection,
    sql: str,
    parameters: tuple[object, ...],
    index_name: str,
) -> bool:
    details = [
        str(row[3])
        for row in connection.execute(f"EXPLAIN QUERY PLAN {sql}", parameters)
    ]
    return any(
        "SEARCH" in detail.upper() and index_name in detail for detail in details
    )


def _write_fixture_project(
    tmp_path: Path,
    *,
    index_attrs: str | None = None,
    include_descriptions: bool = True,
    client: dict[str, str] | None = None,
    search_field: bool = True,
    search_fields: list[dict[str, str]] | None = None,
    search_weights: dict[str, float] | None = None,
    boosts: dict[str, Any] | None = None,
) -> tuple[Path, Path]:
    source_dir = tmp_path / "site"
    output_dir = tmp_path / "search"
    source_dir.mkdir()
    (source_dir / "collections" / "beta").mkdir(parents=True)

    attrs = index_attrs or (
        "data-dredge-category='guide' "
        "data-dredge-year='2024' "
        "data-dredge-rating='4.5' "
        "data-dredge-featured='yes' "
        "data-dredge-published='2024-01-30' "
        "data-dredge-image='/images/alpha.jpg' "
        "data-dredge-catalog='zeta9000'"
    )
    index_description = (
        '<meta name="description" content="Guide to alpha tombs">'
        if include_descriptions
        else ""
    )
    beta_description = (
        '<meta name="description" content="Collection page">'
        if include_descriptions
        else ""
    )
    (source_dir / "index.html").write_text(
        f"""
        <!doctype html>
        <html>
          <head>
            <title>Alpha Tombs</title>
            {index_description}
            <meta property="article:tag" content="ancient">
            <meta property="article:tag" content="burial">
          </head>
          <body>
            <main {attrs}>
              <h1>Alpha Tombs</h1>
              <p>A golden coffin appears in this searchable fixture.</p>
              <script>window.secret = 'not indexed';</script>
            </main>
          </body>
        </html>
        """,
        encoding="utf-8",
    )
    (source_dir / "collections" / "beta" / "index.html").write_text(
        f"""
        <!doctype html>
        <html>
          <head>
            <title>Beta Collection</title>
            {beta_description}
            <meta property="article:tag" content="archive">
          </head>
          <body>
            <main
              data-dredge-category="collection"
              data-dredge-year="2023"
              data-dredge-rating="3.25"
              data-dredge-featured="false"
              data-dredge-published="2023-11-02"
              data-dredge-image="/images/beta.jpg"
              data-dredge-catalog="qux5001"
            >
              <h1>Beta Collection</h1>
              <p>Catalog records and images.</p>
            </main>
          </body>
        </html>
        """,
        encoding="utf-8",
    )

    config = {
        "source_dir": str(source_dir),
        "output_dir": str(output_dir),
        "base_url": "/",
        "include": ["**/*.html"],
        "exclude": [],
        "selectors": {
            "title": "title, h1",
            "body": "main",
            "description": "meta[name='description']@content",
        },
        "facets": {
            "category": {
                "type": "string",
                "source": "data-dredge-category",
                "required": True,
            },
            "featured": {"type": "boolean", "source": "data-dredge-featured"},
            "published": {"type": "date", "source": "data-dredge-published"},
            "rating": {"type": "number", "source": "data-dredge-rating"},
            "tags": {
                "type": "string_array",
                "source": "meta[property='article:tag']@content",
            },
            "year": {"type": "integer", "source": "data-dredge-year"},
        },
        "store_fields": {
            "image": {"type": "string", "source": "data-dredge-image"},
        },
        "result_fields": ["title", "url", "description", "category", "year", "image"],
        "composite_indices": [["category", "year"]],
    }
    if search_field:
        config["search_fields"] = search_fields or [{"source": "data-dredge-catalog"}]
    if search_weights is not None:
        config["search_weights"] = search_weights
    if boosts is not None:
        config["boosts"] = boosts
    if client is not None:
        config["client"] = client
    config_path = tmp_path / "dredge.config.json"
    config_path.write_text(json.dumps(config, indent=2), encoding="utf-8")
    return config_path, output_dir
