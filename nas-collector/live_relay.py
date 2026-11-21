#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
카카오골프예약(kakao.golf) 실시간 조회 중계 서버 - NAS에서 상시 구동.

배경: Cloudflare Worker(백엔드)가 카카오골프예약을 직접 호출하면 요청마다 Cloudflare의 공유 발신
IP를 쓰는데, 그중 일부가 카카오골프예약 WAF에 걸려있어 같은 요청도 무작위로 절반 가까이 403이
난다(2026-09 실측). 반면 이 NAS(price_collector.py가 매일 새벽 이미 쓰고 있는 주거용 IP)는
12일 넘게 카카오골프예약 호출 100건+ 에러 0건이었다 - 그래서 Worker의 실시간 조회 요청을
이 NAS를 거쳐 카카오골프예약에 대신 보내주는 중계 역할을 한다.

Worker <-> NAS 사이는 Cloudflare Tunnel로 연결한다(포트포워딩 불필요, NAS는 밖으로 나가는
연결만 만든다는 이 저장소의 기존 방침과 동일). 이 서버 자체는 로컬(127.0.0.1)에만 바인딩하고,
cloudflared가 그 앞에서 터널을 받아준다.

비즈니스 로직(요청 바디 구성, 응답 파싱, 골프장명 매칭 등)은 전부 백엔드 kakaogolf.js에 그대로
남겨둔다 - 이 서버는 "카카오골프예약 API 경로 + 바디를 받아서 그대로 중계"만 하는 얇은 프록시다
(로직을 파이썬/JS 양쪽에 중복해서 유지하는 걸 피하려는 의도 - golfCourseDB.js의 normalizeCourseName
주석과 같은 이유). path는 화이트리스트로 제한해서, 시크릿이 유출되더라도 임의 사이트로의
오픈 릴레이로 악용되지 않게 한다.

표준 라이브러리만 사용(price_collector.py와 같은 이유 - Synology DS-214는 Docker 불가).
"""

import json
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
CONFIG_PATH = SCRIPT_DIR / "config.json"
LOG_PATH = SCRIPT_DIR / "logs" / "live_relay.log"

KAKAOGOLF_BASE = "https://www.kakao.golf"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"

# kakaogolf.js가 실제로 쓰는 경로만 허용 - 시크릿 유출 시에도 임의 URL로 못 나가게 막는 안전장치.
ALLOWED_PATHS = {"/api/tee-time/search", "/api/tee-time/detail", "/api/golf/view"}

# 카카오골프예약이 짧은 시간에 요청이 몰리면 이 NAS의 IP를 일시 차단(403)하는 게 확인돼서(검색 한 번에
# 골프장 이름 조회가 수십 건 몰릴 때), 업스트림 호출을 한 줄로 세워서 최소 간격을 둔다.
MIN_INTERVAL_SECONDS = 0.7
_upstream_lock = threading.Lock()
_last_upstream_at = 0.0


def throttle():
    global _last_upstream_at
    with _upstream_lock:
        wait = MIN_INTERVAL_SECONDS - (time.monotonic() - _last_upstream_at)
        if wait > 0:
            time.sleep(wait)
        _last_upstream_at = time.monotonic()


def log(message):
    from datetime import datetime

    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    line = f"[{datetime.now().isoformat(timespec='seconds')}] {message}"
    print(line, flush=True)
    with LOG_PATH.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def load_config():
    if not CONFIG_PATH.exists():
        raise SystemExit(f"{CONFIG_PATH} 이 없습니다. relay_secret/relay_port를 채운 config.json이 필요합니다.")
    with CONFIG_PATH.open("r", encoding="utf-8") as f:
        cfg = json.load(f)
    if not cfg.get("relay_secret"):
        raise SystemExit("config.json에 relay_secret이 없습니다.")
    cfg.setdefault("relay_port", 8787)
    return cfg


CONFIG = load_config()


class RelayHandler(BaseHTTPRequestHandler):
    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # BaseHTTPRequestHandler 기본 stderr 로그를 파일로 통일
        log("http: " + (fmt % args))

    def do_GET(self):
        if self.path == "/healthz":
            self._send_json(200, {"ok": True})
            return
        self._send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/kakaogolf":
            self._send_json(404, {"error": "not found"})
            return

        if self.headers.get("X-Relay-Secret") != CONFIG["relay_secret"]:
            self._send_json(401, {"error": "unauthorized"})
            return

        length = int(self.headers.get("Content-Length") or 0)
        try:
            req = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._send_json(400, {"error": "invalid json"})
            return

        path = req.get("path")
        if path not in ALLOWED_PATHS:
            self._send_json(400, {"error": f"path not allowed: {path}"})
            return

        upstream_headers = {
            "Content-Type": "application/json",
            "Origin": KAKAOGOLF_BASE,
            "User-Agent": UA,
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
        }
        if req.get("referer"):
            upstream_headers["Referer"] = req["referer"]

        data = json.dumps(req.get("body") or {}).encode("utf-8")
        upstream_req = urllib.request.Request(
            f"{KAKAOGOLF_BASE}{path}", data=data, method="POST", headers=upstream_headers
        )
        throttle()
        try:
            with urllib.request.urlopen(upstream_req, timeout=15) as res:
                self._send_json(res.status, json.loads(res.read().decode("utf-8")))
        except urllib.error.HTTPError as e:
            log(f"upstream HTTPError {path}: {e.code}")
            self._send_json(e.code, {"error": f"upstream HTTP {e.code}"})
        except Exception as e:  # noqa: BLE001
            log(f"upstream error {path}: {e}")
            self._send_json(502, {"error": str(e)})


def main():
    port = int(CONFIG["relay_port"])
    server = ThreadingHTTPServer(("127.0.0.1", port), RelayHandler)
    log(f"===== live_relay 시작 (127.0.0.1:{port}) =====")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
