# JD Golf Hub - Backend (Cloudflare Worker)

JD Times의 "Cloudflare Worker 단일 진입점" 패턴을 재사용한 개인용 골프 허브 백엔드.

- MVP1: 날씨(+복장 추천), 스코어 수동입력, 기본 통계
- MVP2: 카카오맵 연동(장소 검색·맛집·길찾기 딥링크), 골프장 마스터 DB, 동반자 관리, 정산 계산
- MVP3: Claude Vision 이미지 인식(스코어카드/화면캡처/영수증), 출처·라운드종류 태그, 통계 필터링
  (※ 2026-08 제거됨 - 아래 참고)
- MVP4: 골프장 조건검색(골팡 비로그인 프록시), 동반예약(백업) 비교 그룹, 가중치 기반 점수 추천
- MVP5: 예약확정 메시지 붙여넣기 AI 파싱(※ 2026-08부터 정규식 기반으로 전환, 아래 참고), 가예약↔확정
  자동 매칭, 취소마감 리마인드, 예약 현황 리포트

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
2. **"기상청_단기예보 조회서비스"**(https://www.data.go.kr/data/15084084/openapi.do, "(구)_동네예보"가 아님!)
   검색 → 활용신청. "(구)" 붙은 옛 리스팅은 별개 상품이라 여기서 승인받은 서비스키로는 호출이 안 된다
   (`SERVICE_KEY_IS_NOT_REGISTERED_ERROR`) — 두 API가 같은 계정 인증키를 쓰더라도 상품별로 활용신청을
   각각 승인받아야 한다.
3. 개발계정은 신청 즉시 승인, 인증키(Encoding/Decoding) 발급
4. 3~10일 뒤 중기예보까지 쓰려면 아래 두 상품도 추가로 활용신청 (같은 계정 인증키 재사용, 별도 키 등록 불필요):
   - [기상청_중기예보 조회서비스](https://www.data.go.kr/data/15059468/openapi.do) — getMidLandFcst/getMidTa
   - [기상청_예보구역정보 조회서비스](https://www.data.go.kr/data/15057111/openapi.do) — 지역코드 확인용(런타임에는 안 씀, 코드표 검증에만 사용했음)
5. **Decoding 값**을 아래 명령으로 등록 (평문 저장 금지, 반드시 secret)

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

### 4. 배포

```bash
npm run deploy
```

## API

| Method | Path | 설명 |
|---|---|---|
| GET | `/api/weather?lat=&lon=&date=` | 시간대별 단기예보(오늘~모레) + 복장 추천. date 생략 시 오늘 |
| GET | `/api/weather/midterm?lat=&lon=&date=` | 오전/오후 단위 중기예보(3~10일 뒤) + 복장 추천 |
| GET | `/api/scores` | 스코어 기록 전체 목록 |
| POST | `/api/scores` | 스코어 기록 추가 |
| PUT | `/api/scores/:id` | 스코어 기록 수정 |
| DELETE | `/api/scores/:id` | 스코어 기록 삭제 |
| GET | `/api/stats?source=&roundType=` | 최근10 평균/베스트/코스별 평균/트렌드 (출처·라운드종류 필터링 가능) |
| GET | `/api/settings` | 개인 설정(집 주소 좌표) 조회 |
| PUT | `/api/settings` | 개인 설정 수정 |
| GET | `/api/places/search?query=` | 카카오 키워드 장소 검색 (골프장 등록 자동완성). 집 주소가 설정돼 있으면 각 결과에 자동차 거리/이동시간(driveDistanceKm/driveDurationMin)도 함께 내려줌 |
| GET | `/api/homepage-search?query=` | 카카오 웹검색으로 골프장 홈페이지 URL 후보 목록(제목/URL) 반환 - 1등 결과가 공식 사이트가 아닌 경우가 흔해 자동 채움 대신 후보만 제공 |
| GET | `/api/golf-db?region=&type=` | 문체부 전국 골프장 현황 목록 (지역/구분 필터) |
| GET | `/api/golf-db/search?query=&region=&type=` | 위 DB 이름 검색 (골프장 등록 자동완성용) |
| GET | `/api/golf-db/regions` | 지역별 건수 (탐색 화면 드롭다운용) |
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
| GET | `/api/golfpang/search?date=&ampm=&sector=&mode=&caddyType=` | 골팡 비로그인 조회 프록시 (`mode`: booking/join, `caddyType`: 0=일반캐디/1=운전캐디/2=노캐디/3=인턴캐디) |
| GET | `/api/golfmon/search?date=&locationFk=&teeOffBuckets=&caddyTypes=` | 골프몬 비로그인 조회 프록시 (양도/조인, 콤마구분 다중선택) |
| GET | `/api/kakaogolf/search?date=&areas=&timeZones=&visitorCnt=&events=&greenFees=&holeCnt=` | 카카오골프예약 비로그인 조회 프록시 (`areas`/`timeZones`/`events`/`greenFees`는 콤마구분 다중선택, `visitorCnt`는 단일값) |
| GET | `/api/kakaogolf/detail?golfInfoSeq=&date=&timeZone=&visitorCnt=` | 카카오골프예약 특정 골프장의 실제 예약 가능 티타임 목록 (검색 결과 클릭 시 온디맨드 조회) |
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
| POST | `/api/bookings/parse-message` | 예약확정 메시지 텍스트 → 정규식/키워드 규칙 파싱 + 기존 가예약 자동 매칭 (저장은 안 함, 검토용) |
| POST | `/api/bookings/:id/confirm` | 매칭된 가예약을 확정 처리 + 같은 그룹 나머지 건 자동 "취소 검토 대상" 표시 |

### 기상청 단기예보 연동 참고

날씨 탭이 "HTTP 400"으로 죽어있던 적이 있었는데, 원인이 두 겹이었다:
1. 요청 URL 경로가 `VilageFcstInfoService2.0`으로 되어 있었는데 실제로는 `VilageFcstInfoService_2.0`
   (2.0 앞에 언더스코어)이어야 한다. 언더스코어가 없으면 기상청 API가 `NO_OPENAPI_SERVICE_ERROR`
   ("해당 오픈API 서비스가 없거나 폐기됨")로 응답한다 — 마치 서비스 자체가 폐기된 것처럼 보이는 오해하기
   쉬운 에러라 URL 오타를 의심하기 전에 "API가 없어졌나?"로 잘못 짚기 쉽다.
2. URL을 고친 뒤에는 `SERVICE_KEY_IS_NOT_REGISTERED_ERROR`가 나왔는데, 이건 등록된 `KMA_API_KEY`가
   "기상청_단기예보 ((구)_동네예보) 조회서비스"(구버전 리스팅)에 대해서만 활용신청 승인이 나 있고,
   실제로 호출하는 "기상청_단기예보 조회서비스"(id: 15084084, 신버전 리스팅)에는 별도 활용신청을 안 해서
   생긴 문제였다 — 공공데이터포털은 계정 인증키 자체는 공용이어도 **API 상품별로 활용신청 승인을 따로
   받아야 한다**. `fetchWeather`가 KMA 응답 바디를 그대로 에러 메시지에 실어 보내므로, 이후 비슷한 문제가
   생기면 `/api/weather?lat=&lon=` 응답의 `error` 필드에 찍히는 `returnAuthMsg`/`returnReasonCode`를
   바로 확인하면 된다.

### 기상청 중기예보(3~10일 뒤) 연동 참고

`getMidLandFcst`(하늘상태/강수확률)와 `getMidTa`(기온)는 둘 다 `regId` 파라미터를 받지만 **같은 도(道)여도
서로 다른 급의 코드를 요구한다** — 이게 이 기능에서 가장 헷갈렸던 부분:
- `getMidLandFcst`는 도 단위 코드(예: 서울.인천.경기 = `11B00000`)를 쓰면 정상적으로 하늘상태/강수확률이 나온다.
- `getMidTa`는 **같은 도 단위 코드를 넣으면 에러 없이 `resultCode:00`을 주면서도 기온 필드가 전부 0으로 비어있다**
  (완전히 잘못된 값인데 에러가 안 나서 제일 위험한 실패 모드였다 — 요청은 "성공"한 것처럼 보이는데 데이터가
  가짜였음). 실제로는 그 도의 **대표 관측지점(station) 코드**가 필요하고(예: 서울 = `11B10101`), 이건
  region보다 한 단계 더 자세한 leaf 노드다.
- 이 station 코드는 흔히 알려진 "108=서울" 같은 정수 하나가 아니라, `FcstZoneInfoService/getFcstZoneCd`
  응답에서 `regSp:'C'`이고 `stnF3`(그 108 스타일 정수)가 채워진 항목의 **`regId` 문자열 전체**
  (예: `11B10101`, `stnF3:108`)를 써야 한다 — `stnF3` 숫자 자체를 `regId`로 넣으면 `NO_DATA`가 난다.
  `MID_REGIONS`(`src/weather.js`)에 박아넣은 코드들은 전부 이 방식으로 실제 API 응답을 조회해서 검증한
  값이고, 절대 문서/블로그의 예시값을 그대로 베끼지 않았다(그런 값들 중 상당수가 이미 폐기/변경된 상태였음).
- 강원도는 영서/영동이 시/도명이 같아서 카카오 역지오코딩의 시/군/구 이름(강릉/동해/삼척/속초/고성/양양 =
  영동, 나머지 = 영서)으로 한 번 더 갈랐다.
- 응답 필드는 `wf{N}Am/Pm`·`rnSt{N}Am/Pm`(3~7일, 오전/오후 구분)와 `wf{N}`·`rnSt{N}`(8~10일, 종일
  단위)로 나뉘는데, tmFc 발표 직후(예: 오늘 23시대에 18시 발표분 조회)엔 3~4일 필드가 아직 비어있는 경우가
  있었다(단기예보와 겹치는 구간이라 그런 듯) — 그래서 3일 뒤 요청 시 데이터가 없을 수 있고, 이땐 애매하게
  0을 보여주지 말고 "다음 발표 이후 다시 확인해달라"는 에러를 명시적으로 던지게 했다.

### 문화체육관광부 전국 골프장 현황 DB 참고

`src/data/golfCourseDB.json`(541개 골프장, 기준일 2024-12-31)은 `data.go.kr`이 아니라 사용자가 직접
채팅으로 첨부한 CSV에서 만들었다. 채팅 첨부 경로로 받은 최초 텍스트는 한글이 절반 가까이(약 48%) `U+FFFD`로
깨져 있었고, 사용자가 CSV를 UTF-8로 재저장해서 다시 첨부해도 **동일하게 깨진 텍스트**가 그대로 왔다 —
즉 원인이 사용자의 저장 방식이 아니라 **채팅 첨부 파일의 텍스트 추출 파이프라인** 쪽이었다(어느 단계에서
바이트가 통째로 유실되는 손실 인코딩 변환을 거치는 것으로 보임, 정확한 원인은 특정 못 함). 이 경로로는
알고리즘적으로 복구가 불가능해서(유실된 바이트는 어떤 재인코딩 시도로도 못 살림), 사용자에게 파일을
`data/` 폴더에 직접 넣어달라고 요청해 **파일시스템에서 직접 읽는 방식**으로 우회했다 — 이렇게 읽은 파일은
BOM 포함 정상 UTF-8이었다. **앞으로도 한글 CSV/텍스트 파일은 채팅 첨부보다 파일시스템 경유가 안전하다.**

`src/golfCourseDB.js`의 `normalizeCourseName()`은 프론트(`index.html`)의 동명 함수와 규칙을 반드시
동일하게 유지해야 한다 — 골팡/카카오골프예약 각 플랫폼 응답에 `officialName` 필드를 채워 넣어 크로스 플랫폼
매칭(프론트의 `mergeGolfpangTeeTimes`/`groupBookingRounds`)에 쓰는데, 규칙이 어긋나면 오히려 매칭이
깨진다. `findBestMatch()`는 정규화명이 정확히 일치하거나(동명이인 있으면 지역 없이는 매칭 안 함), 포함
관계로 **후보가 정확히 1개**일 때만 매칭시킨다 — 애매하면 틀린 골프장에 갖다붙이느니 매칭 안 하는 쪽을
택했다. 실제 골팡 100건 검색 기준 매칭률 약 82%였고, 매칭 안 된 나머지는 대부분 골프존 스크린골프 등
문체부 DB에 없는(정규 골프장이 아닌) 시설이었다.

### 골팡(golfpang.com) 연동 참고

`/web/round/booking_tblList.do`(본인예약)·`/web/round/join_tblList.do`(조인/백업)는 공식 API가 아니라, 골팡
검색 페이지가 로그인 세션 없이 호출하는 내부 엔드포인트를 그대로 재현한 것이다 (`Referer` + `X-Requested-With`
헤더만 있으면 응답). 응답은 JSON이 아니라 HTML 테이블 조각이라 `src/golfpang.js`에서 정규식으로 파싱한다.
사이트 구조가 바뀌면 파싱이 깨질 수 있으니, 검색 결과가 비정상적이면 가장 먼저 이 파서를 점검할 것.

캐디유무 필터(`cdOrder`)는 검색 폼에 이미 있던 필드인데 처음엔 항상 빈 문자열로 보내고 있었다 — 실제 캡처로
확인한 검색 폼의 `cadyChk` 셀렉트가 `onchange="cdOrder(this.value)"`로 이 필드에 값을 그대로 넣는 구조라,
값(0=일반캐디, 1=운전캐디, 2=노캐디, 3=인턴캐디)을 그대로 전달하면 된다. 직접 curl로 검증: `cdOrder=2`로
보내면 100건 중 66건이 전부 노캐디로만 걸러진다.

### 골프몬(golfmon.net) 연동 참고

`/api/booking/transfer_join_location`은 골팡과 마찬가지로 로그인 세션 없이 호출되는 내부 API를 그대로
재현한 것이다 (`src/golfmon.js`). 골팡과 달리 응답이 이미 JSON이라 파싱 부담이 없다. 지역코드
(`location_fk`)·시간대(`teeOffBuckets`)·캐디유형(`caddyTypes`) 값은 골프몬 프론트엔드 번들에 하드코딩된
enum을 그대로 옮겨온 것이라 신뢰할 수 있다. 다만 특정 골프장을 지정하지 않은 "본인예약(부킹)" 지역 전체검색
(`/api/search/booking`)은 실제 캡처에서 검증되지 않아 1차 버전에서는 "양도/조인" 검색만 지원한다.

### 카카오골프예약(kakao.golf) 연동 참고

`/api/tee-time/search`도 비로그인 상태(`GET /api/auth/kakao/user` → `{authenticated:false}`)에서 정상
동작하는 것을 확인했다 (`src/kakaogolf.js`). 이 엔드포인트는 **골프장 단위 요약**(golfInfoSeq, 최저그린피,
매칭건수 등)만 반환하고 골프장명·개별 티타임·캐디유무·최소인원은 내려주지 않는다 — 대신:
- 골프장명·홀수·주소: 상세 조회 `POST /api/golf/view`(body: `{golfInfoSeq}`)를 실제 캡처로 확인해
  `fullName`·`holeCount`·`addressGibun`을 가져온다. 검색 결과에 있는 golfInfoSeq마다 병렬로 호출하되, 이름은
  사실상 바뀌지 않으므로 `GOLF_KV`에 영구 캐싱해 같은 골프장은 한 번만 조회한다(키: `kakaogolf:golfinfo:{seq}`).
- 캐디유무(및 이벤트 필터 전반): 처음엔 `filter.events`/`qfSeq` 둘 다 검증 방법이 잘못돼서 "필터가 안 먹는다"고
  잘못 결론 냈었다(아래 정정 참고). 실제로는 `filter.events`(1=식음료지원, 2=특가, 3=특별이벤트, 4=인터넷회원
  가입, 5=노캐디, 6=1인 그린피 면제, 복수선택 시 값 합산)가 정상 작동한다. 캐디유무 배지는 검색 요청에
  `events`가 이미 5(노캐디)를 포함하면 전체가 노캐디이므로 별도 조회 없이 바로 표시하고, 아니라면 같은 조건에
  `events:[...선택값, 5]`를 추가한 조회를 한 번 더 병렬로 날려 golfInfoSeq를 교차한다.
- 내장인원수: `filter.visitorCnt`(2/3/4) + `visitorCntFlag:3` + `visitorCnts:[값]`으로 실제 필터링된다(아래
  정정 참고). 단일 선택.
- 그린피 구간: `filter.greenFee`/`greenFeeList`(1=~9만원, 2=9~15만원, 4=15~20만원, 8=20만원~,
  16=홈페이지참조, 복수선택 시 값 합산 + `[0, ...선택값]` 리스트) — timeZone과 동일한 비트마스크 패턴.
- 티타임대: `filter.timeZone`/`timeZoneList`(1=새벽5~7시, 2=오전7~12시, 4=오후12~4시, 8=야간4~9시, 복수선택
  시 값 합산 + `[0, ...선택값]` 리스트) — 사용자가 실제 사이트에서 캡처한 요청으로 비트마스크 값까지 확정
  검증했다.
- 지역(세부): 대권역(`areas1s`: 1=서울/경기, 12=강원, 22=충청, 31=경상, 41=전라, 46=제주) 아래 세부권역이
  더 있다 — `POST /api/location/area`(body: `{appVersion:"0"}`, 인증 불필요)가 `{list:[{code, area1Name,
  area2Name, seq, status}]}` 형태로 전체 계층을 내려준다. `seq`가 `areas1s`에 넣는 실제 코드이고, `code:1`이
  대권역·`code:2`가 세부권역이다. `status:"1"`인 항목(강원 강릉권·양양권, 충청 서산권, 경상 상주권 등)은
  비활성이라 제외했다. 전체 목록은 `SUB_REGIONS`에 하드코딩해뒀다 — 값이 거의 안 바뀌는 마스터 데이터라
  매번 API를 부르는 대신 고정값을 쓴다.
- 개별 티타임(시간·인원·가격): `/api/tee-time/search`는 골프장 단위 요약만 주지만, 실제 캡처로
  `POST /api/tee-time/detail`(body: `{golfSeq, date, sigunguSeq, weekType, reservFlag, filter}`, `filter`는
  search와 동일한 형태)을 확인했다 — `bookTime`(HHmm)·`visitorCnt`/`maxVisitorCnt`(실제 신청/정원 인원)·
  `greenFeeDC`·`holeCntName` 등 개별 예약 가능 시간대가 그대로 내려온다. `sigunguSeq`도 search와 마찬가지로
  형식적 게이트라 값 무관하게 동작한다. 다만 검색 결과(최대 100여 건) **전체**에 대해 이 엔드포인트를 자동
  호출하면 Cloudflare Worker 서브리퀘스트 한도(무료 플랜 기준 요청당 50개)를 넘길 수 있어, `fetchKakaoGolfTeeTimes()`는
  프론트에서 사용자가 특정 골프장을 선택했을 때만(`/api/kakaogolf/detail`) 호출하는 온디맨드 구조로 뒀다.

**필터 검증 방법 관련 정정 (2026-08)**: 처음엔 `filter.timeZone`/`visitorCnt`/`greenFee`/`events`를 바꿔가며
검색해도 응답 `list`의 **항목 개수**가 똑같아서 "이 필드들은 서버에서 무시된다"고 결론 냈었는데, 이건 검증
방법 자체가 틀렸다. 실제로는 조건에 안 맞는 골프장이 목록에서 빠지는 게 아니라, **목록엔 그대로 남고 그
골프장의 `timeCnt`(매칭건수)·`minGreenFeeDC`(최저그린피)가 0으로 재계산**되어 온다 — 그래서 목록 길이만
비교하면 항상 똑같아 보인다. 사용자가 실제 사이트에서 타임존 필터를 바꿔가며 캡처해준 요청이 계기가 되어
`golfInfoSeq` 단위로 필드 값 자체를 비교해보니 필터마다 확연히 달랐다. 그래서 `searchKakaoGolfRounds()`는
응답에서 `timeCnt > 0`인 항목만 남기고 나머지는 걸러낸다(그렇지 않으면 "매칭 0건" 골프장이 결과에 섞여
나온다). **비슷한 유형의 검증을 할 땐 목록 길이가 아니라 항목별 필드 값을 비교할 것.**

**`sigunguSeq` 함정 (2026-08 확인)**: 이 필드가 빈 문자열이면 `resultCode: 200`으로 정상 응답하면서도
`list`가 항상 비어서 온다 — 에러 없이 조용히 실패하는 형태라 알아차리기 어렵다. 실제 캡처로 대조해보니
`sigunguSeq`는 특정 시/군/구를 걸러내는 필터가 아니라 **"0이 아닌 값이 있는지"만 보는 형식적 게이트**였다
(`"459"`든 `"1"`이든 동일한 결과 개수가 나옴, `""`나 `"0"`이면 결과 없음). 그래서 `src/kakaogolf.js`는 실제
의미 없는 고정 placeholder(`"1"`)를 보낸다. 골프몬(`src/golfmon.js`)도 비슷한 시기에 `Accept`/
`Accept-Language`/`User-Agent` 헤더가 없으면 403을 반환하도록 바뀌었다 — 이런 내부 API는 사이트 쪽 변경으로
예고 없이 깨질 수 있으니, 검색 결과가 비정상(빈 배열/에러)이면 이 두 파일부터 최소 요청 형태가 여전히 맞는지
점검할 것.

### 예약확정 메시지 파싱 참고

원래는 Claude API(구조화 출력)로 파싱했는데, Anthropic API 크레딧 의존을 없애기 위해
`src/messageParsing.js`를 정규식/키워드 기반 규칙 파서로 다시 작성했다(2026-08).
`[대괄호]` 안 텍스트나 "OOCC/컨트리클럽" 패턴으로 골프장명 후보를 뽑고, `golfCourseDB.js`의
`findBestMatch()`로 문체부 공식 DB와 매칭되면 정식 명칭으로 정리한다. "[용인 세현컨트리클럽]"처럼
지역명이 앞에 붙어있으면 전체 문자열로는 매칭이 애매해질 수 있다(예: "용인"만 떼도 실제로 존재하는
"용인CC"와 겹쳐버려 `findBestMatch`가 일부러 매칭을 포기함) — 그래서 공백 기준으로 앞 단어를 하나씩
떼어가며 재시도해서("세현컨트리클럽"만 남으면 유일하게 매칭됨), 그래도 안 되면 원문 그대로 둔다.
날짜/시간/전화번호/홈페이지 URL/취소가능여부/취소마감/예약번호 등도 정규식으로 뽑는다.

그린피/카트비/캐디피처럼 금액 필드는 함정이 있었다 - "카트비 1팀 12만원"처럼 금액 앞에 "N팀"이
끼어있으면 `[^\d]{0,N}` 방식의 정규식은 "1"(팀 수)을 금액으로 잘못 잡아버린다. "(?:\d+팀)?" 처럼
숫자+"팀" 조합을 먼저 건너뛰게 명시해야 한다. 그린피는 "그린피"라는 단어가 명시돼 있으면 그 금액을,
없으면 "인터넷회원" 요금을 우선 채택한다(회원 가입 후 적용받는 표준 요금인 경우가 많아서) - 그래도
없으면(예: "회원"/"비회원" 요금만 나열된 경우) 어떤 게 내 요금인지 규칙만으로 판단 불가능해서
값을 채우지 않고 빈 채로 둔다. 어차피 프론트가 `openBookingReviewDialog`로 "검토 후 저장"을 항상
거치게 되어 있어서, LLM 파싱보다 정확도는 낮아도 사용자가 저장 전에 빈 칸/오류를 고칠 수 있다.
같은 골프장·같은 날짜의 "가예약" 기록이 있으면 매칭 결과를 함께 반환하지만, 실제 저장/확정은
`/api/bookings/:id/confirm` 호출 시점에만 일어난다.

**예약 기록에 자동으로 채워지는 부가정보** (`bookings.js`): 카트비/캐디피(팀 전체 금액)·정산
인원(본인 포함)을 저장해두면 프론트가 "그린피(1인) + 캐디피/정산인원 + 카트비/정산인원"으로 1인
예상 비용을 계산해서 카드에 보여준다. 집~골프장 자동차 거리·이동시간(`distanceKm`/`durationMin`)은
`courseName`이 새로 생기거나 바뀔 때(또는 이 기능 추가 전에 만들어져 값이 아직 없는 기존 기록을
수정할 때) 카카오 검색으로 좌표를 찾고 `kakao.js`의 `fetchDrivingRoute()`로 자동 계산해서 채운다 -
매번 저장할 때마다 다시 계산하지 않도록 이미 값이 있고 골프장명이 안 바뀌면 건너뛴다.

(참고: 이전에 있던 Claude Vision 기반 이미지 인식 기능(스코어카드/영수증 등, `/api/vision/recognize`,
`src/vision.js`)은 통째로 제거했다 — 지금은 `ANTHROPIC_API_KEY`를 쓰는 기능이 하나도 없다.)

## 다음 단계

- 무거운 데이터(원본 사진, 백업)를 위한 Cloudflare Tunnel 경유 NAS 연동
- 다른 예약 플랫폼(카카오골프예약, 골프산, 골프몬 등) 확장 검토
