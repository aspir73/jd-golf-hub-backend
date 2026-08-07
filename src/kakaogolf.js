// 카카오골프예약(kakao.golf) 비로그인 조회 프록시. `/api/auth/kakao/user`가 비로그인(guest) 상태에서도
// `/api/tee-time/search`가 정상 동작하는 것을 실제 네트워크 캡처(HAR)로 확인했다 (요청에 쿠키/인증 헤더 없음).
//
// 이 엔드포인트는 개별 티타임이 아니라 "골프장 단위 요약"(golfInfoSeq, 최저그린피, 매칭건수 등)을 반환하고
// 골프장명은 포함하지 않는다 — 골프장명·홀수는 /api/golf/view로, 개별 시간대는 /api/tee-time/detail로 따로
// 조회한다(아래 함수들 참고).
//
// filter(timeZone/visitorCnt/greenFee/events) 검증 참고 (2026-08): 처음엔 이 필드들을 바꿔도 "목록 개수"가
// 그대로라 필터가 안 먹는 줄 알았는데, 이건 잘못된 검증 방법이었다 — 실제로는 골프장이 목록에서 빠지는 게
// 아니라 각 golfInfoSeq 항목의 timeCnt/minGreenFeeDC 값 자체가 그 필터 기준으로 재계산되어 내려온다(매칭이
// 없으면 timeCnt:0, minGreenFeeDC:0). 그래서 실제 사용할 땐 timeCnt===0인 항목을 걸러내야 "필터링된 결과"
// 처럼 보인다. 실제 캡처(사용자 제공)로 timeZone 비트마스크(1/2/4/8)까지 확정 검증했고, visitorCnt·greenFee·
// events도 같은 방식으로 값이 실제로 달라지는 것을 직접 확인했다.

const KAKAOGOLF_BASE = 'https://www.kakao.golf';

// 대권역. 실제 /api/location/area 응답(POST, body {appVersion:"0"})으로 전수 확인.
export const REGIONS = [
  { code: '', label: '전체' },
  { code: '1', label: '서울/경기' },
  { code: '12', label: '강원' },
  { code: '22', label: '충청' },
  { code: '31', label: '경상' },
  { code: '41', label: '전라' },
  { code: '46', label: '제주' },
];

// 세부권역. /api/location/area 응답에서 status:"0"(활성)인 항목만 추림 — status:"1"인 비활성 항목
// (강원 강릉권·양양권, 충청 서산권, 경상 상주권 등)은 제외했고, 사용자가 실제 사이트에서 확인한 목록과
// 정확히 일치한다.
export const SUB_REGIONS = [
  { code: 3, majorCode: 1, label: '가평권' },
  { code: 6, majorCode: 1, label: '남양주권' },
  { code: 10, majorCode: 1, label: '수원권' },
  { code: 9, majorCode: 1, label: '안성권' },
  { code: 11, majorCode: 1, label: '여주권' },
  { code: 8, majorCode: 1, label: '용인권' },
  { code: 7, majorCode: 1, label: '인천권' },
  { code: 4, majorCode: 1, label: '파주권' },
  { code: 5, majorCode: 1, label: '포천권' },
  { code: 19, majorCode: 12, label: '동해권' },
  { code: 18, majorCode: 12, label: '속초권' },
  { code: 15, majorCode: 12, label: '원주권' },
  { code: 14, majorCode: 12, label: '춘천권' },
  { code: 20, majorCode: 12, label: '평창권' },
  { code: 28, majorCode: 22, label: '대전권' },
  { code: 27, majorCode: 22, label: '부여권' },
  { code: 29, majorCode: 22, label: '진천권' },
  { code: 26, majorCode: 22, label: '천안권' },
  { code: 30, majorCode: 22, label: '충주권' },
  { code: 24, majorCode: 22, label: '태안권' },
  { code: 35, majorCode: 31, label: '경주권' },
  { code: 39, majorCode: 31, label: '남해권' },
  { code: 33, majorCode: 31, label: '대구권' },
  { code: 36, majorCode: 31, label: '부산권' },
  { code: 38, majorCode: 31, label: '안동권' },
  { code: 37, majorCode: 31, label: '양산권' },
  { code: 45, majorCode: 41, label: '광주권' },
  { code: 43, majorCode: 41, label: '순천권' },
  { code: 44, majorCode: 41, label: '전주권' },
  { code: 48, majorCode: 46, label: '제주권' },
];

