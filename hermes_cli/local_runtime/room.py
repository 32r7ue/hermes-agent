"""Make room for local models: quit memory-heavy apps while one is loaded (macOS).

``local_runtime.free_apps`` lists app names (e.g. ``["Phonon", "Coast Local"]``). The moment
the managed router starts loading any model, those that are running are quit; the moment the
last model leaves memory, exactly those are reopened. Driven by the router's /models/sse
stream, so router-side autoloads, idle sweeps and child crashes count, not just our own
load/unload calls. Which apps we quit is persisted, so a Hermes crash reopens them at the
next runtime start instead of leaving them closed.
"""

from __future__ import annotations

from contextlib import suppress
import json
import logging
import os
import subprocess
import sys
import threading
import time

from hermes_cli.local_runtime.binaries import runtimes_root

logger = logging.getLogger(__name__)

_HOLDS_MEMORY = frozenset({"loaded", "loading", "sleeping", "ready"})
_QUIT_GRACE_S = 3
# Launch arguments that keep an app from putting a window up when reopened behind the user's back.
_BACKGROUND_ARGS = {"Phonon": ["--background"]}
_lock = threading.Lock()


def _state_path():
    return runtimes_root() / "freed-apps.json"


def _load_freed() -> list[str]:
    with suppress(OSError, ValueError):
        return list(json.loads(_state_path().read_text()))
    return []


def _save_freed(names: list[str]) -> None:
    path = _state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(names))
    tmp.replace(path)


def _app_tree(name: str) -> list:
    """The app's main process and every descendant (its model sidecars live there)."""
    import psutil

    marker = f"/{name}.app/Contents/MacOS/"
    roots = []
    for p in psutil.process_iter(["exe"]):
        if marker in (p.info.get("exe") or ""):
            roots.append(p)
    procs = list(roots)
    for root in roots:
        with suppress(psutil.Error):
            procs += root.children(recursive=True)
    return procs


def _quit(name: str) -> None:
    import psutil

    procs = _app_tree(name)
    asked = subprocess.run(["osascript", "-e", f'quit app "{name}"'], check=False, capture_output=True, timeout=30)
    # A refused quit (Coast answers "User canceled" at once) gets no grace period.
    _, alive = psutil.wait_procs(procs, timeout=_QUIT_GRACE_S if asked.returncode == 0 else 0)
    for p in alive:  # refused the quit or left helpers behind
        with suppress(psutil.Error):
            p.terminate()
    logger.info("free_apps: quit %s%s", name, f" ({len(alive)} terminated)" if alive else "")


def _reopen(name: str) -> None:
    """`open` hands the caller's environment to the app it launches. The gateway's (PYTHONPATH into
    Hermes's Python 3.14 site-packages, HERMES_*) broke Phonon's Python 3.12 sidecars, which died
    before printing a line. Launch the way Finder would: only the login basics."""
    env = {k: os.environ[k] for k in ("HOME", "USER", "LOGNAME", "LANG", "TMPDIR") if k in os.environ}
    env["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"
    args = _BACKGROUND_ARGS.get(name, [])
    subprocess.run(["open", "-g", "-a", name, *(["--args", *args] if args else [])], check=False,
                   capture_output=True, timeout=30, env=env)
    logger.info("free_apps: reopened %s", name)


def claim(apps: list[str]) -> None:
    """A model is (about to be) resident: quit the configured apps that are running."""
    if sys.platform != "darwin" or not apps:
        return
    with _lock:
        freed = _load_freed()
        for name in apps:
            if name in freed or not _app_tree(name):
                continue
            freed.append(name)
            _save_freed(freed)  # recorded before quitting: a crash mid-quit still reopens it
            with suppress(Exception):
                _quit(name)


def _memory_settled(timeout_s: float = 15) -> None:
    """Wait for macOS memory pressure to read normal again. The apps reload GPU-resident models
    (Phonon ~3 GB of Metal buffers); started under pressure, Phonon's speech sidecar was killed
    before it became ready."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        level = subprocess.run(["sysctl", "-n", "kern.memorystatus_vm_pressure_level"],
                               check=False, capture_output=True, text=True).stdout.strip()
        if level in ("", "1"):  # 1 = normal, 2 = warn, 4 = critical
            return
        time.sleep(0.5)


def _models_exited(sup, timeout_s: float = 30) -> None:
    """The router reports "unloaded" when it asks a model child to stop, about a second before
    that child has exited and handed its memory back: wait for the children themselves."""
    import psutil

    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            children = psutil.Process(sup.proc.pid).children(recursive=True)
        except (psutil.Error, AttributeError):
            return
        def holds_model(child) -> bool:
            try:
                return bool(set(child.cmdline()) & {"--model", "-m"})
            except psutil.Error:  # exited between the listing and the read
                return False

        if not any(holds_model(c) for c in children):
            return
        time.sleep(0.25)


def release() -> None:
    """No model resident: reopen exactly what claim() quit, once memory has settled."""
    if sys.platform != "darwin":
        return
    with _lock:
        freed = _load_freed()
        if not freed:
            return
        _memory_settled()
        _save_freed([])
        for name in freed:
            with suppress(Exception):
                _reopen(name)


def watch(sup, apps: list[str]) -> None:
    """Follow the supervisor's router for its lifetime; release() any leftovers first.

    A ``loading`` event is the only trigger to quit (weights are about to land); any other
    status change reopens once nothing holds memory. Both run off the stream thread so a slow
    quit never delays the next event."""
    release()
    if sys.platform != "darwin" or not apps:
        return
    claimed = threading.Event()

    def in_background(fn) -> None:
        threading.Thread(target=fn, daemon=True, name="local-runtime-free-apps-act").start()

    def on_loading() -> None:
        if not claimed.is_set():
            claimed.set()
            in_background(lambda: claim(apps))

    def on_settled() -> None:
        if not claimed.is_set():
            return
        with suppress(Exception):
            if not any(st in _HOLDS_MEMORY for st in sup.models(timeout_s=5).values()):
                claimed.clear()

                def settle_then_release() -> None:
                    _models_exited(sup)
                    if not claimed.is_set():  # a new load began meanwhile: keep the apps closed
                        release()

                in_background(settle_then_release)

    def loop() -> None:
        while not sup._stopping:
            try:
                with sup._open("/models/sse", timeout_s=None, json_type=False) as r:
                    on_settled()  # anything that changed while we were disconnected
                    for line in r:
                        if sup._stopping:
                            return
                        if not line.startswith(b"data:"):
                            continue
                        with suppress(ValueError, TypeError, AttributeError):
                            status = str((json.loads(line[5:]).get("data") or {}).get("status", ""))
                            if status == "loading":
                                on_loading()
                            elif status:
                                on_settled()
            except Exception as exc:
                logger.debug("free_apps: sse reconnecting: %s", exc)
            time.sleep(2)

    threading.Thread(target=loop, daemon=True, name="local-runtime-free-apps").start()
