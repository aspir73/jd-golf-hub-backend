// 기상청 단기예보 조회서비스(getVilageFcst) + 중기예보 조회서비스(getMidLandFcst/getMidTa) 연동
// 위경도 -> 격자좌표(nx, ny) 변환은 기상청이 공개한 Lambert Conformal Conic 변환 공식을 그대로 사용한다.

import { coordToRegion } from './kakao.js';

// 주의: 경로에 언더스코어가 들어간다 (VilageFcstInfoService_2.0). 언더스코어 없이 호출하면
// 기상청 API가 "NO_OPENAPI_SERVICE_ERROR(해당 오픈API 서비스가 없거나 폐기됨)"로 응답한다.
const KMA_ENDPOINT =
  'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst';

const MID_LAND_ENDPOINT = 'https://apis.data.go.kr/1360000/MidFcstInfoService/getMidLandFcst';
const MID_TA_ENDPOINT = 'https://apis.data.go.kr/1360000/MidFcstInfoService/getMidTa';

// 중기예보 지역코드. 기상청 "예보구역정보 조회서비스"(getFcstZoneCd)로 실제 응답을 직접 조회해서 검증한 값이다
// (코드를 추측해서 하드코딩하면 엉뚱한 지역 날씨를 보여줄 위험이 있어 반드시 실API 응답으로 확인 후 박아넣었다).
// - landRegId: getMidLandFcst(하늘상태/강수확률)용, 도(道) 단위 구역코드 (regSp:'A', regUp:'11000000')
// - taRegId: getMidTa(기온)용, 그 도의 대표 관측지점 코드 (regSp:'C', stnF3가 채워진 leaf 노드) —
//   land와 같은 도 단위 코드(예: 11B00000)를 넣으면 에러 없이 200이 오지만 기온값이 전부 0으로 비어있어서
//   반드시 station 단위 코드(예: 서울=11B10101)를 따로 써야 한다.
const MID_REGIONS = [
  { key: 'seoul', sido: ['서울특별시', '인천광역시', '경기도'], landRegId: '11B00000', taRegId: '11B10101', label: '서울.인천.경기' },
  { key: 'gangwon-west', sido: ['강원특별자치도', '강원도'], landRegId: '11D10000', taRegId: '11D10301', label: '강원영서' },
  { key: 'gangwon-east', sido: ['강원특별자치도', '강원도'], landRegId: '11D20000', taRegId: '11D20501', label: '강원영동' },
  { key: 'chungbuk', sido: ['충청북도'], landRegId: '11C10000', taRegId: '11C10301', label: '충청북도' },
  { key: 'chungnam', sido: ['충청남도', '대전광역시', '세종특별자치시'], landRegId: '11C20000', taRegId: '11C20401', label: '충청남도' },
  { key: 'jeonbuk', sido: ['전북특별자치도', '전라북도'], landRegId: '11F10000', taRegId: '11F10201', label: '전북' },
  { key: 'jeonnam', sido: ['전라남도', '광주광역시'], landRegId: '11F20000', taRegId: '11F20501', label: '전라남도' },
  { key: 'gyeongbuk', sido: ['경상북도', '대구광역시'], landRegId: '11H10000', taRegId: '11H10701', label: '경상북도' },
  { key: 'gyeongnam', sido: ['경상남도', '부산광역시', '울산광역시'], landRegId: '11H20000', taRegId: '11H20201', label: '경상남도' },
  { key: 'jeju', sido: ['제주특별자치도'], landRegId: '11G00000', taRegId: '11G00201', label: '제주도' },
];

// 강원도는 영서/영동이 같은 시/도명이라 시/군/구 이름으로 한 번 더 갈라야 한다 (기상청 보도자료 기준 해안 6개 시/군 = 영동).
const GANGWON_EAST_SIGUNGU = ['강릉시', '동해시', '삼척시', '속초시', '고성군', '양양군'];

function resolveMidRegionBySido(sido, sigungu) {
  if (sido && sido.includes('강원')) {
    return MID_REGIONS.find((r) => r.key === (GANGWON_EAST_SIGUNGU.includes(sigungu) ? 'gangwon-east' : 'gangwon-west'));
  }
  return MID_REGIONS.find((r) => r.sido.some((s) => sido && sido.startsWith(s.slice(0, 2))));
}

/** 골프장 좌표 -> 중기예보 지역(MID_REGIONS 중 하나). 카카오 역지오코딩 결과를 영구 캐싱(좌표 반올림 키)해서
 *  매번 카카오 API를 부르지 않게 한다 - 골프장 위치는 바뀌지 않으므로. */
async function resolveMidRegion(env, lat, lon) {
  const cacheKey = `weather:midregion:${lat.toFixed(3)},${lon.toFixed(3)}`;
  const cached = await env.GOLF_KV.get(cacheKey, 'json');
  if (cached) return cached;

  const geo = await coordToRegion(env, lat, lon);
  const region = geo ? resolveMidRegionBySido(geo.sido, geo.sigungu) : null;
  if (!region) {
    throw new Error(`이 좌표(${geo?.sido || '알 수 없음'})에 대응하는 중기예보 지역을 찾지 못했습니다.`);
  }
  await env.GOLF_KV.put(cacheKey, JSON.stringify(region), { expirationTtl: 60 * 60 * 24 * 365 });
  return region;
}

