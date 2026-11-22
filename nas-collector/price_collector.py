#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
골프장 부킹 가격 히스토리 수집기 (NAS에서 매일 새벽 1시 실행).

골팡(golfpang.com)의 "부킹" 매물과 카카오골프예약(kakao.golf)을 같은 라운드일에 대해 같이
수집해서, "골프장 + 라운드일 + 시간대(오전/오후/야간)" 단위로 두 플랫폼 중 더 싼 값만 남기고
Cloudflare Worker의 POST /api/price-dashboard/ingest 로 보낸다. 병합(공식 골프장명 매칭 +
최저가 dedup) 자체는 Worker 쪽(src/priceDashboard.js)에서 한다 - 매칭 로직(golfCourseDB.js)을
Python으로 중복 유지하지 않기 위해서다. 이 스크립트는 원자료를 모아서 보내는 역할만 한다.

Cloudflare Workers는 요청 1회당 외부 호출 횟수 제한(무료 플랜 기준 50개)이 있어서 이 수집을
Worker 크론으로는 돌릴 수 없다 - NAS(제한 없음)에서 돌리고 결과만 push한다.

표준 라이브러리만 사용한다(urllib/re/json) - Synology DS-214는 Docker를 못 쓰고, pip로 외부
패키지(requests 등)를 설치하는 것도 매번 확인해야 해서 번거로우므로 의존성을 아예 없앴다.

요청 구성 참고 원본(수정 시 같이 봐야 함):
  - 골팡: src/golfpang.js (searchGolfpangRounds / parseRoundRows)
  - 카카오골프예약: src/kakaogolf.js (searchKakaoGolfRounds / fetchGolfInfo)
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
KAKAOGOLF_BASE = "https://www.kakao.golf"

# regionMap.js NORMALIZED_REGION_CODES의 golfpang 코드와 동일. 카카오골프예약은 "서울/경기"가
# 한강이남/강북·경춘을 구분하지 않아서(major '1') 그 둘의 golfpang 조회 결과로 나중에 Worker가
# regionGroup을 역추론한다(priceDashboard.js ingestPriceSnapshot 참고) - 그래서 여기 KAKAO_MAJOR는
# gangwon/chungcheong에만 있고, "서울/경기"는 아래 KAKAO_SEOUL_GYEONGGI_MAJOR로 따로 한 번만 조회한다.
REGIONS = {
    "hangang": {"golfpang_sector": "5"},
    "gangbuk": {"golfpang_sector": "1"},
    "gangwon": {"golfpang_sector": "8", "kakao_major": "12"},
    "chungcheong": {"golfpang_sector": "4", "kakao_major": "22"},
}
KAKAO_SEOUL_GYEONGGI_MAJOR = "1"

# "오전(~12시)/오후(12~16시)/야간(16시~)" - 카카오골프예약 자체 timeZone 비트마스크(새벽1/오전2/
# 오후4/야간8)와 경계가 정확히 일치한다. 오전 = 새벽+오전 비트 합산.
TIME_BUCKET_BITS = {"오전": 1 | 2, "오후": 4, "야간": 8}

TR_RE = re.compile(r'<tr id="tr_(\d+)"[^>]*>([\s\S]*?)</tr>')
TD_RE = re.compile(r"<td[^>]*>([\s\S]*?)</td>")
TAG_RE = re.compile(r"<[^>]*>")
WS_RE = re.compile(r"\s+")
FEE_RE = re.compile(r"[\d,]+")
TIME_RE = re.compile(r"^(\d{1,2}):(\d{2})")

UA = "Mozilla/5.0 (compatible; JDGolfPriceCollector/1.0)"


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
    cfg.setdefault("lookahead_days", 7)
    cfg.setdefault("max_pages_per_search", 5)
    cfg.setdefault("request_delay_seconds", 0.5)
    return cfg


def time_bucket_of(hhmm):
    m = TIME_RE.match(hhmm or "")
    if not m:
        return None
    hour = int(m.group(1))
    if hour < 12:
        return "오전"
    if hour < 16:
        return "오후"
    return "야간"


# ===== 골팡(부킹) =====


def strip_tags(html):
    text = TAG_RE.sub("", html)
    text = text.replace("&nbsp;", " ")
    text = text.strip()
    text = WS_RE.sub(" ", text)
    return text


