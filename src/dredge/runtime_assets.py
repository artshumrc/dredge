"""Installation of the vendored browser runtime (worker, client, wasm payloads).

The assets ship inside the package brotli-compressed; installing decompresses
them into a site's search directory. Sidecars are opt-in: most static hosts
(GitHub Pages, Netlify, Cloudflare) compress on the fly and ignore them, so they
are only worth their bytes on a host configured to serve them from disk
(nginx ``brotli_static``/``gzip_static``, Caddy ``precompressed``).
"""

from __future__ import annotations

import gzip
from importlib.resources import files
from importlib.resources.abc import Traversable
from pathlib import Path

import brotli

from .compiler import BuildError

GZIP_LEVEL = 9

# Every installed file is named `dredge-*` by the runtime build, which is what
# lets a reinstall retire the previous version's content-hashed files without
# touching the `search.*` database artifacts that share the directory.
ASSET_PREFIX = "dredge-"


def install_runtime_assets(
    dest: Path, *, precompress: bool = False
) -> tuple[Path, ...]:
    """Write the runtime assets into ``dest``, retiring any earlier version's.

    Returns the paths written.
    """
    dest.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for resource in _stored_assets():
        name = resource.name.removesuffix(".br")
        stored = resource.read_bytes()
        try:
            payload = brotli.decompress(stored)
        except brotli.error as error:
            raise BuildError(
                "RUNTIME_ASSET_CORRUPT",
                f"vendored runtime asset {resource.name} could not be decompressed:"
                f" {error}",
            ) from error
        written.append(_write(dest / name, payload))
        if precompress:
            written.append(_write(dest / f"{name}.br", stored))
            written.append(
                _write(dest / f"{name}.gz", gzip.compress(payload, GZIP_LEVEL, mtime=0))
            )
    _retire_superseded(dest, keep=set(written))
    return tuple(written)


def _retire_superseded(dest: Path, *, keep: set[Path]) -> None:
    """Delete `dredge-*` files this install did not write.

    Asset names are content-hashed, so an upgrade would otherwise leave the
    previous version's payloads behind forever; the same sweep clears stale
    sidecars when precompression is turned off.
    """
    for path in dest.glob(f"{ASSET_PREFIX}*"):
        if path in keep or not path.is_file():
            continue
        path.unlink(missing_ok=True)


def _stored_assets() -> tuple[Traversable, ...]:
    root = files(__package__).joinpath("vendor", "runtime")
    names = sorted(entry.name for entry in root.iterdir()) if root.is_dir() else []
    assets = tuple(root.joinpath(name) for name in names if name.endswith(".br"))
    if not assets:
        raise BuildError(
            "RUNTIME_ASSETS_MISSING",
            "this dredge installation ships no browser runtime assets; rebuild them"
            " with `pnpm run vendor` in runtime/",
        )
    return assets


def _write(path: Path, payload: bytes) -> Path:
    try:
        path.write_bytes(payload)
    except OSError as error:
        raise BuildError(
            "RUNTIME_ASSET_WRITE_FAILED",
            f"failed to write runtime asset {path}: {error}",
        ) from error
    return path
