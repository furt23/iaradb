"""The ``workhouse`` command.

    workhouse init [DIR]                 create a workspace (workhouse.toml + notebooks/)
    workhouse serve [DIR] [--port N]     open Workhouse Studio on a workspace
"""

from __future__ import annotations

import argparse
import os
import shutil
import socket
import subprocess
import sys
import time
import webbrowser
from pathlib import Path

DEFAULT_PORT = 3870


def _studio_dir() -> Path | None:
    """The Studio web app: ``$WORKHOUSE_STUDIO_DIR`` or the source checkout's ``apps/web``."""
    env = os.environ.get("WORKHOUSE_STUDIO_DIR")
    candidates = [Path(env)] if env else []
    candidates.append(Path(__file__).resolve().parents[2] / "apps" / "web")
    return next((c for c in candidates if (c / "package.json").is_file()), None)


def _studio_command(app: Path, port: int, dev: bool) -> list[str]:
    standalone = app / ".next" / "standalone" / "apps" / "web" / "server.js"
    node = shutil.which("node")
    if not dev and standalone.is_file() and node:
        return [node, str(standalone)]
    pnpm = shutil.which("pnpm")
    if pnpm is None:
        raise SystemExit("Workhouse Studio needs Node.js and pnpm (https://pnpm.io/installation)")
    built = (app / ".next" / "BUILD_ID").is_file()
    mode = "start" if built and not dev else "dev"
    return [pnpm, "--dir", str(app), "exec", "next", mode, "--port", str(port)]


def _wait_for_port(port: int, timeout: float = 120) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return True
        time.sleep(0.25)
    return False


def serve(workspace: Path, port: int, dev: bool, browser: bool) -> int:
    from workhouse.workspaces import find_root

    root = find_root(workspace) or workspace.resolve()
    app = _studio_dir()
    if app is None:
        raise SystemExit("Workhouse Studio is not available: set WORKHOUSE_STUDIO_DIR to the apps/web directory")
    env = {
        **os.environ,
        "WORKHOUSE_WORKSPACE": str(root),
        "WORKHOUSE_PYTHON": sys.executable,
        "PORT": str(port),
    }
    cmd = _studio_command(app, port, dev)
    print(f"Workhouse Studio · workspace {root}")
    proc = subprocess.Popen(cmd, cwd=app, env=env)
    try:
        if _wait_for_port(port) and browser:
            url = f"http://localhost:{port}"
            print(f"Open {url}")
            webbrowser.open(url)
        return proc.wait()
    except KeyboardInterrupt:
        proc.terminate()
        try:
            return proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            return 1


TOML_TEMPLATE = """# Workhouse workspace: named datasets for notebooks and the SQL editor.
#
# [tables.events]
# path = "data/events"          # a file, a directory or a glob (relative to this file)
# format = "parquet"            # parquet | csv (default: from the extension)

[workspace]
name = "{name}"
"""


def init(directory: Path) -> int:
    directory.mkdir(parents=True, exist_ok=True)
    config = directory / "workhouse.toml"
    if config.exists():
        print(f"{config} already exists")
        return 1
    config.write_text(TOML_TEMPLATE.format(name=directory.resolve().name), encoding="utf-8")
    (directory / "notebooks").mkdir(exist_ok=True)
    (directory / "data").mkdir(exist_ok=True)
    gitignore = directory / ".gitignore"
    if not gitignore.exists():
        gitignore.write_text(".workhouse/\nexports/\n", encoding="utf-8")
    print(f"Created a workspace in {directory.resolve()}: add tables to workhouse.toml, then run `workhouse serve`")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="workhouse", description="Workhouse engine tools")
    sub = ap.add_subparsers(dest="command", required=True)
    p_init = sub.add_parser("init", help="create a workspace")
    p_init.add_argument("directory", nargs="?", default=".", type=Path)
    p_serve = sub.add_parser("serve", help="open Workhouse Studio on a workspace")
    p_serve.add_argument("workspace", nargs="?", default=".", type=Path)
    p_serve.add_argument("--port", type=int, default=DEFAULT_PORT)
    p_serve.add_argument("--dev", action="store_true", help="run the web app in development mode")
    p_serve.add_argument("--no-browser", action="store_true", help="do not open a browser")
    args = ap.parse_args(argv)
    if args.command == "init":
        return init(args.directory)
    return serve(args.workspace, args.port, args.dev, not args.no_browser)


if __name__ == "__main__":
    sys.exit(main())
