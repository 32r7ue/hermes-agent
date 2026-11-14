"""session_search after a rollover: the stored record is reachable and comes back bounded."""

import json

import pytest

from hermes_state import SessionDB
from tools.session_search_tool import session_search


@pytest.fixture
def db(tmp_path):
    return SessionDB(db_path=tmp_path / "state.db")


def test_read_of_a_session_rolled_over_in_place_returns_its_archived_history(db):
    """A one-shot rollover keeps the session id and archives the old rows (active=0, compacted=1).
    The read shape returned only the live rows, so the model never saw an id to scroll from and
    guessed around_message_id=1 (2026-11-14 live runs)."""
    db.create_session("s1", source="oneshot")
    first = db.append_message("s1", role="user", content="print a hex and remember it")
    db.append_message("s1", role="tool", content="1ef4a52152279c04", tool_name="terminal")
    db.append_message("s1", role="user", content="[CONTEXT SUMMARY]: You are continuing session s1.")
    with db._lock:
        db._conn.execute("UPDATE messages SET active=0, compacted=1 WHERE id <= ?", (first + 1,))
        db._conn.commit()

    result = json.loads(session_search(session_id="s1", db=db))

    ids = [m["id"] for m in result["messages"]]
    assert first in ids
    assert any("1ef4a52152279c04" in (m.get("content") or "") for m in result["messages"])


def test_scroll_bounds_a_huge_row_and_pages_through_the_anchor(db):
    db.create_session("s2", source="cli")
    db.append_message("s2", role="user", content="read the big file")
    big = db.append_message("s2", role="tool", content="".join(f"{i:07d}\n" for i in range(30_000)),
                            tool_name="read_file")
    after = db.append_message("s2", role="assistant", content="done")
    total = 30_000 * 8

    around_neighbour = json.loads(session_search(session_id="s2", around_message_id=after, db=db))
    neighbour = next(m for m in around_neighbour["messages"] if m["id"] == big)
    assert neighbour["content_truncated"] and neighbour["original_content_chars"] == total
    assert len(json.dumps(around_neighbour)) < 10_000

    page = json.loads(session_search(session_id="s2", around_message_id=big, db=db))
    anchor = next(m for m in page["messages"] if m["id"] == big)
    assert len(anchor["content"]) <= 8_000 and anchor["next_offset"] == len(anchor["content"])

    nxt = json.loads(session_search(session_id="s2", around_message_id=big, offset=anchor["next_offset"], db=db))
    anchor2 = next(m for m in nxt["messages"] if m["id"] == big)
    assert anchor2["content_offset"] == anchor["next_offset"]
    assert anchor2["content"].startswith(f"{anchor['next_offset'] // 8:07d}")