function resolveMidTmFc(nowUtc) {
  const kst = new Date(nowUtc.getTime() + 9 * 60 * 60 * 1000);
  const hh = kst.getUTCHours();
  const slot = hh >= 18 ? '1800' : '0600';
  // 06시 발표는 06:00~ 이후, 18시 발표는 18:00~ 이후에나 반영되므로 그 전이면 전 슬롯으로 보정
  let base = new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()));
  let chosenSlot = slot;
  if (hh < 6) {
    base = new Date(base.getTime() - 24 * 60 * 60 * 1000);
    chosenSlot = '1800';
  } else if (hh < 18) {
    chosenSlot = '0600';
  }
  const yyyy = base.getUTCFullYear();
  const mm = String(base.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(base.getUTCDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}${chosenSlot}`;
}

const GRID = {
  RE: 6371.00877, // 지구 반경(km)
  GRID_SIZE: 5.0, // 격자 간격(km)
  SLAT1: 30.0,
  SLAT2: 60.0,
  OLON: 126.0,
  OLAT: 38.0,
  XO: 43,
  YO: 136,
};

/** 위경도(lat, lon) -> 기상청 격자좌표(nx, ny) */
export function latLonToGrid(lat, lon) {
  const DEGRAD = Math.PI / 180.0;
  const re = GRID.RE / GRID.GRID_SIZE;
  const slat1 = GRID.SLAT1 * DEGRAD;
  const slat2 = GRID.SLAT2 * DEGRAD;
  const olon = GRID.OLON * DEGRAD;
  const olat = GRID.OLAT * DEGRAD;

  let sn = Math.tan(Math.PI * 0.25 + slat2 * 0.5) / Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) / Math.log(sn);
  let sf = Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sf = (Math.pow(sf, sn) * Math.cos(slat1)) / sn;
  let ro = Math.tan(Math.PI * 0.25 + olat * 0.5);
  ro = (re * sf) / Math.pow(ro, sn);

  let ra = Math.tan(Math.PI * 0.25 + (lat * DEGRAD) * 0.5);
  ra = (re * sf) / Math.pow(ra, sn);
  let theta = lon * DEGRAD - olon;
  if (theta > Math.PI) theta -= 2.0 * Math.PI;
  if (theta < -Math.PI) theta += 2.0 * Math.PI;
  theta *= sn;

  const nx = Math.floor(ra * Math.sin(theta) + GRID.XO + 0.5);
  const ny = Math.floor(ro - ra * Math.cos(theta) + GRID.YO + 0.5);
  return { nx, ny };
}

const BASE_TIMES = ['0200', '0500', '0800', '1100', '1400', '1700', '2000', '2300'];

/** 현재(KST) 기준 가장 최근 발표시각(base_date, base_time)을 계산. 발표 후 10분간은 아직 API 미반영이라 한 슬롯 전으로 보정 */
function resolveBaseDateTime(nowUtc = new Date()) {
  const kst = new Date(nowUtc.getTime() + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear();
  const m = kst.getUTCMonth();
  const d = kst.getUTCDate();
  const hh = kst.getUTCHours();
  const mm = kst.getUTCMinutes();

  const nowMinutes = hh * 60 + mm;
  let chosen = null;
  for (let i = BASE_TIMES.length - 1; i >= 0; i--) {
    const t = BASE_TIMES[i];
    const tMinutes = parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(2), 10);
    if (nowMinutes >= tMinutes + 10) {
      chosen = { date: new Date(Date.UTC(y, m, d)), time: t };
      break;
    }
  }
  if (!chosen) {
    // 오늘 첫 발표(02:10) 이전이면 전날 23시 발표분 사용
    const prev = new Date(Date.UTC(y, m, d - 1));
    chosen = { date: prev, time: '2300' };
  }

  const yyyy = chosen.date.getUTCFullYear();
  const mmv = String(chosen.date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(chosen.date.getUTCDate()).padStart(2, '0');
  return { base_date: `${yyyy}${mmv}${dd}`, base_time: chosen.time };
}

function kstTodayString(nowUtc = new Date()) {
  const kst = new Date(nowUtc.getTime() + 9 * 60 * 60 * 1000);
  const yyyy = kst.getUTCFullYear();
  const mm = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(kst.getUTCDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

/** kstTodayString과 같은 계산이지만 "YYYY-MM-DD"(대시 포함) 형식 - watches.js/priceDashboard.js처럼
 * roundDate/watch.date가 대시 포함 문자열인 곳에서 쓴다. Worker는 UTC로 실행되는데 `new
 * Date().toISOString().slice(0,10)`을 그대로 쓰면 한국(UTC+9) 기준 자정~오전 9시 사이엔 "오늘"이
 * 여전히 어제로 계산되는 버그가 있어서(프론트 index.html의 todayLocalStr와 같은 이유로 발견돼
 * 같이 고침) - "오늘 날짜"가 필요하면 이 함수를 쓸 것, toISOString 기반 today는 쓰지 말 것. */
export function kstTodayDateStr(nowUtc = new Date()) {
  const s = kstTodayString(nowUtc);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/** "2026-08-09"든 "20260809"든 받아서 8자리(YYYYMMDD)로 정규화. 형식이 이상하면 null */
function normalizeDateStr(input) {
  if (!input) return null;
  const digits = String(input).replace(/-/g, '');
  return /^\d{8}$/.test(digits) ? digits : null;
}

/** YYYYMMDD 문자열 사이의 날짜 차이(일수, targetStr - baseStr) */
function dateDiffDays(baseStr, targetStr) {
  const toUtcDate = (s) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
  return Math.round((toUtcDate(targetStr) - toUtcDate(baseStr)) / (24 * 60 * 60 * 1000));
}

const SKY_LABEL = { 1: '맑음', 3: '구름많음', 4: '흐림' };
const PTY_LABEL = { 0: '없음', 1: '비', 2: '비/눈', 3: '눈', 4: '소나기' };

/** getVilageFcst 응답을 시간대별로 정리 (targetDateStr 하루치 시간대만 추림) */
function groupByHour(items, targetDateStr) {
  const byTime = new Map();
  for (const it of items) {
    if (it.fcstDate !== targetDateStr) continue;
    const key = it.fcstTime;
    if (!byTime.has(key)) byTime.set(key, { time: key });
    const bucket = byTime.get(key);
    switch (it.category) {
      case 'TMP':
        bucket.temp = Number(it.fcstValue);
        break;
      case 'POP':
        bucket.pop = Number(it.fcstValue);
        break;
      case 'SKY':
        bucket.sky = SKY_LABEL[it.fcstValue] || '-';
        break;
      case 'PTY':
        bucket.pty = PTY_LABEL[it.fcstValue] || '없음';
        break;
      case 'WSD':
        bucket.wind = Number(it.fcstValue);
        break;
      case 'REH':
        bucket.humidity = Number(it.fcstValue);
        break;
      default:
        break;
    }
  }
  return Array.from(byTime.values()).sort((a, b) => a.time.localeCompare(b.time));
}

/** 기온/바람/강수확률 기반 라운드 복장 추천 (기획서 3-3 로직) */
export function recommendOutfit(hourly) {
  if (!hourly.length) return { summary: '예보 데이터 없음', items: [] };

  const temps = hourly.map((h) => h.temp).filter((v) => v != null);
  const winds = hourly.map((h) => h.wind).filter((v) => v != null);
  const pops = hourly.map((h) => h.pop).filter((v) => v != null);

  const avgTemp = temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : 15;
  const maxWind = winds.length ? Math.max(...winds) : 0;
  const maxPop = pops.length ? Math.max(...pops) : 0;

  let base;
  if (avgTemp >= 28) base = '반팔 폴로 + 통풍 좋은 소재, 자외선 차단 필수';
  else if (avgTemp >= 23) base = '반팔 또는 얇은 긴팔, 캡모자';
  else if (avgTemp >= 17) base = '긴팔 폴로 + 얇은 바람막이';
  else if (avgTemp >= 11) base = '긴팔 + 조끼 또는 얇은 니트';
  else if (avgTemp >= 5) base = '방한 자켓 + 이너레이어';
  else base = '두꺼운 방한복 + 장갑 + 넥워머';

  const items = [base];
  if (maxWind >= 8) items.push('바람이 강해요 - 윈드브레이커 추천');
  if (maxPop >= 60) items.push('비 올 확률이 높아요 - 우산/우비 준비');

  return {
    summary: `체감 ${Math.round(avgTemp)}℃${maxWind >= 8 ? ', 바람 강함' : ''}${maxPop >= 60 ? ', 비 소식' : ''}`,
    avgTemp: Math.round(avgTemp),
    maxWind,
    maxPop,
    items,
  };
}

/** GET /api/weather?lat=&lon=&date= 처리. env.KMA_API_KEY 필요.
 *  date를 생략하면 오늘(KST), 지정하면 그 날짜의 시간대별 예보를 돌려준다.
 *  기상청 단기예보(getVilageFcst)는 발표시각 기준 최대 약 3일치를 함께 내려주므로,
 *  base_date 기준 +3일까지 지원한다(실측 확인: 17시 발표 기준 +3일치 시간대별 데이터 290건
 *  정상 수신 - 예전엔 +2일로만 제한해뒀는데, 그러면 중기예보 쪽만 써야 하는 +3일(정확히 중기
 *  예보의 최솟값 경계)이 단기/중기 양쪽에서 다 비는 사각지대가 됐었다. 기상청 중기예보는 갓
 *  갱신된 최신 발표엔 3~4일 뒤 필드가 아직 안 채워진 경우가 실측으로 확인돼서, +3일은 아예
 *  단기예보 쪽으로 넘겨버리는 게 더 안전하다 - fetchMidTermWeather의 diff<4 경계와 맞물림).
 *  +3일보다 먼 날짜는 명확한 에러로 안내한다. */
export async function fetchWeather(env, lat, lon, date) {
  if (!env.KMA_API_KEY) {
    throw new Error('KMA_API_KEY가 설정되지 않았습니다 (wrangler secret put KMA_API_KEY)');
  }
  const { nx, ny } = latLonToGrid(lat, lon);
  const { base_date, base_time } = resolveBaseDateTime();

  const todayStr = kstTodayString();
  const targetStr = normalizeDateStr(date) || todayStr;
  const diff = dateDiffDays(base_date, targetStr);
  if (diff < 0) {
    throw new Error('과거 날짜는 조회할 수 없습니다.');
  }
  if (diff > 3) {
    throw new Error('기상청 단기예보는 오늘부터 3일 뒤까지만 제공됩니다. 더 먼 날짜는 임박해서 다시 확인해주세요.');
  }

  const url = new URL(KMA_ENDPOINT);
  url.searchParams.set('serviceKey', env.KMA_API_KEY);
  // 단기예보는 발표 1회당 최대 약 3일(67~87시간)치를 한꺼번에 내려준다.
  // 카테고리(TMP/POP/SKY/PTY/WSD/REH 등 12종) x 3일치를 다 담으려면 290행으로는 부족해서 1000으로 늉려잡는다.
  url.searchParams.set('numOfRows', '1000');
  url.searchParams.set('pageNo', '1');
  url.searchParams.set('dataType', 'JSON');
  url.searchParams.set('base_date', base_date);
  url.searchParams.set('base_time', base_time);
  url.searchParams.set('nx', String(nx));
  url.searchParams.set('ny', String(ny));

  const res = await fetch(url.toString());
  if (!res.ok) {
    const bodyText = await res.text().catch((e) => `(read err: ${e.message})`);
    const safeUrl = url.toString().replace(env.KMA_API_KEY, '***');
    throw new Error(
      `기상청 API 호출 실패: HTTP ${res.status} ${res.statusText} body="${bodyText.slice(0, 300)}" url=${safeUrl}`
    );
  }
  const data = await res.json();
  const header = data?.response?.header;
  if (!header || header.resultCode !== '00') {
    throw new Error(`기상청 API 오류: ${header?.resultMsg || '알 수 없는 오류'}`);
  }

  const items = data.response.body?.items?.item || [];
  const hourly = groupByHour(items, targetStr);
  const outfit = recommendOutfit(hourly);

  return { nx, ny, base_date, base_time, date: targetStr, hourly, outfit };
}

async function fetchMidRaw(env, endpoint, regId, tmFc) {
  const url = new URL(endpoint);
  url.searchParams.set('serviceKey', env.KMA_API_KEY);
  url.searchParams.set('numOfRows', '10');
  url.searchParams.set('pageNo', '1');
  url.searchParams.set('dataType', 'JSON');
  url.searchParams.set('tmFc', tmFc);
  url.searchParams.set('regId', regId);
  const res = await fetch(url.toString());
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new Error(`기상청 중기예보 API 호출 실패: HTTP ${res.status} body="${bodyText.slice(0, 300)}"`);
  }
  const data = await res.json();
  const header = data?.response?.header;
  if (!header || header.resultCode !== '00') {
    throw new Error(`기상청 중기예보 API 오류: ${header?.resultMsg || '알 수 없는 오류'}`);
  }
  return data.response.body?.items?.item?.[0] || null;
}

/** getMidLandFcst 응답 1건 -> 일자오프셋(base tmFc 기준 +N일)별 {ampm, sky, pop} 목록.
 *  3~7일은 오전/오후 구분, 8~10일은 하루 단위로만 내려온다 (필드가 아예 없으면 그 조합은 건너뜀). */
function parseMidLandItem(item) {
  if (!item) return [];
  const out = [];
  for (let d = 3; d <= 7; d++) {
    if (item[`wf${d}Am`] != null) out.push({ dayOffset: d, ampm: 'am', sky: item[`wf${d}Am`], pop: item[`rnSt${d}Am`] ?? null });
    if (item[`wf${d}Pm`] != null) out.push({ dayOffset: d, ampm: 'pm', sky: item[`wf${d}Pm`], pop: item[`rnSt${d}Pm`] ?? null });
  }
  for (let d = 8; d <= 10; d++) {
    if (item[`wf${d}`] != null) out.push({ dayOffset: d, ampm: null, sky: item[`wf${d}`], pop: item[`rnSt${d}`] ?? null });
  }
  return out;
}

/** getMidTa 응답 1건 -> 일자오프셋별 {min, max} 목록 */
function parseMidTaItem(item) {
  if (!item) return [];
  const out = [];
  for (let d = 3; d <= 10; d++) {
    if (item[`taMin${d}`] != null) out.push({ dayOffset: d, min: item[`taMin${d}`], max: item[`taMax${d}`] });
  }
  return out;
}

/** dayOffset(tmFc 발표일 기준 +N일) -> 실제 KST 날짜(YYYYMMDD) */
function midDayOffsetToDate(tmFc, dayOffset) {
  const y = Number(tmFc.slice(0, 4)), m = Number(tmFc.slice(4, 6)) - 1, d = Number(tmFc.slice(6, 8));
  const dt = new Date(Date.UTC(y, m, d + dayOffset));
  const yyyy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

/** 중기예보 하루치(오전/오후 또는 종일) + 기온으로 라운드 복장 추천 - 단기예보와 달리 바람 데이터가 없어 기온/강수 위주로만 판단 */
function recommendOutfitMid({ tempMin, tempMax, pop }) {
  const avgTemp = tempMin != null && tempMax != null ? (tempMin + tempMax) / 2 : 15;
  let base;
  if (avgTemp >= 28) base = '반팔 폴로 + 통풍 좋은 소재, 자외선 차단 필수';
  else if (avgTemp >= 23) base = '반팔 또는 얇은 긴팔, 캡모자';
  else if (avgTemp >= 17) base = '긴팔 폴로 + 얇은 바람막이';
  else if (avgTemp >= 11) base = '긴팔 + 조끼 또는 얇은 니트';
  else if (avgTemp >= 5) base = '방한 자켓 + 이너레이어';
  else base = '두꺼운 방한복 + 장갑 + 넥워머';

  const items = [base];
  if (pop != null && pop >= 60) items.push('비 올 확률이 높아요 - 우산/우비 준비');

  return {
    summary: `예상 ${tempMin ?? '-'}~${tempMax ?? '-'}℃${pop != null && pop >= 60 ? ', 비 소식' : ''}`,
    avgTemp: Math.round(avgTemp),
    maxPop: pop ?? 0,
    items,
  };
}

/** tmFc(발표시각, "YYYYMMDDHHmm")의 한 슬롯 전("06시"<->"18시", 날짜도 필요시 하루 당김)을 계산 */
function previousMidTmFc(tmFc) {
  const datePart = tmFc.slice(0, 8);
  const slot = tmFc.slice(8);
  if (slot === '1800') return `${datePart}0600`;
  const y = Number(datePart.slice(0, 4)), m = Number(datePart.slice(4, 6)) - 1, d = Number(datePart.slice(6, 8));
  const prev = new Date(Date.UTC(y, m, d - 1));
  const yyyy = prev.getUTCFullYear();
  const mm = String(prev.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(prev.getUTCDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}1800`;
}

