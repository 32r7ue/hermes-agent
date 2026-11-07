"""Desktop queued rows keep Edit/Steer: a ``local`` relabel and the clarify-card flag are not turn content."""
import contextlib
import sqlite3
from types import SimpleNamespace

from gateway.session_queued_controls import queued_controls


def _authority(source, created_source):
    conn = sqlite3.connect(':memory:')
    conn.execute('CREATE TABLE sessions (id TEXT, source TEXT, created_source TEXT)')
    conn.execute('INSERT INTO sessions VALUES (?, ?, ?)', ('s1', source, created_source))
    db = SimpleNamespace(_read_ctx=lambda: contextlib.nullcontext(conn))
    return SimpleNamespace(db=db, launch_sources={})


def _row(**payload):
    return {'status': 'queued', 'target_session_id': 's1', 'payload': {'text': 'hi', **payload}}


def test_desktop_row_relabelled_local_with_clarify_flag_is_editable():
    row = _row(cli_turn_v1={'clarify_batch': True})
    assert queued_controls(_authority('local', 'desktop'), row) == ['steer', 'replace']


def test_cli_turn_with_real_content_stays_locked():
    row = _row(cli_turn_v1={'clarify_batch': True, 'api_text': 'x'})
    assert queued_controls(_authority('local', 'desktop'), row) == []


def test_local_row_from_a_bot_surface_stays_locked():
    assert queued_controls(_authority('local', 'cron'), _row()) == []