def parse_round_rows(html):
    """<tr id="tr_{idx}">...<td>...</td>...</tr> 반복 구조 파싱. 칼럼 순서(golfpang.js
    parseRoundRows와 동일 기준): 2=티타임 4=골프장 5=홀수 7=그린피 9=캐디유무."""
    rows = []
    for tr_match in TR_RE.finditer(html):
        cells = [strip_tags(td.group(1)) for td in TD_RE.finditer(tr_match.group(2))]
        if len(cells) < 8:
            continue
        fee_match = FEE_RE.search(cells[7] or "")
        rows.append(
            {
                "time": cells[2] if len(cells) > 2 else "",
                "courseName": cells[4] if len(cells) > 4 else "",
                "holes": cells[5] if len(cells) > 5 else "",
                "greenFee": int(fee_match.group(0).replace(",", "")) if fee_match else None,
                "caddyType": cells[9] if len(cells) > 9 else "",
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


def http_post_json(url, body_dict, referer=None, timeout=20, retries=2):
    data = json.dumps(body_dict).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Origin": KAKAOGOLF_BASE,
        "User-Agent": UA,
    }
    if referer:
        headers["Referer"] = referer
    last_err = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, data=data, method="POST", headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as res:
                return json.loads(res.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError) as e:
            last_err = e
            if attempt < retries:
                time.sleep(1.5 * (attempt + 1))
    raise last_err


def search_golfpang_page(round_date, sector, page):
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
        "sector3": "",
    }
    headers = {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": f"{GOLFPANG_BASE}/web/round/booking_list.do",
        "User-Agent": UA,
    }
    return http_post_form(f"{GOLFPANG_BASE}/web/round/booking_tblList.do", body, headers)


def collect_golfpang_entries(round_date, max_pages, delay):
    entries = []
    for region_group, cfg in REGIONS.items():
        for page in range(1, max_pages + 1):
            html = search_golfpang_page(round_date, cfg["golfpang_sector"], page)
            rows = parse_round_rows(html)
            for r in rows:
                bucket = time_bucket_of(r["time"])
                if not bucket or r["greenFee"] is None or not r["courseName"]:
                    continue
                entries.append(
                    {
                        "source": "golfpang",
                        "regionGroup": region_group,
                        "courseName": r["courseName"],
                        "time": r["time"],
                        "timeBucket": bucket,
                        "greenFee": r["greenFee"],
                        "holes": r["holes"],
                        "caddyType": r["caddyType"],
                    }
                )
            if len(rows) < 100:  # 마지막 페이지
                break
            time.sleep(delay)
        time.sleep(delay)
    return entries


# ===== 카카오골프예약 =====


def kakaogolf_search_body(compact_date, major, bucket_bits):
    return {
        "date": compact_date,
        "qfSeq": "0",
        "searchType": 2,
        "lowGuarantee": "N",
        "selectedDates": None,
        "flagCashBack": "N",
        "quickFilterTypeHistory": None,
        "weekType": "1",
        "areas1s": [int(major)],
        "enterType": "MAIN_AREA",
        "searchSeq": "1",
        "reservFlag": "N",
        "title": "",
        "listType": "0",
        "detailAreaText": "",
        "filter": {
            "greenFee": 0,
            "greenFeeList": [0],
            "timeZone": bucket_bits,
            "timeZoneList": [0, bucket_bits],
            "orderForGolfClubListMode": 0,
            "orderForTeeTimeListMode": 0,
            "timeZoneDisable": 0,
            "greenFeeDisable": 0,
            "paymentMethodDisable": 0,
            "visitorCntDisable": 0,
            "eventEnable": False,
            "paymentMethodFlag": 0,
            "paymentMethodList": [],
            "visitorCntFlag": 0,
            "visitorCnts": [],
            "holeCnt": 0,
            "holeCntFlag": 0,
            "holeCntList": [],
            "event": 0,
            "events": [],
            "isOnlyAvailableTeeTime": False,
            "isOnlyCashBackTeeTime": False,
            "isOnlyLowGuarantee": False,
            "paymentMethod": "",
            "visitorCnt": 0,
        },
        "isOnlyCashBackCondition": "false",
        "golfinfos": [],
        "searchName": "",
        "areas2": [0],
        "sigunguSeq": "1",
    }


def kakaogolf_search(compact_date, major, bucket_bits):
    data = http_post_json(
        f"{KAKAOGOLF_BASE}/api/tee-time/search",
        kakaogolf_search_body(compact_date, major, bucket_bits),
        referer=f"{KAKAOGOLF_BASE}/tee-time?area={major}&date={compact_date}",
    )
    if data.get("resultCode") != 200:
        raise RuntimeError(data.get("resultMsg") or "카카오골프예약 응답 오류")
    return [item for item in (data.get("list") or []) if (item.get("timeCnt") or 0) > 0]


