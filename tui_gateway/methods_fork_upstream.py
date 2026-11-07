"""``fork.upstream_status``: is the newest upstream release merged into this fork's checkout?

This install runs a personal fork (remote ``upstream`` = the official repo, fetch-only). The stock
updater would pull over the fork's own changes, so the desktop instead offers to hand the merge to
an agent. This only reports: the newest ``vX.Y.Z`` tag on ``upstream`` and whether HEAD contains it.
The fetch runs in a background thread (throttled); a call answers from the last local view at once.

Bodies are rebound onto server.py's globals (method_ctx.bind_module) and reference them bare.
"""

from __future__ import annotations

import re
import subprocess
import threading
import time
from pathlib import Path

from .method_ctx import HandlerRegistry, bind_module

_registry = HandlerRegistry()
method = _registry.method

_ROOT = Path(__file__).resolve().parents[1]
# Feature releases only (v0.23.0 "Hearth"): patch releases (v0.22.7) come every day or two and are not worth a merge.
_RELEASE = re.compile(r"^v\d+\.\d+\.0$")
_FETCH_EVERY_S = 6 * 3600
_fetch_lock = threading.Lock()
_last_fetch = 0.0


def _git(*args: str, timeout: float = 15) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(_ROOT), *args], check=False, capture_output=True, text=True, timeout=timeout)


def _fetch_upstream_tags() -> None:
    global _last_fetch
    if not _fetch_lock.acquire(blocking=False):
        return
    try:
        _git("fetch", "--quiet", "upstream", "+refs/tags/v*:refs/tags/v*", timeout=120)
        _last_fetch = time.monotonic()
    except (OSError, subprocess.SubprocessError):
        pass
    finally:
        _fetch_lock.release()


def upstream_status(force: bool = False) -> dict:
    """``{supported, latest, merged, current}`` over feature releases (``vX.Y.0``); ``supported`` is False without an ``upstream`` remote."""
    if _git("remote", "get-url", "upstream").returncode != 0:
        return {"supported": False}
    if force or time.monotonic() - _last_fetch > _FETCH_EVERY_S:
        threading.Thread(target=_fetch_upstream_tags, name="fork-upstream-fetch", daemon=True).start()
    # Newest by tag date: upstream also carries old date-style tags (v2026.9.24) that sort above v0.x by version.
    listed = _git("for-each-ref", "--sort=-creatordate", "--format=%(refname:short)", "refs/tags/v*").stdout.split()
    tags = [t for t in listed if _RELEASE.match(t)]
    if not tags:
        return {"supported": True, "latest": None, "merged": True, "current": None}
    latest = tags[0]
    merged = _git("merge-base", "--is-ancestor", latest, "HEAD").returncode == 0
    current = next((t for t in tags if _git("merge-base", "--is-ancestor", t, "HEAD").returncode == 0), None)
    return {"supported": True, "latest": latest, "merged": merged, "current": current}


@method("fork.upstream_status")
def _(rid, params: dict) -> dict:
    return _ok(rid, upstream_status(force=bool(params.get("force"))))


def register(server) -> None:
    bind_module(globals(), server, skip=("_",))