// 티타임대. 프론트엔드 번들(CugUv3Fp.js)에 하드코딩된 값 그대로 — 비트마스크(복수선택 시 합산).
export const TIME_ZONES = [
  { value: 1, label: '새벽(5~7시)' },
  { value: 2, label: '오전(7~12시)' },
  { value: 4, label: '오후(12~4시)' },
  { value: 8, label: '야간(4~9시)' },
];

// 내장인원수(최소 인원 조건). 단일 선택.
export const VISITOR_COUNTS = [
  { value: 2, label: '2인 이상' },
  { value: 3, label: '3인 이상' },
  { value: 4, label: '4인 필수' },
];

// 이벤트. 복수선택 가능(값 합산). value:5(노캐디)는 캐디유무 배지에도 재사용한다.
export const EVENTS = [
  { value: 1, label: '식음료지원' },
  { value: 2, label: '특가' },
  { value: 3, label: '특별이벤트' },
  { value: 4, label: '인터넷회원가입' },
  { value: 5, label: '노캐디' },
  { value: 6, label: '1인 그린피 면제' },
];

// 그린피 구간. 비트마스크(복수선택 시 합산).
export const GREEN_FEE_RANGES = [
  { value: 1, label: '~9만원' },
  { value: 2, label: '9~15만원' },
  { value: 4, label: '15~20만원' },
  { value: 8, label: '20만원~' },
  { value: 16, label: '홈페이지참조' },
];

function areaLabel(code) {
  const major = REGIONS.find((r) => r.code === String(code));
  if (major) return major.label;
  const sub = SUB_REGIONS.find((r) => r.code === Number(code));
  return sub?.label || '';
}

// 골프장 상세(이름/주소/홀수 등) 조회. 실제 캡처로 확인: POST /api/golf/view, body {golfInfoSeq}.
// 이름은 사실상 바뀌지 않으므로 KV에 영구 캐싱해 같은 골프장은 검색할 때마다 다시 부르지 않는다.
function golfInfoKey(golfInfoSeq) {
  return `kakaogolf:golfinfo:${golfInfoSeq}`;
}

async function fetchGolfInfo(golfInfoSeq) {
  const res = await fetch(`${KAKAOGOLF_BASE}/api/golf/view`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: KAKAOGOLF_BASE,
      Referer: `${KAKAOGOLF_BASE}/golf/${golfInfoSeq}`,
    },
    body: JSON.stringify({ golfInfoSeq }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.resultCode !== 200) throw new Error(data.resultMsg || '알 수 없는 오류');
  return {
    name: data.fullName || '',
    holeCount: data.holeCount || '',
    address: data.addressGibun || '',
  };
}

/** 여러 golfInfoSeq를 병렬로 이름 해석. KV 캐시 우선, 없으면 조회 후 캐싱. 개별 실패는 무시(플레이스홀더 유지). */
async function resolveGolfInfoMap(env, golfInfoSeqs) {
  const uniqueSeqs = [...new Set(golfInfoSeqs)];
  const map = {};
  await Promise.all(
    uniqueSeqs.map(async (seq) => {
      try {
        const cached = await env.GOLF_KV.get(golfInfoKey(seq), 'json');
        if (cached) {
          map[seq] = cached;
          return;
        }
        const info = await fetchGolfInfo(seq);
        map[seq] = info;
        await env.GOLF_KV.put(golfInfoKey(seq), JSON.stringify(info));
      } catch {
        // 상세 조회 실패 시 "골프장 #번호" 플레이스홀더 유지(검색 결과 전체를 실패시키지 않음)
      }
    })
  );
  return map;
}

/** 골프장 하나의 실제 예약 가능 티타임 목록 조회. 실제 캡처로 확인: POST /api/tee-time/detail,
 * body {golfSeq, date, sigunguSeq, weekType, reservFlag, filter}. 검색 결과에는 골프장 단위 요약만 오고
 * 개별 시간대(bookTime)·인원(visitorCnt/maxVisitorCnt)은 이 엔드포인트에서만 나온다.
 * 검색 결과(최대 100여 건) 전체에 대해 자동으로 호출하면 Cloudflare Worker 서브리퀘스트 한도(무료 플랜
 * 기준 요청당 50개)를 넘길 수 있어, 사용자가 특정 골프장을 선택했을 때만 개별 호출하는 용도로 둔다. */
