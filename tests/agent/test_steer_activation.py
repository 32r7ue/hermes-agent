"""A mid-turn steer reaches the model right away, without killing running commands, and is never
accepted where no drain will deliver it.

- ``steer()`` during tool execution asks every tool worker to YIELD (a foreground terminal command
  moves to a tracked background process, a ``process_manage wait`` returns), like ``redirect()``.
- A steer that arrived while the model was answering makes the batch's new workers yield too.
- After the finalizer's last drain the turn refuses steers until the next turn starts: before, the
  gateway reported the late steer as delivered while it sat in a buffer nobody drained.
- A steer buffered before the turn's first tool batch is never spliced after an older turn's tool row.
"""
from __future__ import annotations

import threading

from agent.prompt_builder import STEER_MARKER_OPEN
from tools import interrupt as interrupt_mod

from tests.agent.test_steer import _bare_agent


def _agent_with_workers(*tids):
    agent = _bare_agent()
    agent._tool_worker_threads = set(tids)
    agent._tool_worker_threads_lock = threading.Lock()
    return agent


def _clear(*tids):
    for tid in tids:
        interrupt_mod.consume_yield(tid)


class TestSteerYieldsRunningTools:
    def test_steer_during_tool_execution_asks_every_worker_to_yield(self):
        agent = _agent_with_workers(910001, 910002)
        agent._executing_tools = True
        try:
            assert agent.steer("stop the build, wrong branch") is True
            assert agent._pending_steer == "stop the build, wrong branch"
            assert interrupt_mod.is_thread_yield_requested(910001)
            assert interrupt_mod.is_thread_yield_requested(910002)
            assert agent._interrupt_requested is False, "a steer never interrupts (nothing is killed)"
        finally:
            _clear(910001, 910002)

    def test_steer_outside_tool_execution_requests_no_yield(self):
        agent = _agent_with_workers(910003)
        try:
            assert agent.steer("note") is True
            assert not interrupt_mod.is_thread_yield_requested(910003)
        finally:
            _clear(910003)

    def test_redirect_during_tools_still_yields(self):
        agent = _agent_with_workers(910004)
        agent._executing_tools = True
        try:
            assert agent.redirect("actually do X") is True
            assert agent._pending_steer == "actually do X"
            assert interrupt_mod.is_thread_yield_requested(910004)
        finally:
            _clear(910004)

    def test_a_worker_starting_with_a_steer_pending_yields_and_leaves_no_stale_bit(self):
        from agent.tool_executor import _registered_tool_worker

        agent = _agent_with_workers()
        agent.steer("arrived while the model was answering")
        seen = {}

        def worker():
            with _registered_tool_worker(agent) as tid:
                seen["tid"] = tid
                seen["requested"] = interrupt_mod.is_thread_yield_requested(tid)
            seen["after"] = interrupt_mod.is_thread_yield_requested(tid)

        t = threading.Thread(target=worker)
        t.start()
        t.join(5)
        assert seen["requested"] is True
        assert seen["after"] is False, "an unconsumed yield must not survive onto a recycled tid"

    def test_a_worker_with_no_steer_pending_is_left_alone(self):
        from agent.tool_executor import _registered_tool_worker

        agent = _agent_with_workers()
        seen = {}

        def worker():
            with _registered_tool_worker(agent) as tid:
                seen["requested"] = interrupt_mod.is_thread_yield_requested(tid)

        t = threading.Thread(target=worker)
        t.start()
        t.join(5)
        assert seen["requested"] is False


