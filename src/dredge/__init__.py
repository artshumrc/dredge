from importlib.metadata import PackageNotFoundError, version

try:
    __version__ = version("dredge")
except PackageNotFoundError:
    # Imported from a source tree with no install; only pyproject.toml knows.
    __version__ = "0.0.0+unknown"
