"""
Launcher: starts Telegram bot and Max bot simultaneously.
Run with: python start.py
Press Ctrl+C to stop both.
"""
import subprocess
import sys
import threading
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
MAX_BOT_DIR = os.path.join(ROOT, "max_bot")
MAX_DIST = os.path.join(MAX_BOT_DIR, "dist", "index.js")


def _stream(proc: subprocess.Popen, label: str, color_code: str) -> None:
    """Print lines from a process, prefixed with a colored label."""
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
        shell=True,
    )
    if result.returncode != 0:
        print("[LAUNCHER] TypeScript build failed. Run 'npm install' inside max_bot/ first.")
        sys.exit(1)
    print("[LAUNCHER] Build complete.")


def main() -> None:
    # Enable ANSI colors on Windows
    os.system("")

    # Auto-build Max bot if dist is missing
    if not os.path.exists(MAX_DIST):
        build_max_bot()

    print("[LAUNCHER] Starting both bots… Press Ctrl+C to stop.\n")

    tg_proc = subprocess.Popen(
        [sys.executable, "bot.py"],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )

    max_proc = subprocess.Popen(
        ["node", MAX_DIST],
        cwd=MAX_BOT_DIR,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        shell=False,
    )

    # Stream output from both processes with colored labels
    CYAN = "\033[96m"
    GREEN = "\033[92m"

    threads = [
        threading.Thread(target=_stream, args=(tg_proc, "TELEGRAM", CYAN), daemon=True),
        threading.Thread(target=_stream, args=(max_proc, "MAX     ", GREEN), daemon=True),
    ]
    for t in threads:
        t.start()

    try:
        # Exit if either process dies unexpectedly
        while True:
            if tg_proc.poll() is not None:
                print("\n[LAUNCHER] Telegram bot stopped unexpectedly.")
                max_proc.terminate()
                break
            if max_proc.poll() is not None:
                print("\n[LAUNCHER] Max bot stopped unexpectedly.")
                tg_proc.terminate()
                break
            threads[0].join(timeout=1)
    except KeyboardInterrupt:
        print("\n[LAUNCHER] Stopping both bots…")
        tg_proc.terminate()
        max_proc.terminate()

    tg_proc.wait()
    max_proc.wait()
    print("[LAUNCHER] Both bots stopped.")


if __name__ == "__main__":
    main()
