"""The Anthropic Account card counts a Hermes login that lives only in the credential pool."""

from types import SimpleNamespace

from agent import anthropic_credentials
from agent import credential_pool
from hermes_cli import web_server_oauth


def _pool(*entries):
    return SimpleNamespace(entries=lambda: list(entries))


def _entry(source, token="sk-ant-oat01-abcdefghijklmnop"):
    return SimpleNamespace(auth_type="oauth", source=source, access_token=token, refresh_token="rt",
                           expires_at_ms=1, label=f"{source}-1")


def test_pool_only_hermes_login_reads_connected(monkeypatch):
    monkeypatch.setattr(anthropic_credentials, "read_hermes_oauth_credentials", lambda: None)
    monkeypatch.setattr(credential_pool, "load_pool", lambda provider: _pool(_entry("manual:hermes_pkce")))
    status = web_server_oauth._anthropic_oauth_status()
    assert status["logged_in"] is True
    assert status["source"] == "credential_pool"


def test_borrowed_claude_code_row_does_not_count(monkeypatch):
    monkeypatch.setattr(anthropic_credentials, "read_hermes_oauth_credentials", lambda: None)
    monkeypatch.setattr(credential_pool, "load_pool", lambda provider: _pool(_entry("claude_code")))
    for var in ("ANTHROPIC_API_KEY", "ANTHROPIC_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr("hermes_cli.config.get_env_value", lambda var: None)
    assert web_server_oauth._anthropic_oauth_status()["logged_in"] is False