/** tmFc 하나로 land+ta를 조회해서 실제 날짜(YYYYMMDD) 기준으로 다시 정리한다 - dayOffset은
 * tmFc(발표시각) 기준이라 발표가 바뀌면 같은 달력 날짜라도 번호가 밀리므로, 날짜 문자열을 키로
 * 써야 서로 다른 tmFc끼리 결과를 안전하게 비교/폴백할 수 있다. */
async function fetchMidByDate(env, region, tmFc) {
  const [landItem, taItem] = await Promise.all([
    fetchMidRaw(env, MID_LAND_ENDPOINT, region.landRegId, tmFc),
    fetchMidRaw(env, MID_TA_ENDPOINT, region.taRegId, tmFc),
  ]);
  const landByDate = new Map();
  for (const e of parseMidLandItem(landItem)) {
    const dateStr = midDayOffsetToDate(tmFc, e.dayOffset);
    if (!landByDate.has(dateStr)) landByDate.set(dateStr, []);
    landByDate.get(dateStr).push(e);
  }
  const taByDate = new Map();
  for (const t of parseMidTaItem(taItem)) {
    taByDate.set(midDayOffsetToDate(tmFc, t.dayOffset), t);
  }
  return { landByDate, taByDate };
}

/** targetStr(YYYYMMDD)의 중기예보를 tmFc부터 최대 3번(각 12시간씩) 더 과거 발표까지 훑어서 처음
 * 발견되는 데이터를 쓴다. 실측 확인된 문제: 막 갱신된 최신 발표엔 가까운 날짜(3~4일 뒤) 필드가
 * 통째로 빠져있는 경우가 있었다(wf3Am/wf4Am 등이 응답 자체에 없음 - wf5 이상만 있었음). 같은 날
 * 12시간 전 발표만으로는 날짜 오프셋이 안 바뀌어(하루 단위 계산이라) 부족할 수 있어, 하루 전
 * 발표까지 필요하면 넘어간다 - 대상 날짜와의 diff가 10일을 넘어서면(범위 밖) 더 뒤져도 의미가
 * 없으니 중단한다. */
