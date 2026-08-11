# 골프장 가격 수집기 - NAS 배포 가이드 (Synology DS-214, DSM 7.1.1)

매일 새벽 1시에 향후 7일치를 대상으로, 한강이남/강북·경춘/강원/충청 4개 지역의 **골팡 부킹** 매물과
**카카오골프예약**을 같이 수집해서 Cloudflare Worker(`/api/price-dashboard/ingest`)로 전송하는
스크립트입니다. "골프장 + 라운드일 + 시간대(오전/오후/야간)" 단위로 두 플랫폼 중 더 싼 값만 남기고
저장됩니다(중복 시 최저값으로 교체 - 실제 병합/공식명 매칭은 Worker 쪽에서 처리). Docker 없이,
DSM에 기본 내장된 Python 3.9 + 작업 스케줄러만으로 동작합니다.

## 1. 파일 업로드

File Station으로 이 폴더(`nas-collector/`) 전체를 NAS의 아무 공유 폴더에 올립니다. 예:
`/volume1/scripts/golf-price-collector/`

## 2. config.json 만들기

`config.example.json`을 같은 폴더에 `config.json`으로 복사한 뒤 값을 채웁니다.

```json
{
  "ingest_url": "https://jd-golf-hub-backend.jaedong-jung.workers.dev/api/price-dashboard/ingest",
  "ingest_secret": "<wrangler secret put PRICE_INGEST_SECRET 로 등록한 값>",
  "lookahead_days": 7,
  "max_pages_per_search": 5,
  "request_delay_seconds": 0.5
}
```

- `ingest_secret`은 절대 git에 올리지 마세요(이 폴더의 `config.json`은 이미 `.gitignore` 처리돼
  있습니다).
- `lookahead_days`(기본 7일)를 늘리면 골팡 호출 수와 실행 시간이 늘어납니다. 지역 4개 × 7일 =
  최대 28회 호출(인기 지역/날짜는 페이지네이션으로 더 늘 수 있음) + 카카오골프예약 대권역 3개 ×
  시간대 3개 × 7일 = 63회 호출 + 매칭된 골프장 수만큼의 이름 조회(스크립트 실행 1회 안에서만
  캐싱됨).

## 3. SSH로 수동 실행 테스트

제어판 > 터미널 및 SNMP에서 SSH가 켜져 있는지 확인 후:

```bash
ssh <계정>@<NAS IP>
cd /volume1/scripts/golf-price-collector
python3 price_collector.py
```

`logs/price_collector.log`에 날짜별로 "골팡 N건 + 카카오 M건 -> 병합 후 K건 저장" 형식의 요약이
쌓이면 정상입니다. 골팡/카카오 응답이 없거나 구조가 바뀌면 해당 조합만 ERROR로 기록되고 나머지는
계속 진행됩니다(전체가 죽지 않음).

## 4. DSM 작업 스케줄러 등록

**제어판 > 작업 스케줄러 > 생성 > 예약된 작업 > 사용자 정의 스크립트**

1. **일반 탭**
   - 작업: `골프장 가격 수집`
   - 사용자: 이 스크립트를 실행할 계정 (해당 폴더에 읽기/쓰기 권한이 있는 일반 계정 권장, admin
     아니어도 됨)
2. **일정 탭**
   - 매일 반복, 시간 `01:00`
3. **작업 설정 탭** - 사용자 정의 스크립트에 아래 입력:
   ```bash
   python3 /volume1/scripts/golf-price-collector/price_collector.py >> /volume1/scripts/golf-price-collector/logs/task_scheduler.log 2>&1
   ```
   (실제 업로드한 경로로 바꿔주세요)
4. 저장 후, 작업을 선택하고 **실행**을 눌러 한 번 더 수동으로 확인해보는 것을 권장합니다.

## 5. 확인

- 다음날 아침 `logs/price_collector.log`(또는 위 4번의 `task_scheduler.log`) 마지막 줄에
  `수집 완료: 7일 처리 중 에러 0회, 총 N건 저장` 같은 요약이 있으면 정상입니다.
- 앱의 햄버거 메뉴 > "📊 가격 대시보드"에서 실제로 골프장이 목록에 뜨는지 확인합니다.
- 작업 스케줄러의 작업 실행 결과(성공/실패)는 DSM 알림(제어판 > 알림)으로도 받을 수 있습니다 -
  에러 비율이 50%를 넘으면 스크립트가 비정상 종료 코드를 반환하도록 만들어뒀습니다.

## 병합/중복 처리 방식

- 골팡: 같은 골프장·같은 라운드일 안에서도 여러 시간대가 나오므로, "오전(~12시)/오후(12~16시)/
  야간(16시~)" 3구간으로 묶어서 각 구간의 최저가만 후보로 올립니다.
- 카카오골프예약: 지역 검색 자체가 "골프장 단위 최저가 요약"만 주기 때문에(개별 시간대를 보려면
  골프장마다 상세조회가 추가로 필요 - 워치 기능이 이렇게 동작), 상세조회 없이 시간대별 필터를 걸어
  요약 최저가만 가져옵니다. 그래서 카카오 쪽 `time`은 항상 비어 있고 시간대 라벨만 남습니다.
- 같은 골프장·같은 라운드일·같은 시간대에 두 플랫폼 값이 모두 있으면(=중복) **더 싼 쪽 하나만**
  저장하고, 어느 플랫폼 값인지(source)도 같이 남깁니다.
- **지역 구분 한계**: 카카오골프예약의 "서울/경기" 대권역은 한강이남/강북·경춘을 구분하지 않습니다
  (regionMap.js 주석 참고 - 문체부 DB 자체가 시/도 단위라 이 둘을 못 나눔). 같은 골프장이 그날
  골팡에도 잡혔으면 그 지역 값을 그대로 물려받고, 카카오에서만 보인 골프장은 일단 한강이남으로
  분류됩니다(완벽한 구분은 아니지만, 매일 골팡 데이터가 쌓이면서 점점 더 많은 골프장의 실제
  지역이 확정됩니다).

## 참고

- 외부에서 NAS로 들어오는 연결은 전혀 필요 없습니다(Cloudflare Tunnel, 포트포워딩 불필요) - NAS가
  골팡·카카오골프예약·Worker 세 곳에 나가는(outbound) 요청만 합니다.
- 요청/파싱 로직은 백엔드 저장소의 `src/golfpang.js`, `src/kakaogolf.js`를 그대로 이식한 것입니다.
  두 사이트 구조가 바뀌어 파싱이 깨지면 해당 파일들을 같이 고쳐야 합니다.
- 조인(join) 매물은 수집하지 않습니다(부킹만). 필요해지면 `collect_golfpang_entries`에 모드를
  추가하는 정도로 확장할 수 있습니다.
