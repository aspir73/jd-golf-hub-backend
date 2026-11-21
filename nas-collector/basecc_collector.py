#!/usr/bin/env python3
"""대영베이스CC(basecc.co.kr) 실시간 예약 티타임 수집기 (NAS/집 PC에서 실행).

왜 NAS에서 도는가: 대영베이스 홈페이지 방화벽(WAF)이 Cloudflare Worker의 IP를 차단해서("보안 위협이
탐지되어 접근이 차단") Worker가 직접 읽을 수 없다. 집/NAS IP에서는 정상 응답이라, 여기서 읽어서
Worker의 /api/tee-snapshots/basecc 로 올려두면 주말 현황과 모니터링(취소티 감지)이 그 스냅샷을 쓴다.

로그인 불필요한 공개 예약 화면(Reservation.aspx)만 읽는다. 달력 날짜 링크가 ASP.NET 포스트백이라
첫 GET으로 viewstate를 받고 날짜별로 POST를 보낸다. 사이트 부담을 줄이려고 날짜 사이에 지연을 두고,
조회 범위(basecc_lookahead_days)와 반복 주기(basecc_interval_minutes)를 설정으로 제한한다.

사용법:
  python basecc_collector.py            # 한 번 수집해서 올리고 종료 (작업 스케줄러/cron용)
  python basecc_collector.py --loop     # 주기(basecc_interval_minutes)마다 계속 수집
  python basecc_collector.py --dry-run  # 올리지 않고 결과만 출력(테스트)

config.json (price_collector.py와 공용): ingest_secret 필수. 선택 항목:
  basecc_ingest_url (기본: Worker /api/tee-snapshots/basecc), basecc_lookahead_days(기본 14),
  basecc_interval_minutes(기본 15), basecc_delay_seconds(기본 1.5)
표준 라이브러리만 사용한다.
"""

import http.cookiejar
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta

BASE = "https://basecc.co.kr/Reservation/Reservation.aspx"
DEFAULT_INGEST = "https://jd-golf-hub-backend.jaedong-jung.workers.dev/api/tee-snapshots/basecc"
UA = "Mozilla/5.0 (compatible; JDGolfHub/1.0)"
CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")


def log(msg):
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


def load_config():
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}  # --dry-run은 설정 파일 없이도 동작


def strip_tags(s):
    s = re.sub(r"<br\s*/?>", " ", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    return re.sub(r"\s+", " ", s.replace("&nbsp;", " ")).strip()


def to_num(s):
    digits = re.sub(r"[^\d]", "", s or "")
    return int(digits) if digits else None


def caddy_type_of(text):
    if not text:
        return "general"
    if "시니어" in text:
        return "senior"
    if "드라이빙" in text:
        return "driving"
    if "새싹" in text:
        return "sprout"
    return "other"


def hidden_value(html, name):
    m = re.search(r'name="' + re.escape(name) + r'"[^>]*value="([^"]*)"', html)
    return m.group(1) if m else ""


def parse_time_table(html):
    """첫 번째 timeTbl(전체 탭)만 읽는다 - 1부/2부/3부 탭이 같은 내용을 반복하므로."""
    start = html.find('class="timeTbl"')
    if start < 0:
        return []
    rest = html[start:]
    end = rest.find("</table>")
    table = rest[:end] if end > 0 else rest
    rounds = []
    for tr in re.split(r"<tr[\s>]", table)[1:]:
        cells = re.findall(r"<td[^>]*>([\s\S]*?)</td>", tr, flags=re.I)
        if len(cells) < 7:
            continue
        t = strip_tags(cells[1])
        if not re.match(r"^\d{1,2}:\d{2}$", t):
            continue
        reserve = re.search(r"Reserve\('([^']*)','(\d{4})','([^']*)','([^']*)','([^']*)','([^']*)'", tr)
        caddy = strip_tags(cells[2])
        list_price = to_num(strip_tags(cells[3]))
        discount = to_num(strip_tags(cells[4]))
        holes = 18
        if reserve and reserve.group(6).isdigit():
            holes = int(reserve.group(6))
        rounds.append({
            "time": t,
            "courseSubName": strip_tags(cells[0]),
            "caddy": caddy,
            "caddyType": caddy_type_of(caddy),
            "holes": holes,
            "listPrice": list_price,
            "greenFee": discount if discount is not None else list_price,
            "event": strip_tags(cells[5]),
        })
    return rounds


def make_opener():
    jar = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def http_get(opener, url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with opener.open(req, timeout=25) as res:
        return res.read().decode("utf-8", errors="replace")


def http_post_form(opener, url, form):
    data = urllib.parse.urlencode(form).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST", headers={
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Referer": BASE,
    })
    with opener.open(req, timeout=25) as res:
        return res.read().decode("utf-8", errors="replace")