async function findMidDataForDate(env, region, tmFc, targetStr) {
  let candidate = tmFc;
  for (let step = 0; step <= 3; step++) {
    if (step > 0) candidate = previousMidTmFc(candidate);
    if (dateDiffDays(candidate.slice(0, 8), targetStr) > 10) break;
    const { landByDate, taByDate } = await fetchMidByDate(env, region, candidate);
    const dayEntries = landByDate.get(targetStr) || [];
    if (dayEntries.length) return { dayEntries, ta: taByDate.get(targetStr) || null, tmFcUsed: candidate };
  }
  return { dayEntries: [], ta: null, tmFcUsed: tmFc };
}

/** GET /api/weather/midterm?lat=&lon=&date= 처리. env.KMA_API_KEY, env.KAKAO_API_KEY 필요.
 *  단기예보(최대 +3일)로 못 채우는 4~10일 뒤를 기상청 중기예보(getMidLandFcst+getMidTa)로 채운다.
 *  좌표 -> 도(道) 단위 지역 해석은 카카오 역지오코딩 + resolveMidRegion으로 하고 KV에 영구 캐싱한다. */
export async function fetchMidTermWeather(env, lat, lon, date) {
  if (!env.KMA_API_KEY) {
    throw new Error('KMA_API_KEY가 설정되지 않았습니다 (wrangler secret put KMA_API_KEY)');
  }
  const targetStr = normalizeDateStr(date);
  if (!targetStr) throw new Error('date 파라미터가 필요합니다 (YYYY-MM-DD)');

  const tmFc = resolveMidTmFc(new Date());
  const diff = dateDiffDays(tmFc.slice(0, 8), targetStr);
  if (diff < 4) {
    throw new Error('4일 이내 날짜는 /api/weather(단기예보)를 사용해주세요.');
  }
  if (diff > 10) {
    throw new Error('기상청 중기예보는 최대 10일 뒤까지만 제공됩니다.');
  }

  const region = await resolveMidRegion(env, lat, lon);
  const { dayEntries, ta } = await findMidDataForDate(env, region, tmFc, targetStr);

  if (!dayEntries.length) {
    throw new Error('해당 날짜의 중기예보 데이터가 아직 없습니다. 다음 발표(06시/18시) 이후 다시 확인해주세요.');
  }

  const periods = dayEntries.map((e) => ({ ampm: e.ampm, sky: e.sky, pop: e.pop }));
  const outfit = recommendOutfitMid({ tempMin: ta?.min ?? null, tempMax: ta?.max ?? null, pop: Math.max(...periods.map((p) => p.pop ?? 0)) });

  return { region: region.label, tmFc, date: targetStr, periods, tempMin: ta?.min ?? null, tempMax: ta?.max ?? null, outfit };
}