class TestSteerWindow:
    def test_steer_after_the_last_drain_is_refused_until_the_next_turn(self):
        """Part A: a steer landing after the finalizer's leftover drain (the turn still reads
        ``running`` while it persists/emits) used to return True and sit undrained — the desktop
        showed it sent and the agent never saw it. Refused, the gateway answers ``rejected`` and the
        composer queues the words as the next prompt."""
        agent = _bare_agent()
        assert agent._drain_leftover_steer() is None
        assert agent.steer("are you done?") is False
        assert agent._pending_steer is None
        agent._open_steer_window()
        assert agent.steer("are you done?") is True

    def test_ticketed_steers_buffered_at_the_last_drain_stay_withdrawable(self):
        agent = _bare_agent()
        agent.steer("queued prompt", ticket="t")
        agent._drain_leftover_steer()
        assert agent.steer("late", ticket="u") is False
        assert agent.withdraw_steer("t") is True
        assert agent.withdraw_steer("u") is False

    def test_run_conversation_reopens_the_window(self, monkeypatch):
        from agent import conversation_loop

        agent = _bare_agent()
        agent._drain_leftover_steer()
        monkeypatch.setattr(conversation_loop, "_run_conversation_turn",
                            lambda agent, *a, **k: (agent.steer("mid-turn"), {"final_response": "ok"})[1])
        monkeypatch.setattr("agent.turn_finalizer.settle_held_final", lambda *a, **k: None)
        monkeypatch.setattr("agent.turn_context.export_current_turn_boundary", lambda agent, r, m: r)
        monkeypatch.setattr(conversation_loop, "_close_durable_failed_turn", lambda *a, **k: None)
        conversation_loop.run_conversation(agent, "hi")
        assert agent._pending_steer == "mid-turn"


def test_gateway_adoption_reopens_a_cached_agents_window_before_replaying_latched_steers():
    """The gateway latches steers sent before the turn adopts its (possibly cached) agent and
    replays them at adoption, before run_conversation: they must not hit the previous turn's
    closed window and vanish."""
    import types as _types

    from gateway.session_authority import SessionAuthority

    agent = _bare_agent()
    agent._drain_leftover_steer()  # the cached agent's previous turn ended
    fake = _types.SimpleNamespace(
        sessions={}, adopted={}, delivered_stops={}, pending_stops={},
        pending_steers={"s1": (7, ["sent before adoption"])})
    SessionAuthority.adopt_agent(fake, "s1", 7, agent)
    assert agent._pending_steer == "sent before adoption"


class TestPreApiInjectStaysInTheCurrentTurn:
    def _history(self):
        old_tool = {"role": "tool", "content": "old output", "tool_call_id": "old"}
        return [
            {"role": "user", "content": "earlier task"},
            {"role": "assistant", "content": "", "tool_calls": [
                {"id": "old", "function": {"name": "terminal", "arguments": "{}"}}]},
            old_tool,
            {"role": "assistant", "content": "done"},
            {"role": "user", "content": "new task"},
        ]

    def test_no_tool_row_in_this_turn_requeues_instead_of_splicing_into_history(self):
        from agent.turn_iteration_prep import _inject_steer_after_newest_tool_result

        agent = _bare_agent()
        messages = self._history()
        before = [dict(m) for m in messages]
        agent.steer("also check the logs")
        _inject_steer_after_newest_tool_result(agent, messages, agent._drain_pending_steer(), 4)
        assert messages == before
        assert agent._pending_steer == "also check the logs"

    def test_a_tool_row_of_this_turn_takes_the_steer(self):
        from agent.turn_iteration_prep import _inject_steer_after_newest_tool_result

        agent = _bare_agent()
        messages = self._history() + [
            {"role": "assistant", "content": "", "tool_calls": [
                {"id": "new", "function": {"name": "terminal", "arguments": "{}"}}]},
            {"role": "tool", "content": "new output", "tool_call_id": "new"},
        ]
        agent.steer("also check the logs")
        _inject_steer_after_newest_tool_result(agent, messages, agent._drain_pending_steer(), 4)
        assert messages[-1]["role"] == "user" and STEER_MARKER_OPEN in messages[-1]["content"]
        assert messages[-2]["tool_call_id"] == "new"


def test_terminal_yield_note_names_the_real_tool():
    from tools.terminal_tool_background import _YIELDED_NOTE

    assert "process_manage(action='kill'" in _YIELDED_NOTE
    assert "process(" not in _YIELDED_NOTE.replace("process_manage(", "")
