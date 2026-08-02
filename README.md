# JD Golf Hub - Backend (Cloudflare Worker)

JD Times의 "Cloudflare Worker 단일 진입점" 패턴을 재사용한 개인용 골프 허브 백엔드.
MVP1 범위: 날씨(+복장 추천), 스코어 수동입력, 기본 통계.

## 로컬 개발

```bash
npm install
npm run dev
```

## 배포 전 설정

### 1. KV 네임스페이스 생성

```bash
wrangler kv namespace create GOLF_KV
```

출력된 `id` 값을 `wrangler.toml`의 `REPLACE_WITH_KV_NAMESPACE_ID` 자리에 넣는다.

### 2. 기상청 단기예보 API 키 발급 및 등록

1. [공공데이터포털](https://www.data.go.kr) 회원가입 (휴대폰 인증 필요)
2. "기상청_단기예보 ((구)_동네예보) 조회서비스" 검색 → 활용신청
3. 개발계정은 신청 즉시 승인, 인증키(Encoding/Decoding) 발급
4. **Decoding 값**을 아래 명령으로 등록 (평문 저장 금지, 반드시 secret)

```bash
wrangler secret put KMA_API_KEY
```

### 3. 배포

```bash
npm run deploy
```

## API

| Method | Path | 설명 |
|---|---|---|
| GET | `/api/weather?lat=&lon=` | 오늘 시간대별 예보 + 복장 추천 |
| GET | `/api/scores` | 스코어 기록 전체 목록 |
| POST | `/api/scores` | 스코어 기록 추가 |
| PUT | `/api/scores/:id` | 스코어 기록 수정 |
| DELETE | `/api/scores/:id` | 스코어 기록 삭제 |
| GET | `/api/stats` | 최근10 평균/베스트/코스별 평균/트렌드 |

## 다음 단계 (MVP2+)

- 카카오맵 API 연동 (맛집, 거리 계산) — `KAKAO_API_KEY` secret 추가 예정
- 골프장 마스터 DB, 골팡 조건검색 프록시 (`/web/round/booking_tblList.do` 등)
- 이미지 인식(Vision API) 연동 — 스코어카드/화면캡처/영수증
- 무거운 데이터(원본 사진, 백업)를 위한 Cloudflare Tunnel 경유 NAS 연동