function addDaysToDateStr(dateStr, days) {
  const y = Number(dateStr.slice(0, 4)), m = Number(dateStr.slice(4, 6)) - 1, d = Number(dateStr.slice(6, 8));
  const dt = new Date(Date.UTC(y, m, d + days));
  return `${dt.getUTCFullYear()}${String(dt.getUTCMonth() + 1).padStart(2, '0')}${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function toIsoDate(dateStr) {
  return `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
}

/** 오늘부터 +6일(총 7일)치 일별 요약(최저/최고기온, 대표 하늘상태)만 가볍게 반환한다. MY골프장
 * 카드처럼 여러 골프장을 한 번에 훑어야 하는 곳에서 fetchWeather/fetchMidTermWeather를 날짜별로
 * 7번씩 부르면 API 호출이 너무 많아지므로, 단기예보 1콜 + 중기예보 1콜(land+ta 동시라 사실상
 * 2콜)로 7일치를 한 번에 만든다. 중기예보 쪽이 실패해도(권역 해석 실패 등) 단기예보로 채운
 * 0~2일치는 그대로 살려서 돌려준다. */
export async function fetchWeekAheadWeather(env, lat, lon) {
  if (!env.KMA_API_KEY) {
    throw new Error('KMA_API_KEY가 설정되지 않았습니다 (wrangler secret put KMA_API_KEY)');
  }
  const { nx, ny } = latLonToGrid(lat, lon);
  const { base_date, base_time } = resolveBaseDateTime();
  const todayStr = kstTodayString();

  const url = new URL(KMA_ENDPOINT);
  url.searchParams.set('serviceKey', env.KMA_API_KEY);
  url.searchParams.set('numOfRows', '1000');
  url.searchParams.set('pageNo', '1');
  url.searchParams.set('dataType', 'JSON');
  url.searchParams.set('base_date', base_date);
  url.searchParams.set('base_time', base_time);
  url.searchParams.set('nx', String(nx));
  url.searchParams.set('ny', String(ny));
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`기상청 API 호출 실패: HTTP ${res.status}`);
  const data = await res.json();
  const header = data?.response?.header;
  if (!header || header.resultCode !== '00') throw new Error(`기상청 API 오류: ${header?.resultMsg || '알 수 없는 오류'}`);
  const items = data.response.body?.items?.item || [];

  const days = [];
  // 단기예보는 +3일까지(fetchWeather와 동일 근거로 확장 - 실측 확인: 발표시각 기준 +3일치
  // 시간대별 데이터가 정상 수신됨). 중기예보(아래)는 +4일부터 시작해서 겹치지 않게 한다.
  for (let offset = 0; offset <= 3; offset++) {
    const dateStr = addDaysToDateStr(todayStr, offset);
    const hourly = groupByHour(items, dateStr);
    if (!hourly.length) continue;
    const temps = hourly.map((h) => h.temp).filter((v) => v != null);
    const midHour = hourly[Math.floor(hourly.length / 2)];
    days.push({
      date: toIsoDate(dateStr),
      dayOffset: offset,
      tempMin: temps.length ? Math.min(...temps) : null,
      tempMax: temps.length ? Math.max(...temps) : null,
      sky: midHour?.pty && midHour.pty !== '없음' ? midHour.pty : (midHour?.sky || '-'),
    });
  }

  try {
    const tmFc = resolveMidTmFc(new Date());
    const region = await resolveMidRegion(env, lat, lon);
    const wantedDates = [];
    for (let offset = 4; offset <= 6; offset++) wantedDates.push(addDaysToDateStr(todayStr, offset));

    // findMidDataForDate와 같은 이유(막 갱신된 최신 발표엔 가까운 날짜 필드가 비어있는 경우가
    // 있었음)로 최대 3번 더 과거 발표까지 훑되, offset 4개를 한꺼번에 채워야 하므로 매번 새로
    // 부르지 않고 지금까지 모은 결과에 계속 병합해나간다(이미 채워진 날짜가 있는 최신 데이터가
    // 우선권을 가지도록 병합 순서를 맞춤 - 뒤에 스프레드한 쪽이 같은 키를 덮어씀).
    let landByDate = new Map();
    let taByDate = new Map();
    let candidate = tmFc;
    for (let step = 0; step <= 3; step++) {
      if (step > 0) candidate = previousMidTmFc(candidate);
      if (dateDiffDays(candidate.slice(0, 8), wantedDates[0]) > 10) break;
      const data = await fetchMidByDate(env, region, candidate);
      landByDate = new Map([...data.landByDate, ...landByDate]);
      taByDate = new Map([...data.taByDate, ...taByDate]);
      if (wantedDates.every((d) => landByDate.has(d))) break;
    }

    for (let offset = 4; offset <= 6; offset++) {
      const wantedDateStr = wantedDates[offset - 4];
      const landEntries = landByDate.get(wantedDateStr) || [];
      if (!landEntries.length) continue;
      const ta = taByDate.get(wantedDateStr);
      const repSky = landEntries.find((e) => e.ampm === 'pm')?.sky ?? landEntries[0]?.sky ?? '-';
      days.push({
        date: toIsoDate(wantedDateStr),
        dayOffset: offset,
        tempMin: ta?.min ?? null,
        tempMax: ta?.max ?? null,
        sky: repSky,
      });
    }
  } catch {
    // 중기예보 실패해도 단기예보(0~2일)까지는 살려서 돌려준다
  }

  return { days: days.sort((a, b) => a.dayOffset - b.dayOffset) };
}

