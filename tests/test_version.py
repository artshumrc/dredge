import json
import re
import tomllib
from datetime import date
from pathlib import Path

import pytest

import changelog
import dredge
from dredge.compiler import DB_SCHEMA_VERSION, MANIFEST_VERSION

ROOT = Path(__file__).parents[1]


def _pyproject_version() -> str:
    data = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    return data["project"]["version"]


def test_package_version_matches_pyproject() -> None:
    # pyproject.toml is the only place a release version is written by hand; if
    # this fails after a bump, the editable install is stale (`uv sync`).
    assert dredge.__version__ == _pyproject_version()


def test_runtime_workspace_declares_no_version() -> None:
    # The browser workspace is private and never published to npm. A version
    # field there would be a second place to bump, so it must stay absent.
    manifest = json.loads((ROOT / "runtime" / "package.json").read_text(encoding="utf-8"))
    assert "version" not in manifest


def test_runtime_format_versions_match_compiler() -> None:
    # db.ts refuses a database whose format it does not know, so its constants
    # must track the ones the compiler stamps into the Manifest.
    db_ts = ROOT / "runtime" / "src" / "db.ts"
    if not db_ts.is_file():
        pytest.skip("runtime workspace not present in this checkout")

    source = db_ts.read_text(encoding="utf-8")
    declared = {
        name: int(found.group(1))
        for name in ("MANIFEST_VERSION", "DB_SCHEMA_VERSION")
        if (found := re.search(rf"^const {name} = (\d+);$", source, re.MULTILINE))
    }

    assert declared == {
        "MANIFEST_VERSION": MANIFEST_VERSION,
        "DB_SCHEMA_VERSION": DB_SCHEMA_VERSION,
    }, "runtime/src/db.ts disagrees with dredge.compiler; change both together."


def test_changelog_opens_with_a_populated_unreleased_section() -> None:
    # The release workflow reads these notes and retitles the section, so the
    # heading has to be there and it has to say something.
    assert changelog.unreleased_notes(changelog.CHANGELOG.read_text(encoding="utf-8"))


def test_changelog_released_sections_are_versioned_and_dated() -> None:
    _, sections = changelog.split_sections(changelog.CHANGELOG.read_text(encoding="utf-8"))
    for title, _body in sections[1:]:
        assert re.fullmatch(r"\d+\.\d+\.\d+ — \d{4}-\d{2}-\d{2}", title), title


def test_stamping_retitles_unreleased_and_reopens_it() -> None:
    stamped = changelog.stamp("## Unreleased\n\n- did a thing\n", "1.2.3", date(2026, 9, 3))

    assert stamped == "## Unreleased\n\n## 1.2.3 — 2026-09-03\n\n- did a thing\n"


def test_stamping_refuses_an_empty_unreleased_section() -> None:
    with pytest.raises(SystemExit):
        changelog.stamp(
            "## Unreleased\n\n## 1.0.0 — 2026-01-01\n\n- old\n",
            "1.1.0",
            date(2026, 9, 3),
        )
