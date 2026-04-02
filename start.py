"""
Launcher: Telegram + Max bots. При падении одного из процессов перезапускает оба
(через паузу). Под systemd: SIGTERM корректно останавливает лаунчер.

Run: python start.py
"""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import threading
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
MAX_BOT_DIR = os.path.join(ROOT, "max_bot")
MAX_DIST = os.path.join(MAX_BOT_DIR, "dist", "index.js")

# Пауза перед повторным стартом после падения (секунды)
RESTART_DELAY_SEC = max(3, int(os.environ.get("BOT_RESTART_DELAY", "8")))

_stop = threading.Event()


def _request_stop(_signum=None, _frame=None) -> None:
    _stop.set()


def _stream(proc: subprocess.Popen, label: str, color_code: str) -> None:
    reset = "\033[0m"
    prefix = f"{color_code}[{label}]{reset}"
    assert proc.stdout is not None
    for raw in iter(proc.stdout.readline, b""):
        line = raw.decode("utf-8", errors="replace").rstrip()
        print(f"{prefix} {line}", flush=True)


def build_max_bot() -> None:
    print("[LAUNCHER] Building Max bot (TypeScript → JavaScript)...")
    result = subprocess.run(
        ["npx", "tsc"],
        cwd=MAX_BOT_DIR,
        shell=sys.platform == "win32",
    )
    if result.returncode != 0:
        print("[LAUNCHER] TypeScript build failed. Run 'npm install' inside max_bot/ first.")
        sys.exit(1)
    print("[LAUNCHER] Build complete.")


def _terminate(proc: subprocess.Popen | None, name: str, timeout: float = 12.0) -> None:
    if proc is None or proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        print(f"[LAUNCHER] {name} did not exit, killing.", flush=True)
        proc.kill()
        proc.wait()


def _spawn_pair() -> tuple[subprocess.Popen, subprocess.Popen]:
    tg = subprocess.Popen(
        [sys.executable, "bot.py"],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    max_p = subprocess.Popen(
        ["node", MAX_DIST],
        cwd=MAX_BOT_DIR,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        shell=False,
    )
    return tg, max_p


def main() -> None:
    os.system("")  # ANSI on Windows

    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, _request_stop)
    signal.signal(signal.SIGINT, _request_stop)

    if not os.path.exists(MAX_DIST):
        build_max_bot()

    cy, gr = "\033[96m", "\033[92m"
    cycle = 0

    while not _stop.is_set():
        cycle += 1
        if cycle > 1:
            print(f"\n[LAUNCHER] Restarting both bots (cycle {cycle}) after {RESTART_DELAY_SEC}s…\n", flush=True)
            time.sleep(RESTART_DELAY_SEC)
            if _stop.is_set():
                break

        print("[LAUNCHER] Starting both bots… (Ctrl+C or SIGTERM to stop)\n", flush=True)

        tg_proc, max_proc = _spawn_pair()
        threads = [
            threading.Thread(target=_stream, args=(tg_proc, "TELEGRAM", cy), daemon=True),
            threading.Thread(target=_stream, args=(max_proc, "MAX     ", gr), daemon=True),
        ]
        for t in threads:
            t.start()

        try:
            while not _stop.is_set():
                if tg_proc.poll() is not None:
                    code = tg_proc.returncode
                    print(f"\n[LAUNCHER] Telegram bot exited (code {code}).", flush=True)
                    break
                if max_proc.poll() is not None:
                    code = max_proc.returncode
                    print(f"\n[LAUNCHER] Max bot exited (code {code}).", flush=True)
                    break
                threads[0].join(timeout=0.5)
        except KeyboardInterrupt:
            _request_stop()

        _terminate(max_proc, "Max")
        _terminate(tg_proc, "Telegram")
        try:
            tg_proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass
        try:
            max_proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass

        if _stop.is_set():
            print("[LAUNCHER] Stopped.", flush=True)
            break


if __name__ == "__main__":
    main()