def collect(lookahead_days, delay):
    """예약 가능한(달력에 링크가 있는) 날짜 중 오늘부터 lookahead_days일 이내만 수집한다."""
    opener = make_opener()
    html = http_get(opener, BASE)
    if "접근이 차단" in html or "timeTbl" not in html and "Update('LIST|" not in html:
        raise RuntimeError("예약 화면을 읽지 못했습니다(차단되었거나 화면 구조가 바뀜)")
    state = {
        "__VIEWSTATE": hidden_value(html, "__VIEWSTATE"),
        "__VIEWSTATEGENERATOR": hidden_value(html, "__VIEWSTATEGENERATOR"),
        "__EVENTVALIDATION": hidden_value(html, "__EVENTVALIDATION"),
    }
    args = {}
    for m in re.finditer(r"Update\('(LIST\|[^|']*\|(\d{4}-\d{2}-\d{2})\|[^']*)'\)", html):
        args[m.group(2)] = m.group(1)
    limit = (date.today() + timedelta(days=lookahead_days)).isoformat()
    today = date.today().isoformat()
    targets = sorted(d for d in args if today <= d <= limit)

    dates = {}
    for d in targets:
        time.sleep(delay)
        body = {
            "__EVENTTARGET": "ctl00$ContentPlaceHolder1$btnUp",
            "__EVENTARGUMENT": "",
            **state,
            "ctl00$ContentPlaceHolder1$htbArgs": args[d],
            "strReserveType": "1",
            "strClubCode": "M",
        }
        try:
            page = http_post_form(opener, BASE, body)
        except Exception as e:  # noqa: BLE001
            log(f"ERROR {d}: {e}")
            continue
        y, mo, dd = d.split("-")
        if f"{int(y)}년 {int(mo)}월 {int(dd)}일" not in page:
            log(f"WARN {d}: 응답이 요청한 날짜가 아님(건너뜀)")
            continue
        dates[d] = {"open": True, "rounds": parse_time_table(page)}
    return dates


def send(cfg, dates):
    url = cfg.get("basecc_ingest_url", DEFAULT_INGEST)
    payload = json.dumps({"dates": dates}).encode("utf-8")
    req = urllib.request.Request(url, data=payload, method="POST", headers={
        "Content-Type": "application/json",
        "X-Ingest-Secret": cfg["ingest_secret"],
        "User-Agent": UA,  # Cloudflare가 기본 Python-urllib UA를 막는다
    })
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.loads(res.read().decode("utf-8"))


def run_once(cfg, dry_run):
    lookahead = int(cfg.get("basecc_lookahead_days", 14))
    delay = float(cfg.get("basecc_delay_seconds", 1.5))
    dates = collect(lookahead, delay)
    total = sum(len(v["rounds"]) for v in dates.values())
    log(f"수집: {len(dates)}일, 티타임 {total}건")
    if dry_run:
        for d, v in list(dates.items())[:3]:
            log(f"  {d}: {len(v['rounds'])}건 예) {v['rounds'][:2]}")
        return
    result = send(cfg, dates)
    log(f"업로드 완료: {result}")


def main():
    dry_run = "--dry-run" in sys.argv
    loop = "--loop" in sys.argv
    cfg = load_config()
    if not dry_run and not cfg.get("ingest_secret"):
        log("config.json에 ingest_secret이 필요합니다")
        sys.exit(2)
    if not loop:
        run_once(cfg, dry_run)
        return
    interval = max(5, int(cfg.get("basecc_interval_minutes", 15)))
    log(f"반복 수집 시작: {interval}분 간격")
    while True:
        try:
            run_once(cfg, dry_run)
        except Exception as e:  # noqa: BLE001
            log(f"ERROR: {e}")
        time.sleep(interval * 60)


if __name__ == "__main__":
    main()
