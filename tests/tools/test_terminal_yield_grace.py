"""A yield request (a mid-turn user message) moves a foreground command to the background only after
``YIELD_GRACE_S``: a command that finishes within the grace returns its real result, a longer one is
handed over still running. Portable (no /proc): the handler is a probe, the test kills the process."""
import threading
import time

from tools import interrupt as interrupt_mod
from tools.environments import base as env_base
from tools.environments.local import LocalEnvironment


def _run_with_pending_yield(command: str):
    env = LocalEnvironment()
    handed = []

    def handler(proc, output_so_far):
        handed.append(proc)
        return {"output": output_so_far, "returncode": None, "yielded_session_id": "probe", "pid": proc.pid}

    tid = threading.get_ident()
    interrupt_mod.request_yield(tid)
    t0 = time.monotonic()
    try:
        result = env.execute(command, timeout=30, yield_handler=handler)
    finally:
        interrupt_mod.consume_yield(tid)
    return env, result, handed, time.monotonic() - t0


def test_a_quick_command_finishes_inside_the_grace_and_returns_its_real_result():
    env, result, handed, _ = _run_with_pending_yield("echo alpha; sleep 0.2; echo omega")
    try:
        assert not handed
        assert result["returncode"] == 0
        assert "omega" in result["output"]
    finally:
        env.cleanup()


def test_a_long_command_is_handed_over_alive_soon_after_the_grace():
    env, result, handed, elapsed = _run_with_pending_yield("echo started; sleep 30; echo done")
    try:
        assert handed, "the long command should have been yielded"
        assert result["yielded_session_id"] == "probe"
        assert env_base.YIELD_GRACE_S <= elapsed < env_base.YIELD_GRACE_S + 5
        assert handed[0].poll() is None, "yield must never kill the command"
    finally:
        for proc in handed:
            env._kill_process(proc)
        env.cleanup()
