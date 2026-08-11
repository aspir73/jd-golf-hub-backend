#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
골프장 조인/부킹 가격 히스토리 수집기 (NAS에서 매일 새벽 1시 실행).

Cloudflare Workers는 요청 1회당 외부 호출 횟수 제한(무료 플랜 기준 50개)이 있어서, 지역 4개 ×
기간(기본 30일) × 모드 2개 = 최대 240회 규모의 매일 수집을 Worker 크론으로는 돌릴 수 없다.
그래서 이 스크립트를 NAS(제한 없음)에서 돌리고, 결과를 Cloudflare Worker의
POST /api/price-dashboard/ingest 로 그때그때 밀어넣는다(push).

골팡(golfpang.com)에 대한 요청 구성·HTML 파싱 로직은 백엔드 저장소의 src/golfpang.js
(searchGolfpangRounds/parseRoundRows)를 그대로 이식한 것 - 두 곳을 수정할 일이 생기면 양쪽 다
같이 바꿔야 한다(정규화 규칙처럼 "양쪽에 동일하게 유지해야 하는 규칙" 목록에 추가할 것).

표준 라이브러리만 사용한다(urllib/re/json) - Synology DS-214는 Docker를 못 쓰고, pip로 외부
패키지(requests 등)를 설치하는 것도 매번 확인해야 해서 번거로우므로 의존성을 아예 없앴다.