export async function fetchKakaoGolfTeeTimes(env, { golfInfoSeq, date, timeZone = 0, visitorCnt = 0 }) {
  if (!golfInfoSeq) throw new Error('golfInfoSeq가 필요합니다');
  if (!date) throw new Error('date(YYYY-MM-DD)가 필요합니다');
  const compactDate = date.replace(/-/g, '');

  const body = {
    golfSeq: Number(golfInfoSeq),
    date: compactDate,
    // 검색과 동일하게 형식적 게이트일 뿐 실제 지역 필터로 작동하지 않는 것을 확인함(sigunguSeq 값과
    // 무관하게 동일 결과) — 고정 placeholder 사용.
    sigunguSeq: 1,
    weekType: 0,
    reservFlag: 'N',
    filter: {
      greenFee: 0,
      greenFeeList: [0],
      timeZone,
      timeZoneList: timeZone ? [0, timeZone] : [0],
      orderForGolfClubListMode: 0,
      orderForTeeTimeListMode: 0,
      timeZoneDisable: 0,
      greenFeeDisable: 0,
      paymentMethodDisable: 0,
      visitorCntDisable: 0,
      eventEnable: false,
      paymentMethodFlag: 0,
      paymentMethodList: [],
      visitorCntFlag: visitorCnt ? 3 : 0,
      visitorCnts: visitorCnt ? [visitorCnt] : [],
      holeCnt: 0,
      holeCntFlag: 0,
      holeCntList: [],
      event: 0,
      events: [],
      isOnlyAvailableTeeTime: false,
      isOnlyCashBackTeeTime: false,
      isOnlyLowGuarantee: false,
      paymentMethod: '',
      visitorCnt,
    },
  };

  const res = await fetch(`${KAKAOGOLF_BASE}/api/tee-time/detail`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: KAKAOGOLF_BASE,
      Referer: `${KAKAOGOLF_BASE}/tee-time?date=${compactDate}&area=1&timeZone=${timeZone}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`카카오골프예약 티타임 조회 실패: HTTP ${res.status}`);
  const data = await res.json();
  if (data.resultCode !== 200) throw new Error(`카카오골프예약 응답 오류: ${data.resultMsg || '알 수 없는 오류'}`);

  return (data.list || []).map((item) => ({
    time: item.bookTime ? `${item.bookTime.slice(0, 2)}:${item.bookTime.slice(2)}` : '',
    courseSubName: item.CourseName || '',
    holes: item.holeCntName || (item.holeCnt ? `${item.holeCnt}홀` : ''),
    greenFee: item.greenFeeDC ?? null,
    visitorCnt: item.visitorCnt ?? null,
    maxVisitorCnt: item.maxVisitorCnt ?? null,
    cashback: item.cashbackYN === 'Y',
  }));
}

export async function searchKakaoGolfRounds(
  env,
  { date, areas = [], timeZones = [], visitorCnt = 0, events = [], greenFees = [], holeCnt = 0 }
) {
  if (!date) throw new Error('date(YYYY-MM-DD)가 필요합니다');
  const compactDate = date.replace(/-/g, '');
  const areas1s = areas.length ? areas.map(Number) : [1];
  const title = areas1s.map(areaLabel).filter(Boolean).join(', ') || '전체';

  function buildBody(eventsForRequest) {
    return {
      date: compactDate,
      qfSeq: '0',
      searchType: 2,
      lowGuarantee: 'N',
      selectedDates: null,
      flagCashBack: 'N',
      quickFilterTypeHistory: null,
      weekType: '1',
      areas1s,
      enterType: 'MAIN_AREA',
      searchSeq: '1',
      reservFlag: 'N',
      title,
      listType: '0',
      detailAreaText: '',
      filter: {
        greenFee: greenFees.reduce((a, b) => a + b, 0),
        greenFeeList: greenFees.length ? [0, ...greenFees] : [0],
        timeZone: timeZones.reduce((a, b) => a + b, 0),
        timeZoneList: timeZones.length ? [0, ...timeZones] : [0],
        orderForGolfClubListMode: 0,
        orderForTeeTimeListMode: 0,
        timeZoneDisable: 0,
        greenFeeDisable: 0,
        paymentMethodDisable: 0,
        visitorCntDisable: 0,
        eventEnable: eventsForRequest.length > 0,
        paymentMethodFlag: 0,
        paymentMethodList: [],
        visitorCntFlag: visitorCnt ? 3 : 0,
        visitorCnts: visitorCnt ? [visitorCnt] : [],
        holeCnt,
        holeCntFlag: 0,
        holeCntList: [],
        event: eventsForRequest.reduce((a, b) => a + b, 0),
        events: eventsForRequest,
        isOnlyAvailableTeeTime: false,
        isOnlyCashBackTeeTime: false,
        isOnlyLowGuarantee: false,
        paymentMethod: '',
        visitorCnt,
      },
      isOnlyCashBackCondition: 'false',
      golfinfos: [],
      searchName: title,
      areas2: [0],
      // 실제 캡처로 확인: sigunguSeq는 특정 시/군/구를 걸러내는 필터가 아니라 "0이 아닌 값이 있는지"만 보는
      // 형식적 게이트다 (빈 문자열/"0"이면 list가 항상 비어서 옴, "459"든 "1"이든 같은 결과 개수가 나옴).
      // 실제 시/군/구 코드를 모르므로 결과에 영향 없는 placeholder를 고정으로 보낸다.
      sigunguSeq: '1',
    };
  }

  async function runSearch(eventsForRequest) {
    const res = await fetch(`${KAKAOGOLF_BASE}/api/tee-time/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: KAKAOGOLF_BASE,
        Referer: `${KAKAOGOLF_BASE}/tee-time?area=${areas1s.join(',')}&date=${compactDate}`,
      },
      body: JSON.stringify(buildBody(eventsForRequest)),
    });
    if (!res.ok) throw new Error(`카카오골프예약 조회 실패: HTTP ${res.status}`);
    const data = await res.json();
    if (data.resultCode !== 200) throw new Error(`카카오골프예약 응답 오류: ${data.resultMsg || '알 수 없는 오류'}`);
    // 필터에 안 맞는 골프장도 목록엔 그대로 남고 timeCnt(매칭건수)만 0으로 내려온다 — 걸러낸다.
    return (data.list || []).filter((item) => (item.timeCnt || 0) > 0);
  }

  // 캐디유무 배지: 사용자가 이미 "노캐디" 이벤트를 필터로 선택했으면 결과 전체가 노캐디이므로 별도 조회가
  // 필요 없다. 아니라면 같은 조건 + 노캐디(5)만 추가한 조회를 한 번 더 해서 교차한다.
  const alreadyNoCaddieOnly = events.includes(5);
  const [list, noCaddieList] = await Promise.all([
    runSearch(events),
    alreadyNoCaddieOnly ? Promise.resolve(null) : runSearch([...events, 5]),
  ]);
  const noCaddieSeqs = alreadyNoCaddieOnly
    ? new Set(list.map((item) => item.golfInfoSeq))
    : new Set(noCaddieList.map((item) => item.golfInfoSeq));

  const golfInfoMap = await resolveGolfInfoMap(
    env,
    list.map((item) => item.golfInfoSeq)
  );

  const rounds = list.map((item) => {
    const info = golfInfoMap[item.golfInfoSeq];
    return {
      idx: String(item.golfInfoSeq),
      region: title,
      date,
      time: '',
      courseName: info?.name || `골프장 #${item.golfInfoSeq}`,
      holes: info?.holeCount ? `${info.holeCount}홀` : '',
      greenFee: item.minGreenFeeDC ?? item.minGreenFeeNO ?? null,
      nickname: '',
      caddyType: noCaddieSeqs.has(item.golfInfoSeq) ? '노캐디 가능' : '',
      category: `매칭 ${item.timeCnt ?? 0}건 · 평점 ${item.avgStarScore ?? '-'}`,
      contactPhone: '',
      distanceKm: item.totalDistance != null ? Math.round(item.totalDistance / 100) / 10 : null,
      views: null,
    };
  });

  return { mode: 'join', totalCount: rounds.length, rounds };
}
