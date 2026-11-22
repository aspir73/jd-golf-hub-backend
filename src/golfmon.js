// 골프몬(golfmon.net) 비로그인 조회 프록시. 골팡과 같은 방식(로그인 세션 없이 호출되는 내부 API를
// 그대로 재현)이지만, 응답이 이미 JSON이라 골팡처럼 HTML을 정규식으로 파싱할 필요가 없다.
// 실제 검색 시 브라우저 네트워크 캡처(HAR)로 확인한 요청/응답을 그대로 재현한다.
//
// 지역코드(location_fk)·시간대(teeOffBuckets)·캐디유형(caddyTypes) enum은 golfmon.net이 배포하는
// 프론트엔드 번들(index-*.js)에 하드코딩된 상수를 그대로 옮겨온 것이라 값 자체는 신뢰할 수 있다.
// 다만 "본인예약(부킹)" 검색(`/api/search/booking`)은 실제 캡처에서 특정 골프장(golfFk) 지정 검색만
// 관찰됐고 지역 전체검색용 파라미터 조합은 검증하지 못해 1차 버전에서는 "양도/조인" 검색만 지원한다.

const GOLFMON_BASE = 'https://www.golfmon.net';

export const REGIONS = [
  { code: '', label: '전체' },
  { code: '1', label: '경기북부' },
  { code: '2', label: '경기남부' },
  { code: '8', label: '경기동부' },
  { code: '9', label: '인천경인' },
  { code: '3', label: '충청' },
  { code: '4', label: '강원' },
  { code: '5', label: '전라' },
  { code: '6', label: '경상' },
  { code: '7', label: '제주' },
];

export const TEE_OFF_BUCKETS = [
  { code: 1, label: '1부 (새벽~09:59)' },
  { code: 2, label: '2부 (10:00~15:59)' },
  { code: 3, label: '3부 (16:00~야간)' },
];

const CADDY_LABELS = { 0: '캐디', 1: '노캐디', 2: '운전캐디', 3: '교육생캐디' };

// 위경도가 필요한 API라 개인 설정에 집 주소가 없으면 서울시청 좌표로 대체한다 (거리순 정렬용 기본값).
const DEFAULT_LAT = 37.5665;
const DEFAULT_LON = 126.978;

function regionLabel(code) {
  return REGIONS.find((r) => r.code === String(code))?.label || '';
}

/** "08/08(토) 17:14" 형태를 date/time으로 분리 */
function splitDateTime(str) {
  const s = str || '';
  const idx = s.lastIndexOf(' ');
  if (idx === -1) return { date: s, time: '' };
  return { date: s.slice(0, idx), time: s.slice(idx + 1) };
}

function toDistanceKm(str) {
  const m = (str || '').match(/[\d.]+/);
  return m ? Number(m[0]) : null;
}

/** mode: 현재 'join'(양도/조인)만 지원 */
export async function searchGolfmonRounds(
  env,
  { date, locationFk = '', teeOffBuckets = [], caddyTypes = [], homeLat, homeLon, page = 1 }
) {
  if (!date) throw new Error('date(YYYY-MM-DD)가 필요합니다');

  const latitude = homeLat ?? DEFAULT_LAT;
  const longitude = homeLon ?? DEFAULT_LON;

  const body = {
    transferJoinTypeID: 1,
    dates: date,
    location_fk: locationFk === '' ? undefined : Number(locationFk),
    latitude,
    longitude,
    teeOff: 0,
    greenFee: 0,
    sort: 'latest',
    page,
    teeOffBuckets: teeOffBuckets.map(Number),
    joinPeopleFilters: [],
    caddyTypes: caddyTypes.map(Number),
    priceRangeTypes: [],
    specialOptions: [],
  };

  const res = await fetch(`${GOLFMON_BASE}/api/booking/transfer_join_location`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: GOLFMON_BASE,
      Referer: `${GOLFMON_BASE}/booking/overlist?locationFk=${locationFk}&date=${date}&bookingType=1`,
      appType: 'W',
      // 골프몬이 최소한의 "브라우저다움" 검증(Accept/Accept-Language/User-Agent 존재 여부)을 추가한 것으로
      // 보여, 이 네 헤더가 모두 있어야 통과된다(하나라도 빠지면 403). 실제 값 자체보다 "존재"가 중요해 보이지만
      // 안전하게 실제 브라우저와 동일한 값을 보낸다.
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`골프몬 조회 실패: HTTP ${res.status}`);
  const data = await res.json();
  if (data.status !== 200) throw new Error(`골프몬 응답 오류: ${data.message || '알 수 없는 오류'}`);

  const content = data.data?.content || [];
  const rounds = content.map((item) => {
    const { date: d, time: t } = splitDateTime(item.date);
    return {
      idx: String(item.id),
      region: regionLabel(locationFk),
      date: d,
      time: t,
      courseName: item.ccName || '',
      holes: item.hole ? `${item.hole}홀` : '',
      greenFee: item.greenFee ?? null,
      nickname: item.managerName || '',
      caddyType: CADDY_LABELS[item.caddy] || '',
      category: item.target || (item.golfMon ? '골프몬' : ''),
      contactPhone: item.managerNumber || '',
      distanceKm: toDistanceKm(item.distance),
      views: null,
    };
  });

  return {
    mode: 'join',
    totalCount: data.data?.pagination?.totalElements ?? rounds.length,
    rounds,
  };
}
