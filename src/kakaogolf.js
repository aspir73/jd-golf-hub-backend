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

export async function searchKakaoGolfRounds(
  env,
  { date, areas = [], timeZone = 0, visitorCnt = 0, greenFee = 0, holeCnt = 0 }
) {
  if (!date) throw new Error('date(YYYY-MM-DD)가 필요합니다');
  const compactDate = date.replace(/-/g, '');
  const areas1s = areas.length ? areas.map(Number) : [1];
  const title = areas1s.map(regionLabel).filter(Boolean).join(', ') || '전체';

  const body = {
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

  const res = await fetch(`${KAKAOGOLF_BASE}/api/tee-time/search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: KAKAOGOLF_BASE,
      Referer: `${KAKAOGOLF_BASE}/tee-time?area=${areas1s.join(',')}&date=${compactDate}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`카카오골프예약 조회 실패: HTTP ${res.status}`);
  const data = await res.json();
  if (data.resultCode !== 200) throw new Error(`카카오골프예약 응답 오류: ${data.resultMsg || '알 수 없는 오류'}`);

  const rounds = (data.list || []).map((item) => ({
    idx: String(item.golfInfoSeq),
    region: title,
    date,
    time: '',
    courseName: `골프장 #${item.golfInfoSeq}`,
    holes: '',
    greenFee: item.minGreenFeeDC ?? item.minGreenFeeNO ?? null,
    nickname: '',
    caddyType: '',
    category: `매칭 ${item.timeCnt ?? 0}건 · 평점 ${item.avgStarScore ?? '-'}`,
    contactPhone: '',
    distanceKm: item.totalDistance != null ? Math.round(item.totalDistance / 100) / 10 : null,
    views: null,
  }));

  return { mode: 'join', totalCount: rounds.length, rounds };
}
