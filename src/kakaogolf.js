// 카카오골프예약(kakao.golf) 비로그인 조회 프록시. `/api/auth/kakao/user`가 비로그인(guest) 상태에서도
// `/api/tee-time/search`가 정상 동작하는 것을 실제 네트워크 캡처(HAR)로 확인했다 (요청에 쿠키/인증 헤더 없음).
//
// 지역코드(areas1s)는 실제 요청 1건(area=1 → "서울/경기")만 직접 확인했고, 나머지 5개 코드는 프론트엔드
// 번들에 있는 지역 목록 순서(서울/경기·강원·충청·경상·전라·제주)로 유추한 값이라 100% 확정은 아니다.
//
// 이 엔드포인트는 개별 티타임이 아니라 "골프장 단위 요약"(golfInfoSeq, 최저그린피, 매칭건수 등)만 반환하고
// 골프장명은 포함하지 않는다. 번들 코드에서 상세 조회용 `/api/tee-time/detail` 엔드포인트를 확인했으나
// 이번 캡처에는 실제 호출 기록이 없어 요청/응답 형식을 검증하지 못했다 — 골프장명이 꼭 필요하면 상세 화면을
// 열어 HAR을 한 번 더 캡처해서 확인해야 한다. 그 전까지 courseName은 "골프장 #{golfInfoSeq}"로 대체 표시한다.

const KAKAOGOLF_BASE = 'https://www.kakao.golf';

export const REGIONS = [
  { code: '', label: '전체' },
  { code: '1', label: '서울/경기' },
  { code: '12', label: '강원' },
  { code: '22', label: '충청' },
  { code: '31', label: '경상' },
  { code: '41', label: '전라' },
  { code: '46', label: '제주' },
];

function regionLabel(code) {
  return REGIONS.find((r) => r.code === String(code))?.label || '';
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

export async function searchKakaoGolfRounds(
  env,
  { date, areas = [], timeZone = 0, visitorCnt = 0, greenFee = 0, holeCnt = 0 }
) {
  if (!date) throw new Error('date(YYYY-MM-DD)가 필요합니다');
  const compactDate = date.replace(/-/g, '');
  const areas1s = areas.length ? areas.map(Number) : [1];
  const title = areas1s.map(regionLabel).filter(Boolean).join(', ') || '전체';

  function buildBody(qfSeq) {
    return {
      date: compactDate,
      qfSeq,
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
        greenFee,
        greenFeeList: [],
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
        // 실제 캡처로 검증: visitorCnt/visitorCntFlag/visitorCnts는 이 검색 엔드포인트에서 결과를 전혀
        // 거르지 않는다(값을 바꿔도 동일한 골프장 목록이 나옴) — 요청 바디에는 남겨두되 결과 필터링 용도로는
        // 쓸 수 없다. 최소 인원(내장인원수) 정보는 이 API로 알아낼 방법이 없다.
        visitorCntFlag: visitorCnt ? 3 : 0,
        visitorCnts: visitorCnt ? [visitorCnt] : [],
        holeCnt,
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

  async function runSearch(qfSeq) {
    const res = await fetch(`${KAKAOGOLF_BASE}/api/tee-time/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: KAKAOGOLF_BASE,
        Referer: `${KAKAOGOLF_BASE}/tee-time?area=${areas1s.join(',')}&date=${compactDate}`,
      },
      body: JSON.stringify(buildBody(qfSeq)),
    });
    if (!res.ok) throw new Error(`카카오골프예약 조회 실패: HTTP ${res.status}`);
    const data = await res.json();
    if (data.resultCode !== 200) throw new Error(`카카오골프예약 응답 오류: ${data.resultMsg || '알 수 없는 오류'}`);
    return data.list || [];
  }

  // 개별 결과에는 캐디유무가 안 내려오지만, "노캐디" 퀵필터(qfSeq=42)로 같은 조건을 한 번 더 조회하면
  // 그 골프장 목록만 걸러져서 온다(실제 캡처로 검증) — 두 결과를 교차해서 캐디유무를 역으로 채운다.
  const [list, noCaddieList] = await Promise.all([runSearch('0'), runSearch('42')]);
  const noCaddieSeqs = new Set(noCaddieList.map((item) => item.golfInfoSeq));

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
