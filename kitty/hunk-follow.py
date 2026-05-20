"""Kitty watcher that asks marked Hunk sessions to follow the active pane."""

from __future__ import annotations

import os
import shutil
import subprocess
import time
from typing import Any


_last_sync_at_by_window: dict[int, float] = {}


def _debounce_seconds() -> float:
    raw_value = os.environ.get("HUNK_KITTY_FOLLOW_DEBOUNCE_MS", "250")
    try:
        return max(0, int(raw_value)) / 1000
    except ValueError:
        return 0.25


def _hunk_binary() -> str | None:
    return os.environ.get("HUNK_BIN") or shutil.which("hunk")


def _sync(window_id: int) -> None:
    hunk = _hunk_binary()
    if not hunk:
        return

    args = [hunk, "kitty", "sync", "--window-id", str(window_id)]
    listen_on = os.environ.get("KITTY_LISTEN_ON")
    if listen_on:
        args.extend(["--to", listen_on])

    subprocess.Popen(
        args,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
    )


def on_focus_change(boss: Any, window: Any, data: dict[str, Any]) -> None:
    if not data.get("focused"):
        return

    window_id = int(window.id)
    now = time.monotonic()
    last_sync_at = _last_sync_at_by_window.get(window_id, 0)
    if now - last_sync_at < _debounce_seconds():
        return

    _last_sync_at_by_window[window_id] = now
    _sync(window_id)