// "주간 골프 기상도"는 KMA 대신 Open-Meteo(https://open-meteo.com)를 쓴다. KMA 중기예보는 일일
// 요청 한도가 있고(실측: LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR로 막힘) 단기/중기 API가
// 나뉘어 있어 복잡하고, 바람·습도는 3일 초과분을 제공하지 않는데, Open-Meteo는 비상업적 용도는 API
// 키 없이 좌표만으로 온도·강우·바람·습도를 7일 전체 받을 수 있어 이 화면에는 훨씬 간단하고 안정적이다.
// 앱의 다른 날씨 기능(날씨 탭, 부킹카드 배지, MY골프장 카드 등)은 이번엔 그대로 KMA를 쓴다 - 범위를
// 좁혀서 우선 이 화면만 바꿈.
export const OPEN_METEO_ENDPOINT = 'https://api.open-meteo.com/v1/forecast';

// WMO 날씨코드(Open-Meteo daily weather_code) -> 이 앱에서 이미 쓰는 하늘상태 라벨로 매핑
// (GOLF_WEATHER_SKY_ICON, 프론트 index.html 참고 - 라벨 문자열을 맞춰야 아이콘이 나온다).
export const WMO_SKY_LABEL = {
  0: '맑음', 1: '맑음', 2: '구름많음', 3: '흐림',
  45: '흐림', 48: '흐림',
  51: '비', 53: '비', 55: '비', 56: '비/눈', 57: '비/눈',
  61: '비', 63: '비', 65: '비', 66: '비/눈', 67: '비/눈',
  71: '눈', 73: '눈', 75: '눈', 77: '눈',
  80: '소나기', 81: '소나기', 82: '소나기',
  85: '눈', 86: '눈',
  95: '비', 96: '비', 99: '비',
};

