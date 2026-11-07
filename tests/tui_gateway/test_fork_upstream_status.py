"""fork.upstream_status: the newest vX.Y.0 feature release by tag date, and whether HEAD contains it."""
import os
import subprocess

import pytest

import tui_gateway.methods_fork_upstream as fork


def _git(cwd, *args):
    result = subprocess.run(["git", "-C", str(cwd), *args], check=False, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


@pytest.fixture
def checkout(tmp_path, monkeypatch):
    # The host's git config (commit signing, hooks) must not reach these throwaway repos.
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", os.devnull)
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    repo = tmp_path / "fork"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "benny")
    _git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base")
    _git(repo, "remote", "add", "upstream", str(tmp_path / "nowhere"))
    monkeypatch.setattr(fork, "_ROOT", repo)
    monkeypatch.setattr(fork, "_last_fetch", float("inf"))  # no background fetch in tests
    return repo


def _commit_tag(repo, tag, date):
    env = {**os.environ, "GIT_COMMITTER_DATE": date, "GIT_AUTHOR_DATE": date}
    subprocess.run(["git", "-C", str(repo), "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q",
                    "--allow-empty", "-m", tag], check=True, capture_output=True, env=env)
    subprocess.run(["git", "-C", str(repo), "-c", "user.email=t@t", "-c", "user.name=t", "tag", "-a", tag, "-m", tag],
                   check=True, capture_output=True, env=env)


def test_merged_release_reports_merged(checkout):
    _commit_tag(checkout, "v0.23.0", "2026-11-05T00:00:00")
    assert fork.upstream_status() == {"supported": True, "latest": "v0.23.0", "merged": True, "current": "v0.23.0"}


def test_newer_feature_release_is_unmerged_and_patches_date_tags_and_canaries_do_not_win(checkout):
    _commit_tag(checkout, "v0.23.0", "2026-11-05T00:00:00")
    _git(checkout, "checkout", "-q", "-b", "upstream-line")
    _commit_tag(checkout, "v2026.9.24", "2026-09-24T00:00:00")
    _commit_tag(checkout, "v0.24.0", "2026-11-09T00:00:00")
    _commit_tag(checkout, "v0.24.0+canary.20261110T000000Z", "2026-11-10T00:00:00")
    _commit_tag(checkout, "v0.24.1", "2026-11-11T00:00:00")  # a patch release never asks for a merge
    _git(checkout, "checkout", "-q", "benny")
    assert fork.upstream_status() == {"supported": True, "latest": "v0.24.0", "merged": False, "current": "v0.23.0"}


def test_without_upstream_remote_is_unsupported(checkout):
    _git(checkout, "remote", "remove", "upstream")
    assert fork.upstream_status() == {"supported": False}