골프장 공식명 매칭(golfCourseDB.js의 findBestMatch)은 여기서 하지 않는다 - Worker의
ingestPriceSnapshot이 원문 골프장명(courseName)을 받아서 대신 매칭한다. 매칭 로직을 두 언어로
중복 유지하지 않기 위해서다.
"""

import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
CONFIG_PATH = SCRIPT_DIR / "config.json"
LOG_PATH = SCRIPT_DIR / "logs" / "price_collector.log"

GOLFPANG_BASE = "https://www.golfpang.com"

# regionMap.js NORMALIZED_REGION_CODES의 golfpang 코드와 동일 (한강이남/강북·경춘/강원/충청).
REGIONS = {
    "hangang": "5",
    "gangbuk": "1",
    "gangwon": "8",
    "chungcheong": "4",
}
MODES = ["booking", "join"]

TR_RE = re.compile(r'<tr id="tr_(\d+)"[^>]*>([\s\S]*?)</tr>')
TD_RE = re.compile(r"<td[^>]*>([\s\S]*?)</td>")
TAG_RE = re.compile(r"<[^>]*>")
WS_RE = re.compile(r"\s+")
FEE_RE = re.compile(r"[\d,]+")


def log(message):
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    line = f"[{datetime.now().isoformat(timespec='seconds')}] {message}"
    print(line)
    with LOG_PATH.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def load_config():
    if not CONFIG_PATH.exists():
        raise SystemExit(
            f"{CONFIG_PATH} 이 없습니다. config.example.json을 config.json으로 복사하고 "
            "ingest_secret 등을 채워주세요."
        )
    with CONFIG_PATH.open("r", encoding="utf-8") as f:
        cfg = json.load(f)
    cfg.setdefault("lookahead_days", 30)
    cfg.setdefault("max_pages_per_search", 5)
    cfg.setdefault("request_delay_seconds", 0.5)
    return cfg


def strip_tags(html):
    text = TAG_RE.sub("", html)
    text = text.replace("&nbsp;", " ")
    text = text.strip()
    text = WS_RE.sub(" ", text)
    return text


def parse_total_count(html):
    m = re.search(r"총\s*<strong>\s*([\d,]+)\s*</strong>", html)
    return int(m.group(1).replace(",", "")) if m else None


def parse_round_rows(html):
    """<tr id="tr_{idx}">...<td>...</td>...</tr> 반복 구조 파싱. 칼럼 순서는
    booking_tblList.do / join_tblList.do 양쪽 동일(golfpang.js parseRoundRows와 동일 기준):
    0=지역 1=부킹일 2=티타임 4=골프장 5=홀수 7=그린피 8=작성자 9=캐디유무 10=구분."""
    rows = []
    for tr_match in TR_RE.finditer(html):
        row_html = tr_match.group(2)
        cells = [strip_tags(td.group(1)) for td in TD_RE.finditer(row_html)]
        if len(cells) < 8:
            continue
        fee_match = FEE_RE.search(cells[7] or "")
        rows.append(
            {
                "region": cells[0] if len(cells) > 0 else "",
                "date": cells[1] if len(cells) > 1 else "",
                "time": cells[2] if len(cells) > 2 else "",
                "courseName": cells[4] if len(cells) > 4 else "",
                "holes": cells[5] if len(cells) > 5 else "",
                "greenFee": int(fee_match.group(0).replace(",", "")) if fee_match else None,
                "nickname": cells[8] if len(cells) > 8 else "",
                "caddyType": cells[9] if len(cells) > 9 else "",
                "category": cells[10] if len(cells) > 10 else "",
            }
        )
    return rows


def http_post_form(url, form_dict, headers, timeout=20, retries=2):
    data = urllib.parse.urlencode(form_dict).encode("utf-8")
    last_err = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, data=data, method="POST", headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as res:
                return res.read().decode("utf-8", errors="replace")
        except (urllib.error.URLError, TimeoutError) as e:
            last_err = e
            if attempt < retries:
                time.sleep(1.5 * (attempt + 1))
    raise last_err


def search_golfpang_page(round_date, sector, mode, page):
    is_join = mode == "join"
    endpoint = "join_tblList.do" if is_join else "booking_tblList.do"
    referer_page = "join_list.do" if is_join else "booking_list.do"

    body = {
        "pageNum": str(page),
        "bkOrder": "",
        "rd_date": round_date,
        "ampm": "",
        "sector": sector,
        "idx": "",
        "cust_nick": "",
        "clubname": "",
        "sector2": sector,
        "cdOrder": "",  # 전체 캐디유형 - 가격 수집은 조건을 좁히지 않고 최대한 넓게 본다
    }
    if is_join:
        body["notima"] = ""
        body["jitype1"] = ""
    else:
        body["sector3"] = ""

    headers = {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": f"{GOLFPANG_BASE}/web/round/{referer_page}",
        "User-Agent": "Mozilla/5.0 (compatible; JDGolfPriceCollector/1.0)",
    }
    html = http_post_form(f"{GOLFPANG_BASE}/web/round/{endpoint}", body, headers)
    return html


def search_golfpang_all_pages(round_date, sector, mode, max_pages, delay):
    all_rows = []
    for page in range(1, max_pages + 1):
        html = search_golfpang_page(round_date, sector, mode, page)
        rows = parse_round_rows(html)
        all_rows.extend(rows)
        if len(rows) < 100:  # 마지막 페이지
            break
        time.sleep(delay)
    return all_rows


def send_to_ingest(cfg, collected_date, round_date, region_group, mode, rows):
    payload = json.dumps(
        {
            "collectedDate": collected_date,
            "roundDate": round_date,
            "regionGroup": region_group,
            "mode": mode,
            "rows": rows,
        }
    ).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "X-Ingest-Secret": cfg["ingest_secret"],
        # Cloudflare가 기본 Python-urllib User-Agent를 봇으로 차단한다(error code 1010, 실측 확인됨) -
        # 골팡 요청과 마찬가지로 평범한 UA를 붙여야 우리 자신의 Worker에도 도달할 수 있다.
        "User-Agent": "Mozilla/5.0 (compatible; JDGolfPriceCollector/1.0)",
    }
    req = urllib.request.Request(cfg["ingest_url"], data=payload, method="POST", headers=headers)
    with urllib.request.urlopen(req, timeout=20) as res:
        return json.loads(res.read().decode("utf-8"))


def main():
    cfg = load_config()
    collected_date = date.today().isoformat()
    lookahead_days = int(cfg["lookahead_days"])
    max_pages = int(cfg["max_pages_per_search"])
    delay = float(cfg["request_delay_seconds"])

    log(f"===== 수집 시작 (collected_date={collected_date}, lookahead={lookahead_days}일) =====")
    total_sent = 0
    total_errors = 0
    total_calls = 0

    for region_group, sector in REGIONS.items():
        for day_offset in range(lookahead_days):
            round_date = (date.today() + timedelta(days=day_offset)).isoformat()
            for mode in MODES:
                total_calls += 1
                try:
                    rows = search_golfpang_all_pages(round_date, sector, mode, max_pages, delay)
                    if rows:
                        result = send_to_ingest(cfg, collected_date, round_date, region_group, mode, rows)
                        total_sent += result.get("inserted", 0)
                        log(f"{region_group} {round_date} {mode}: {len(rows)}건 수집 -> {result.get('inserted', 0)}건 저장")
                    else:
                        log(f"{region_group} {round_date} {mode}: 0건")
                except Exception as e:  # noqa: BLE001 - 하나 실패해도 나머지는 계속 돌아야 함
                    total_errors += 1
                    log(f"ERROR {region_group} {round_date} {mode}: {e}")
                time.sleep(delay)

    log(f"===== 수집 완료: 호출 {total_calls}회 중 에러 {total_errors}회, 총 {total_sent}건 저장 =====")

    # 절반 넘게 실패했으면 DSM 작업 스케줄러의 "작업 실패" 알림이 뜨도록 비정상 종료시킨다
    # (조용히 절반만 수집되고 넘어가는 것보다, 눈에 띄게 실패로 표시되는 편이 낫다).
    if total_calls and total_errors > total_calls * 0.5:
        log("에러 비율이 50%를 넘어 비정상 종료로 표시합니다.")
        sys.exit(1)


if __name__ == "__main__":
    main()
