# JD Golf Hub - Backend (Cloudflare Worker)

JD Times의 "Cloudflare Worker 단일 진입점" 패턴을 재사용한 개인용 골프 허브 백엔드.

- MVP1: 날씨(+복장 추천), 스코어 수동입력, 기본 통계
- MVP2: 카카오맵 연동(장소 검색·맛집·길찾기 딥링크), 골프장 마스터 DB, 동반자 관리, 정산 계산
- MVP3: Claude Vision 이미지 인식(스코어카드/화면캡처/영수증), 출처·라운드종류 태그, 통계 필터링
- MVP4: 골프장 조건검색(골팡 비로그인 프록시), 동반예약(백업) 비교 그룹, 가중치 기반 점수 추천
- MVP5: 예약확정 메시지 붙여넣기 AI 파싱, 가예약↔확정 자동 매칭, 취소마감 리마인드, 예약 현황 리포트

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

### 3. 카카오맵 REST API 키 발급 및 등록

1. [Kakao Developers](https://developers.kakao.com) 로그인 → 내 애플리케이션 → 애플리케이션 추가
2. 앱 요약정보에서 **REST API 키** 확인
3. **2024.12부터 [카카오맵] 사용 설정을 별도로 ON** 해야 정상 호출됨 (앱 설정 → 플랫폼/제품 설정)
4. 아래 명령으로 등록 (평문 저장 금지, 반드시 secret)

```bash
wrangler secret put KAKAO_API_KEY
```

### 4. Anthropic API 키 발급 및 등록 (이미지 인식용)

1. [Anthropic Console](https://console.anthropic.com)에서 API 키 발급
2. 스코어카드/화면캡처/영수증 사진 인식(Claude Vision, 구조화 출력)에 사용 — 보안상 클라이언트가 아닌 이 Worker에서만 호출
3. 아래 명령으로 등록 (평문 저장 금지, 반드시 secret)

```bash
wrangler secret put ANTHROPIC_API_KEY
```

### 5. 배포

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
| GET | `/api/stats?source=&roundType=` | 최근10 평균/베스트/코스별 평균/트렌드 (출처·라운드종류 필터링 가능) |
| POST | `/api/vision/recognize` | 이미지 인식 (`context`: scorecard/voicecaddie/smartscore/receipt) — 구조화 데이터 추출 |
| GET | `/api/settings` | 개인 설정(집 주소 좌표) 조회 |
| PUT | `/api/settings` | 개인 설정 수정 |
| GET | `/api/places/search?query=` | 카카오 키워드 장소 검색 (골프장 등록 자동완성) |
| GET | `/api/courses` | 즐겨찾기 골프장 목록 |
| POST | `/api/courses` | 골프장 등록 |
| PUT | `/api/courses/:id` | 골프장 정보 수정 |
| DELETE | `/api/courses/:id` | 골프장 삭제 |
| GET | `/api/companions` | 동반자 목록 |
| POST | `/api/companions` | 동반자 추가 |
| PUT | `/api/companions/:id` | 동반자 정보 수정 |
| DELETE | `/api/companions/:id` | 동반자 삭제 |
| POST | `/api/settlement/calculate` | 정산 계산 (1인당 부담액 + 송금 목록 + 카톡 공유문구) |
| GET | `/api/restaurants/search?lat=&lon=&timing=` | 골프장 주변 맛집 검색 (`timing`: before/after/cafe) |
| GET | `/api/restaurants/favorites` | 즐겨찾기 맛집 목록 |
| POST | `/api/restaurants/favorites` | 즐겨찾기 맛집 추가 |
| DELETE | `/api/restaurants/favorites/:id` | 즐겨찾기 맛집 삭제 |
| GET | `/api/golfpang/search?date=&ampm=&sector=&mode=` | 골팡 비로그인 조회 프록시 (`mode`: booking/join) |
| GET | `/api/golfmon/search?date=&locationFk=&teeOffBuckets=&caddyTypes=` | 골프몬 비로그인 조회 프록시 (양도/조인, 콤마구분 다중선택) |
| GET | `/api/kakaogolf/search?date=&areas=&timeZone=&visitorCnt=&greenFee=&holeCnt=` | 카카오골프예약 비로그인 조회 프록시 (`areas`: 콤마구분 지역코드) |
| GET | `/api/booking-groups` | 동반예약(백업) 비교 그룹 목록 |
| POST | `/api/booking-groups` | 비교 그룹 생성 (제목 + 후보 목록) |
| DELETE | `/api/booking-groups/:id` | 비교 그룹 삭제 |
| POST | `/api/booking-groups/:id/candidates` | 그룹에 후보 추가 |
| DELETE | `/api/booking-groups/:id/candidates/:candidateId` | 그룹에서 후보 삭제 |
| GET | `/api/booking-groups/:id/compare` | 후보별 거리/내 평가/그린피/시간대 원시 데이터 (가중치 계산은 프론트에서) |
| GET | `/api/bookings` | 예약 기록 전체 목록 |
| POST | `/api/bookings` | 예약 기록 추가 |
| PUT | `/api/bookings/:id` | 예약 기록 수정 |
| DELETE | `/api/bookings/:id` | 예약 기록 삭제 |
| POST | `/api/bookings/parse-message` | 예약확정 메시지 텍스트 → AI 파싱 + 기존 가예약 자동 매칭 (저장은 안 함, 검토용) |
| POST | `/api/bookings/:id/confirm` | 매칭된 가예약을 확정 처리 + 같은 그룹 나머지 건 자동 "취소 검토 대상" 표시 |

### 골팡(golfpang.com) 연동 참고

`/web/round/booking_tblList.do`(본인예약)·`/web/round/join_tblList.do`(조인/백업)는 공식 API가 아니라, 골팡
검색 페이지가 로그인 세션 없이 호출하는 내부 엔드포인트를 그대로 재현한 것이다 (`Referer` + `X-Requested-With`
헤더만 있으면 응답). 응답은 JSON이 아니라 HTML 테이블 조각이라 `src/golfpang.js`에서 정규식으로 파싱한다.
사이트 구조가 바뀌면 파싱이 깨질 수 있으니, 검색 결과가 비정상적이면 가장 먼저 이 파서를 점검할 것.

### 골프몬(golfmon.net) 연동 참고

`/api/booking/transfer_join_location`은 골팡과 마찬가지로 로그인 세션 없이 호출되는 내부 API를 그대로
재현한 것이다 (`src/golfmon.js`). 골팡과 달리 응답이 이미 JSON이라 파싱 부담이 없다. 지역코드
(`location_fk`)·시간대(`teeOffBuckets`)·캐디유형(`caddyTypes`) 값은 골프몬 프론트엔드 번들에 하드코딩된
enum을 그대로 옮겨온 것이라 신뢰할 수 있다. 다만 특정 골프장을 지정하지 않은 "본인예약(부킹)" 지역 전체검색
(`/api/search/booking`)은 실제 캡처에서 검증되지 않아 1차 버전에서는 "양도/조인" 검색만 지원한다.

### 카카오골프예약(kakao.golf) 연동 참고

`/api/tee-time/search`도 비로그인 상태(`GET /api/auth/kakao/user` → `{authenticated:false}`)에서 정상
동작하는 것을 확인했다 (`src/kakaogolf.js`). 단, 이 엔드포인트는 **골프장 단위 요약**만 반환하고 골프장명은
내려주지 않는다 — 프론트엔드 번들에서 상세 조회용 `/api/tee-time/detail` 엔드포인트를 확인했으나 실제 호출을
캡처하지 못해 요청/응답 형식이 검증되지 않았다. 그래서 현재 `courseName`은 `골프장 #{golfInfoSeq}`로만
표시된다 — 실제 골프장명이 필요하면 카카오골프예약에서 특정 골프장 상세 화면을 열어 HAR을 한 번 더 캡처해서
`/api/tee-time/detail`의 요청/응답을 확인한 뒤 `src/kakaogolf.js`에 연동을 추가해야 한다. 지역코드
(`areas1s`)도 `1`(서울/경기)만 실제 요청으로 확인했고 나머지 5개는 번들 내 지역 목록 순서로 유추한 값이다.

### 예약확정 메시지 파싱 참고

`/api/bookings/parse-message`는 `ANTHROPIC_API_KEY`(위 4번 항목, MVP3에서 이미 등록했다면 그대로 재사용)로
Claude에게 텍스트를 구조화 출력(`output_config.format`)으로 보내 파싱한다. 같은 골프장·같은 날짜의 "가예약"
기록이 있으면 매칭 결과를 함께 반환하지만, 실제 저장/확정은 `/api/bookings/:id/confirm` 호출 시점에만
일어난다 — 스코어카드 인식과 동일하게 "확인/수정 화면을 거친 뒤 저장" 원칙을 따른다.

## 다음 단계

- 무거운 데이터(원본 사진, 백업)를 위한 Cloudflare Tunnel 경유 NAS 연동
- 다른 예약 플랫폼(카카오골프예약, 골프산, 골프몬 등) 확장 검토
