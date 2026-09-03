"""Read and stamp CHANGELOG.md.

The release workflow pulls a version's notes from here and retitles the
Unreleased section when it cuts a tag; tests assert the file still has the
shape both of those steps assume.
"""

import re
import sys
from datetime import date
from pathlib import Path

CHANGELOG = Path(__file__).parents[1] / "CHANGELOG.md"
UNRELEASED = "Unreleased"

_HEADING = re.compile(r"^## (.+)$", re.MULTILINE)


def split_sections(text: str) -> tuple[str, list[tuple[str, str]]]:
    """The preamble, then each `## ` section as (title, body) in file order."""
    headings = list(_HEADING.finditer(text))
    if not headings:
        return text, []
    sections = []
    for index, heading in enumerate(headings):
        after = headings[index + 1].start() if index + 1 < len(headings) else len(text)
        sections.append((heading.group(1).strip(), text[heading.end() : after].strip("\n")))
    return text[: headings[0].start()], sections


def unreleased_notes(text: str) -> str:
    preamble, sections = split_sections(text)
    if not sections or sections[0][0] != UNRELEASED:
        raise SystemExit(f"CHANGELOG.md must open with a '## {UNRELEASED}' section")
    notes = sections[0][1].strip()
    if not notes:
        raise SystemExit(f"the '## {UNRELEASED}' section is empty; nothing to release")
    return notes


def stamp(text: str, version: str, today: date) -> str:
    """Retitle Unreleased as `version` and open a fresh Unreleased above it."""
    unreleased_notes(text)
    return text.replace(
        f"## {UNRELEASED}",
        f"## {UNRELEASED}\n\n## {version} — {today.isoformat()}",
        1,
    )


def main(argv: list[str]) -> None:
    match argv:
        case ["notes"]:
            print(unreleased_notes(CHANGELOG.read_text(encoding="utf-8")))
        case ["stamp", version]:
            text = CHANGELOG.read_text(encoding="utf-8")
            CHANGELOG.write_text(stamp(text, version, date.today()), encoding="utf-8")
        case _:
            raise SystemExit("usage: changelog.py (notes | stamp <version>)")


if __name__ == "__main__":
    main(sys.argv[1:])
