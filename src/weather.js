// 기상청 단기예보 조회서비스(getVilageFcst) 연동
// 위경도 -> 격자좌표(nx, ny) 변환은 기상청이 공개한 Lambert Conformal Conic 변환 공식을 그대로 사용한다.

// 주의: 경로에 언더스코어가 들어간다 (VilageFcstInfoService_2.0). 언더스코어 없이 호출하면
// 기상청 API가 "NO_OPENAPI_SERVICE_ERROR(해당 오픈API 서비스가 없거나 폐기됨)"로 응답한다.
const KMA_ENDPOINT =
  'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst';

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

const SKY_LABEL = { 1: '맑음', 3: '구름많음', 4: '흐림' };
const PTY_LABEL = { 0: '없음', 1: '비', 2: '비/눈', 3: '눈', 4: '소나기' };

/** getVilageFcst 응답을 시간대별로 정리 (오늘 남은 시간대만) */
function groupByHour(items, todayStr) {
  const byTime = new Map();
  for (const it of items) {
    if (it.fcstDate !== todayStr) continue;
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

/** GET /api/weather?lat=&lon= 처리. env.KMA_API_KEY 필요 */
export async function fetchWeather(env, lat, lon) {
  if (!env.KMA_API_KEY) {
    throw new Error('KMA_API_KEY가 설정되지 않았습니다 (wrangler secret put KMA_API_KEY)');
  }
  const { nx, ny } = latLonToGrid(lat, lon);
  const { base_date, base_time } = resolveBaseDateTime();

  const url = new URL(KMA_ENDPOINT);
  url.searchParams.set('serviceKey', env.KMA_API_KEY);
  url.searchParams.set('numOfRows', '290');
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
  const todayStr = kstTodayString();
  const hourly = groupByHour(items, todayStr);
  const outfit = recommendOutfit(hourly);

  return { nx, ny, base_date, base_time, hourly, outfit };
}