/** Open-Meteo 일별 예보(최대 16일) - 온도(최저/최고)·강수확률·바람(최대풍속)·습도(최저/최고)·
 * 대표 하늘상태. API 키 불필요(비상업적 용도), 명시적 요청 한도 없음. 바람/습도도 KMA 중기예보와
 * 달리 16일 내내 제공한다(실측 확인됨). */
export async function fetchOpenMeteoDaily(lat, lon, forecastDays = 7) {
  const url = new URL(OPEN_METEO_ENDPOINT);
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lon));
  url.searchParams.set(
    'daily',
    'temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code,wind_speed_10m_max,relative_humidity_2m_max,relative_humidity_2m_min'
  );
  url.searchParams.set('timezone', 'Asia/Seoul');
  url.searchParams.set('forecast_days', String(forecastDays));

  // Worker에서 5개 권역을 동시에(Promise.all) 호출하면 같은 오리진에 순간적으로 여러 연결이 몰려
  // Cloudflare-Open-Meteo 사이 TLS 핸드셰이크가 가끔 HTTP 525로 실패하는 게 실측됨(Open-Meteo 자체
  // 문제는 아님 - 직접 반복 호출은 항상 성공). 일시적 실패이므로 짧게 한 번 재시도한다.
  let res;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await fetch(url.toString());
      if (res.ok) break;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
  }
  if (!res || !res.ok) {
    const bodyText = res ? await res.text().catch(() => '') : '';
    throw new Error(`Open-Meteo API 호출 실패: ${lastErr?.message || 'unknown'} body="${bodyText.slice(0, 200)}"`);
  }
  const data = await res.json();
  const d = data.daily;
  if (!d?.time?.length) throw new Error('Open-Meteo 응답에 daily 데이터가 없습니다.');
  return d.time.map((dateStr, i) => ({
    date: dateStr,
    dayOffset: i,
    tempMin: d.temperature_2m_min?.[i] ?? null,
    tempMax: d.temperature_2m_max?.[i] ?? null,
    pop: d.precipitation_probability_max?.[i] ?? null,
    // Open-Meteo는 풍속을 km/h로 주는데, 국내 기상 표기 관례(KMA)에 맞춰 m/s로 환산해서 보여준다.
    windMs: d.wind_speed_10m_max?.[i] != null ? Math.round((d.wind_speed_10m_max[i] / 3.6) * 10) / 10 : null,
    humidityMin: d.relative_humidity_2m_min?.[i] ?? null,
    humidityMax: d.relative_humidity_2m_max?.[i] ?? null,
    sky: WMO_SKY_LABEL[d.weather_code?.[i]] || '-',
  }));
}

// 경기남부·경기북부·경춘·강원·충청 대표 지점 좌표 - 홈 탭 "주간 골프 기상도"는 사용자 위치 권한
// 없이 항상 이 5개 고정 지점 기준으로 보여준다(프론트에서 사용자가 그중 원하는 권역만 골라본다).
const GOLF_WEATHER_BOARD_REGIONS = [
  { key: 'gyeonggi_south', label: '경기 남부', lat: 37.2636, lon: 127.0286 }, // 수원
  { key: 'gyeonggi_north', label: '경기 북부', lat: 37.7381, lon: 127.0337 }, // 의정부
  { key: 'gyeongchun', label: '경춘', lat: 37.8315, lon: 127.5095 }, // 가평
  { key: 'gangwon', label: '강원', lat: 37.8813, lon: 127.7298 }, // 춘천
  { key: 'chungcheong', label: '충청', lat: 36.3504, lon: 127.3845 }, // 대전
];

// v2: 권역 5개(경기남부/북부·경춘·강원·충청) + 바람·습도 필드 추가로 응답 모양이 바뀌어 캐시 키를
// 올렸다(이전 v1 캐시는 자연 만료되도록 두고, wrangler kv delete의 Windows 크래시를 다시 겪지 않기 위함).
const GOLF_WEATHER_BOARD_CACHE_KEY = 'weather:golfboard:v4';
const GOLF_WEATHER_BOARD_CACHE_MS = 20 * 60 * 1000; // 20분 - Open-Meteo는 요청 한도가 없지만, 예보
// 자체도 자주 안 바뀌고 매번 새로 부를 필요가 없어 방문할 때마다의 호출을 줄여둔다(예의상 + 응답속도).