def kakaogolf_golf_info(golf_info_seq, cache):
    """골프장명 해석(골프장 단위 요약엔 이름이 안 들어있어서 필요). 스크립트 한 번 실행 안에서만
    캐싱(파일 영속화는 하지 않음 - 이름은 거의 안 바뀌고, 실행 하나당 중복 조회만 막으면 충분)."""
    if golf_info_seq in cache:
        return cache[golf_info_seq]
    try:
        data = http_post_json(
            f"{KAKAOGOLF_BASE}/api/golf/view",
            {"golfInfoSeq": golf_info_seq},
            referer=f"{KAKAOGOLF_BASE}/golf/{golf_info_seq}",
        )
    except Exception:
        return None
    if data.get("resultCode") != 200:
        return None
    info = {"name": data.get("fullName") or "", "holeCount": data.get("holeCount")}
    cache[golf_info_seq] = info
    return info


def collect_kakaogolf_entries(round_date, delay, info_cache):
    compact = round_date.replace("-", "")
    entries = []
    majors = [(KAKAO_SEOUL_GYEONGGI_MAJOR, None), ("12", "gangwon"), ("22", "chungcheong")]
    for major, region_group in majors:
        for bucket_label, bits in TIME_BUCKET_BITS.items():
            try:
                items = kakaogolf_search(compact, major, bits)
            except Exception as e:  # noqa: BLE001
                log(f"ERROR kakaogolf major={major} {bucket_label} {round_date}: {e}")
                time.sleep(delay)
                continue
            for item in items:
                seq = item.get("golfInfoSeq")
                info = kakaogolf_golf_info(seq, info_cache)
                if not info or not info.get("name"):
                    continue
                fee = item.get("minGreenFeeDC")
                if fee is None:
                    fee = item.get("minGreenFeeNO")
                if fee is None:
                    continue
                entries.append(
                    {
                        "source": "kakaogolf",
                        "regionGroup": region_group,
                        "courseName": info["name"],
                        "time": None,
                        "timeBucket": bucket_label,
                        "greenFee": fee,
                        "holes": f"{info['holeCount']}홀" if info.get("holeCount") else None,
                        "caddyType": None,
                    }
                )
            time.sleep(delay)
    return entries


def send_to_ingest(cfg, collected_date, round_date, entries):
    payload = json.dumps(
        {"collectedDate": collected_date, "roundDate": round_date, "entries": entries}
    ).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "X-Ingest-Secret": cfg["ingest_secret"],
        # Cloudflare가 기본 Python-urllib User-Agent를 봇으로 차단한다(error code 1010, 실측 확인됨).
        "User-Agent": UA,
    }
    req = urllib.request.Request(cfg["ingest_url"], data=payload, method="POST", headers=headers)
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.loads(res.read().decode("utf-8"))


def main():
    cfg = load_config()
    collected_date = date.today().isoformat()
    lookahead_days = int(cfg["lookahead_days"])
    max_pages = int(cfg["max_pages_per_search"])
    delay = float(cfg["request_delay_seconds"])
    info_cache = {}

    log(f"===== 수집 시작 (collected_date={collected_date}, lookahead={lookahead_days}일, 부킹만+카카오골프예약 병합) =====")
    total_sent = 0
    total_errors = 0

    for day_offset in range(lookahead_days):
        round_date = (date.today() + timedelta(days=day_offset)).isoformat()
        try:
            golfpang_entries = collect_golfpang_entries(round_date, max_pages, delay)
        except Exception as e:  # noqa: BLE001
            golfpang_entries = []
            total_errors += 1
            log(f"ERROR golfpang {round_date}: {e}")

        kakaogolf_entries = collect_kakaogolf_entries(round_date, delay, info_cache)

        all_entries = golfpang_entries + kakaogolf_entries
        if not all_entries:
            log(f"{round_date}: 수집 0건 (골팡/카카오 둘 다 매물 없음)")
            continue
        try:
            result = send_to_ingest(cfg, collected_date, round_date, all_entries)
            total_sent += result.get("inserted", 0)
            log(
                f"{round_date}: 골팡 {len(golfpang_entries)}건 + 카카오 {len(kakaogolf_entries)}건 "
                f"-> 병합 후 {result.get('inserted', 0)}건 저장"
            )
        except Exception as e:  # noqa: BLE001
            total_errors += 1
            log(f"ERROR ingest {round_date}: {e}")

    log(f"===== 수집 완료: {lookahead_days}일 처리 중 에러 {total_errors}회, 총 {total_sent}건 저장 =====")

    if total_errors > lookahead_days * 0.5:
        log("에러 비율이 50%를 넘어 비정상 종료로 표시합니다.")
        sys.exit(1)


if __name__ == "__main__":
    main()
