from __future__ import annotations

import argparse
import logging
import threading
from pathlib import Path

import uvicorn

from .app import create_app
from .config import load_config
from .wiring import build


def main() -> None:
    parser = argparse.ArgumentParser(prog="vastcomfy_agent")
    parser.add_argument("--env-file", type=Path, required=True)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO)
    cfg = load_config(args.env_file, "instance")
    wired = build(cfg)
    stop = threading.Event()
    threading.Thread(
        target=wired.runner.run_forever, args=(stop, cfg.comfy_poll_s), name="runner", daemon=True
    ).start()
    try:
        uvicorn.run(create_app(wired.deps), host=cfg.agent_host, port=cfg.agent_port, log_level="info")
    finally:
        stop.set()


if __name__ == "__main__":
    main()