/** GET /api/weather/board - 홈 탭 "주간 골프 기상도". 5개 권역을 순서대로 조회하고, 한 지역이
 * 실패해도 나머지는 그대로 보여준다. 권역이 3개일 땐 Promise.all(동시 호출)로 문제없었지만, 5개로
 * 늘리고 나서 Cloudflare Worker → Open-Meteo 사이에 동시 커넥션이 몰릴 때 HTTP 525(TLS 핸드셰이크
 * 실패)가 실측돼(직접 반복 호출은 항상 성공 - Open-Meteo 쪽 문제가 아니라 동시 연결 수 문제) 순차
 * 호출로 바꿨다. */
export async function fetchGolfWeatherBoard(env) {
  const cached = await env.GOLF_KV.get(GOLF_WEATHER_BOARD_CACHE_KEY, 'json');
  if (cached?.cachedAt && Date.now() - cached.cachedAt < GOLF_WEATHER_BOARD_CACHE_MS) {
    return { regions: cached.regions };
  }

  const regions = [];
  for (const r of GOLF_WEATHER_BOARD_REGIONS) {
    try {
      const days = await fetchOpenMeteoDaily(r.lat, r.lon);
      regions.push({ key: r.key, label: r.label, days });
    } catch (e) {
      regions.push({ key: r.key, label: r.label, days: [], error: e.message || String(e) });
    }
  }
  await env.GOLF_KV.put(GOLF_WEATHER_BOARD_CACHE_KEY, JSON.stringify({ regions, cachedAt: Date.now() }), { expirationTtl: 60 * 60 });
  return { regions };
}

/** GET /api/weather/openmeteo - 특정 좌표·특정 날짜 하루치 예보(온도/강수확률/바람/습도/하늘상태).
 * "티타임 모니터링"(워치 그룹) 카드의 날씨 타일 전용 - KMA는 단기(0~3일)/중기(4~10일) API가 나뉘어
 * 있어 호출이 복잡하고 중기는 바람/습도가 비어 있었는데, Open-Meteo는 최대 16일을 한 번에·한 API로
 * 받을 수 있어 이쪽으로 옮긴다. 날짜가 예보 범위 밖이면 null을 던진다(호출부에서 타일을 숨김 처리). */
export async function fetchOpenMeteoForDate(lat, lon, dateStr) {
  const days = await fetchOpenMeteoDaily(lat, lon, 16);
  const day = days.find((d) => d.date === dateStr);
  if (!day) throw new Error(`${dateStr}는 Open-Meteo 예보 범위(오늘부터 16일) 밖입니다.`);
  return day;
}

/** GET /api/weather/course - 날씨 탭 "골프장 날씨 검색" 전용. 임의의 좌표(즐겨찾기에 없는
 * 골프장도 카카오 장소검색으로 좌표만 찾으면 됨) 7일 예보를 그대로 돌려준다 - 골프장 단위라
 * 호출량이 "주간 골프 기상도"(고정 5권역)보다 훨씬 적어서 캐시는 두지 않는다. */
export async function fetchOpenMeteoWeekly(lat, lon) {
  return { days: await fetchOpenMeteoDaily(lat, lon, 7) };
}

function isoDateAddDays(isoDateStr, days) {
  const [y, m, d] = isoDateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/** Open-Meteo 시간별 예보(start~end 날짜 범위, 시간당 1건) - "라운드 일정" 예약 골프장의 라운딩
 * 전날~당일 상세 시간대 예보 전용. fetchOpenMeteoDaily와 같은 재시도 로직. */
export async function fetchOpenMeteoHourlyRange(lat, lon, startDate, endDate) {
  const url = new URL(OPEN_METEO_ENDPOINT);
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lon));
  url.searchParams.set('hourly', 'temperature_2m,precipitation_probability,weather_code,wind_speed_10m,relative_humidity_2m');
  url.searchParams.set('timezone', 'Asia/Seoul');
  url.searchParams.set('start_date', startDate);
  url.searchParams.set('end_date', endDate);

  let res;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await fetch(url.toString());
      if (res.ok) break;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
  }
  if (!res || !res.ok) {
    const bodyText = res ? await res.text().catch(() => '') : '';
    throw new Error(`Open-Meteo API 호출 실패: ${lastErr?.message || 'unknown'} body="${bodyText.slice(0, 200)}"`);
  }
  const data = await res.json();
  const h = data.hourly;
  if (!h?.time?.length) throw new Error('Open-Meteo 응답에 hourly 데이터가 없습니다.');
  return h.time.map((time, i) => ({
    time, // "2026-08-20T09:00" (KST, timezone=Asia/Seoul 지정했으므로 로컬시각 그대로)
    temp: h.temperature_2m?.[i] ?? null,
    pop: h.precipitation_probability?.[i] ?? null,
    windMs: h.wind_speed_10m?.[i] != null ? Math.round((h.wind_speed_10m[i] / 3.6) * 10) / 10 : null,
    humidity: h.relative_humidity_2m?.[i] ?? null,
    sky: WMO_SKY_LABEL[h.weather_code?.[i]] || '-',
  }));
}

/** GET /api/weather/course-hourly 전용 - "라운드 일정"에 예약된 골프장의 라운딩 전날 00시부터
 * 당일 23시까지(정확한 "티타임+6시간" 절단은 프론트에서 함 - 몇 시간을 자를지는 순수 표시
 * 로직이라 백엔드까지 왕복할 필요 없음) 시간별 예보를 통째로 반환한다. */
export async function fetchOpenMeteoHourlyForRound(lat, lon, roundDate) {
  const startDate = isoDateAddDays(roundDate, -1);
  return { hours: await fetchOpenMeteoHourlyRange(lat, lon, startDate, roundDate) };
}
