"""This fork's upstream (``methods_fork_upstream.py``): is the newest official release merged?"""

from __future__ import annotations

from .base import Params, Result
from .registry import method


class ForkUpstreamParams(Params):
    """``force`` starts a fresh fetch of upstream's release tags now instead of on the 6h cadence."""

    force: bool = False


class ForkUpstreamStatusResult(Result):
    """``supported`` is False when the checkout has no ``upstream`` remote. ``latest`` is the newest
    feature release tag (``vX.Y.0``) known locally, ``current`` the newest one HEAD contains."""

    supported: bool
    latest: str | None = None
    merged: bool | None = None
    current: str | None = None


method("fork.upstream_status", params=ForkUpstreamParams, result=ForkUpstreamStatusResult,
       doc="Whether the newest upstream Hermes release is merged into this fork's checkout.")
