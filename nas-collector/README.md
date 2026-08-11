# 골프장 가격 수집기 - NAS 배포 가이드 (Synology DS-214, DSM 7.1.1)

매일 새벽 1시에 골팡(golfpang.com)에서 한강이남/강북·경춘/강원/충청 4개 지역의 조인·부킹 가격을
수집해서 Cloudflare Worker(`/api/price-dashboard/ingest`)로 전송하는 스크립트입니다. Docker 없이,
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
  "lookahead_days": 30,
  "max_pages_per_search": 5,
  "request_delay_seconds": 0.5
}
```

- `ingest_secret`은 절대 git에 올리지 마세요(이 폴더의 `config.json`은 이미 `.gitignore` 처리돼
  있습니다).
- `lookahead_days`(기본 30일)를 늘리면 하루 수집량과 실행 시간이 그만큼 늘어납니다. 지역 4개 ×
  30일 × 모드 2개 = 최대 240회 호출(인기 지역/날짜는 페이지네이션으로 더 늘 수 있음).

## 3. SSH로 수동 실행 테스트

제어판 > 터미널 및 SNMP에서 SSH가 켜져 있는지 확인 후:

```bash
ssh <계정>@<NAS IP>
cd /volume1/scripts/golf-price-collector
python3 price_collector.py
```

`logs/price_collector.log`에 지역×날짜×모드별 수집 건수가 쌓이면 정상입니다. 골팡 응답이 없거나
구조가 바뀌면 해당 조합만 ERROR로 기록되고 나머지는 계속 진행됩니다(전체가 죽지 않음).

전체 실행은 지역4 × 날짜30 × 모드2 = 240회 호출 + 요청 사이 0.5초 대기 기준으로 대략 몇 분
정도 걸립니다(페이지네이션이 걸리는 인기 지역/날짜가 많으면 더 걸릴 수 있음).

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
  `수집 완료: 호출 N회 중 에러 0회, 총 M건 저장` 같은 요약이 있으면 정상입니다.
- 앱의 햄버거 메뉴 > "📊 가격 대시보드"에서 실제로 골프장이 목록에 뜨는지 확인합니다.
- 작업 스케줄러의 작업 실행 결과(성공/실패)는 DSM 알림(제어판 > 알림)으로도 받을 수 있습니다 -
  에러 비율이 50%를 넘으면 스크립트가 비정상 종료 코드를 반환하도록 만들어뒀습니다.

## 참고

- 외부에서 NAS로 들어오는 연결은 전혀 필요 없습니다(Cloudflare Tunnel, 포트포워딩 불필요) - NAS가
  골팡과 Worker 양쪽에 나가는(outbound) 요청만 합니다.
- 골팡 요청/파싱 로직은 백엔드 저장소의 `src/golfpang.js`를 그대로 이식한 것입니다. 골팡 사이트
  구조가 바뀌어 파싱이 깨지면 두 파일을 같이 고쳐야 합니다.
- 1차 버전은 골팡만 수집합니다(조인+부킹 모두 포함). 카카오골프예약은 골프장마다 상세조회가
  추가로 필요해 호출량이 훨씬 커서 이후 별도로 검토합니다.
