"""A subscription in a usage-limit cooldown is a working setup, not "inference unavailable"."""
from types import SimpleNamespace
from unittest.mock import patch

from hermes_cli.runtime_readiness import rate_limited_readiness

CONFIG = {"model": {"default": "gpt-6.1-sol", "provider": "openai-codex"}}


def _pool(statuses, available=False):
    return SimpleNamespace(
        entries=lambda: [SimpleNamespace(last_status=s) for s in statuses],
        has_available=lambda: available,
        next_available_at=lambda: 123.0,
    )


def test_exhausted_only_pool_reads_as_ready():
    with patch("agent.credential_pool.load_pool", return_value=_pool(["exhausted"])):
        verdict = rate_limited_readiness(CONFIG, "gpt-6.1-sol")
    assert verdict["ok"] is True
    assert verdict["provider"] == "openai-codex"
    assert verdict["source"] == "rate_limited"
    assert verdict["rate_limited_until"] == 123.0


def test_dead_or_missing_credentials_are_not_masked():
    for statuses in ([], ["dead"], ["exhausted", "dead"]):
        with patch("agent.credential_pool.load_pool", return_value=_pool(statuses)):
            assert rate_limited_readiness(CONFIG, "gpt-6.1-sol") is None


def test_no_pinned_provider_is_left_to_the_normal_check():
    assert rate_limited_readiness({"model": "gpt-6.1-sol"}, "gpt-6.1-sol") is None
