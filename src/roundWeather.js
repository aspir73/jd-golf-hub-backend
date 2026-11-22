// 라운드 결과 인사이트용 날씨 스냅샷 - 라운드를 완료(done)로 저장할 때 한 번만, 그 골프장 좌표와 실제 플레이 시간대
// (홀별 입력 시각 at의 처음~끝)의 Open-Meteo 시간별 값을 요약해 기록에 붙인다. 입력 부담 없이 "바람이 셀 때 몇 타 더 치는지"
// 같은 분석을 하기 위한 것. 좌표는 MY골프장 → 전국 골프장 좌표(golfgeo) → 카카오 장소검색 순으로 찾는다.
// 실패해도 스코어 저장은 막지 않는다(호출부 try/catch) - weather가 없으면 다음 저장 때 다시 시도한다.

import { normalizeCourseName } from './golfCourseDB.js';
import { listCourses } from './courses.js';
import { findGolfPlace } from './kakao.js';
import { OPEN_METEO_ENDPOINT, WMO_SKY_LABEL } from './weather.js';

const GEO_KEY = 'golfgeo:v1';

export async function resolveCourseCoords(env, courseName) {
  const key = normalizeCourseName(courseName);
  const mine = (await listCourses(env).catch(() => [])).find((c) => c.lat != null && c.lon != null && normalizeCourseName(c.name) === key);
  if (mine) return { lat: mine.lat, lon: mine.lon };
  const geo = (await env.GOLF_KV.get(GEO_KEY, 'json').catch(() => null))?.coords || {};
  const hit = geo[courseName] || Object.entries(geo).find(([n]) => normalizeCourseName(n) === key)?.[1];
  if (hit) return hit;
  const place = await findGolfPlace(env, courseName).catch(() => null);
  return place ? { lat: place.lat, lon: place.lon } : null;
}

/** "YYYY-MM-DDTHH" (KST) - 홀 입력 시각(ISO, UTC)을 한국 시간 시 단위로 */
const kstHour = (iso) => new Date(new Date(iso).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 13);

const avg = (list) => (list.length ? Math.round((list.reduce((s, v) => s + v, 0) / list.length) * 10) / 10 : null);

export async function captureRoundWeather(env, record) {
  const times = (record.holes || []).map((h) => h.at).filter(Boolean).sort();
  if (!times.length || !record.courseName) return null;
  const startH = kstHour(times[0]);
  const endH = kstHour(times[times.length - 1]);
  const coords = await resolveCourseCoords(env, record.courseName);
  if (!coords) return null;

  const url = new URL(OPEN_METEO_ENDPOINT);
  url.searchParams.set('latitude', String(coords.lat));
  url.searchParams.set('longitude', String(coords.lon));
  url.searchParams.set('hourly', 'temperature_2m,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,relative_humidity_2m');
  url.searchParams.set('timezone', 'Asia/Seoul');
  url.searchParams.set('start_date', startH.slice(0, 10));
  url.searchParams.set('end_date', endH.slice(0, 10));
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  const h = (await res.json()).hourly;
  if (!h?.time?.length) return null;

  // 첫 홀 입력 시각은 그 홀을 마친 뒤라 티오프 1시간 전부터 포함한다.
  const fromH = kstHour(new Date(new Date(times[0]).getTime() - 3600 * 1000).toISOString());
  const idx = h.time.map((t, i) => [t.slice(0, 13), i]).filter(([t]) => t >= fromH && t <= endH).map(([, i]) => i);
  if (!idx.length) return null;
  const pick = (arr) => idx.map((i) => arr?.[i]).filter((v) => v != null);
  const temps = pick(h.temperature_2m);
  const winds = pick(h.wind_speed_10m).map((v) => v / 3.6);
  const gusts = pick(h.wind_gusts_10m).map((v) => v / 3.6);
  const codes = pick(h.weather_code);
  const worst = codes.length ? Math.max(...codes) : null; // WMO 코드는 클수록 궂은 날씨

  return {
    start: `${fromH}:00`,
    end: `${endH}:00`,
    tempAvg: avg(temps),
    tempMin: temps.length ? Math.min(...temps) : null,
    tempMax: temps.length ? Math.max(...temps) : null,
    windAvg: avg(winds),
    windMax: winds.length ? Math.round(Math.max(...winds) * 10) / 10 : null,
    gustMax: gusts.length ? Math.round(Math.max(...gusts) * 10) / 10 : null,
    humidityAvg: avg(pick(h.relative_humidity_2m)),
    precipMm: Math.round(pick(h.precipitation).reduce((s, v) => s + v, 0) * 10) / 10,
    sky: worst != null ? WMO_SKY_LABEL[worst] || '-' : null,
    weatherCode: worst,
    source: 'open-meteo',
    capturedAt: new Date().toISOString(),
  };
}
