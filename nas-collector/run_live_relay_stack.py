#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
카카오골프예약 실시간 중계 스택(live_relay.py + cloudflared Quick Tunnel)을 상시 구동하는
감시자(supervisor). 둘 중 하나가 죽으면 각자 독립적으로 재시작하고, cloudflared가 (재)연결될
때마다 새로 발급되는 https://*.trycloudflare.com URL을 감지해서 Worker에 등록한다(고정 도메인이
없어 재시작마다 URL이 바뀌므로).

Synology DS-214는 Docker/systemd가 없어서, 이 스크립트 자체를 "부팅 시 실행" 작업 스케줄러에
등록해 상시 구동시킨다(README 참고). 표준 라이브러리만 사용.
"""

import json
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
CONFIG_PATH = SCRIPT_DIR / "config.json"
LOG_PATH = SCRIPT_DIR / "logs" / "run_live_relay_stack.log"
CLOUDFLARED_BIN = SCRIPT_DIR / "bin" / "cloudflared"

TUNNEL_URL_RE = re.compile(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com")
# Cloudflare가 기본 Python-urllib User-Agent를 봇으로 차단한다(error code 1010) - price_collector.py의
# send_to_ingest와 같은 이유로 register_url() 호출에도 반드시 필요하다(실제로 이거 빠뜨려서 첫
# 등록 시도가 403으로 실패했었다).
UA = "Mozilla/5.0 (compatible; JDGolfPriceCollector/1.0)"

_last_registered_url = None
_lock = threading.Lock()


def log(message):
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    line = f"[{datetime.now().isoformat(timespec='seconds')}] {message}"
    print(line, flush=True)
    with LOG_PATH.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def load_config():
    with CONFIG_PATH.open("r", encoding="utf-8") as f:
        cfg = json.load(f)
    for key in ("ingest_secret", "relay_secret", "register_url"):
        if not cfg.get(key):
            raise SystemExit(f"config.json에 {key}가 없습니다.")
    cfg.setdefault("relay_port", 8787)
    return cfg


def register_url(cfg, tunnel_url):
    global _last_registered_url
    with _lock:
        if tunnel_url == _last_registered_url:
            return
        payload = json.dumps({"url": tunnel_url}).encode("utf-8")
        req = urllib.request.Request(
            cfg["register_url"],
            data=payload,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "X-Ingest-Secret": cfg["ingest_secret"],
                "User-Agent": UA,
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as res:
                res.read()
            _last_registered_url = tunnel_url
            log(f"터널 URL 등록 성공: {tunnel_url}")
        except Exception as e:  # noqa: BLE001
            log(f"터널 URL 등록 실패({tunnel_url}): {e}")


def run_forever(name, build_cmd, on_line=None, restart_delay=5):
    """서브프로세스를 계속 재시작하며 돌린다. on_line(line)이 주어지면 stdout/stderr 각 줄마다 호출."""
    while True:
        log(f"{name} 시작: {' '.join(build_cmd)}")
        try:
            proc = subprocess.Popen(
                build_cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                cwd=str(SCRIPT_DIR),
            )
            for line in proc.stdout:
                line = line.rstrip("\n")
                if on_line:
                    on_line(line)
            proc.wait()
            log(f"{name} 종료(code={proc.returncode}) - {restart_delay}초 뒤 재시작")
        except Exception as e:  # noqa: BLE001
            log(f"{name} 실행 실패: {e}")
        time.sleep(restart_delay)


def main():
    cfg = load_config()
    if not CLOUDFLARED_BIN.exists():
        raise SystemExit(f"{CLOUDFLARED_BIN} 이 없습니다. README의 cloudflared 설치 단계를 먼저 진행하세요.")

    def on_cloudflared_line(line):
        log(f"cloudflared: {line}")
        m = TUNNEL_URL_RE.search(line)
        if m:
            register_url(cfg, m.group(0))

    relay_thread = threading.Thread(
        target=run_forever,
        args=("live_relay", [sys.executable, str(SCRIPT_DIR / "live_relay.py")]),
        daemon=True,
    )
    tunnel_thread = threading.Thread(
        target=run_forever,
        args=(
            "cloudflared",
            [
                str(CLOUDFLARED_BIN),
                "tunnel",
                "--no-autoupdate",
                "--url",
                f"http://127.0.0.1:{cfg['relay_port']}",
            ],
        ),
        kwargs={"on_line": on_cloudflared_line},
        daemon=True,
    )

    relay_thread.start()
    time.sleep(2)  # live_relay가 포트를 먼저 열어야 cloudflared 연결 즉시 성공
    tunnel_thread.start()

    relay_thread.join()
    tunnel_thread.join()


if __name__ == "__main__":
    main()
