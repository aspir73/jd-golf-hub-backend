// 예약 탭 "이번 주말 현황": 다가오는 토·일의 오전 티타임(일반캐디 기준)을 지정한 골프장들에 대해
// 한 번에 모아서 보여준다 - 예약 가능한 시간, 그린피, 날씨. 워치(watches.js)처럼 골프장마다 따로
// 검색하면 Worker 서브리퀘스트 한도에 걸리므로, 날짜별로 "지역 단위"로 한 번씩만 검색하고 그
// 결과에서 골프장별로 걸러낸다. 결과는 10분간 KV에 캐시한다.

import { normalizeCourseName, findBestMatch } from './golfCourseDB.js';
import { listCourses } from './courses.js';
import { searchGolfpangRoundsAllPages } from './golfpang.js';
import { searchKakaoGolfRounds, fetchKakaoGolfTeeTimes } from './kakaogolf.js';
import { NORMALIZED_REGION_CODES, DB_REGION_TO_NORMALIZED } from './regionMap.js';
import { findGolfPlace } from './kakao.js';
import { getBaseccRounds } from './teeSnapshots.js';
import { fetchOpenMeteoDaily, kstTodayDateStr } from './weather.js';

// aliases: 정규화(normalizeCourseName + 소문자)한 이름이 이 중 하나와 정확히 같으면 그 골프장.
// 부분일치를 쓰지 않는 이유: "코리아"가 "뉴코리아"/"코리아대중"과 섞이는 걸 막기 위해.
// 더시에나 벨루트는 예전 이름(세라지오)으로 올라오는 플랫폼도 있어 둘 다 허용한다.
// 사용자가 MY골프장에서 추천 대상을 하나도 고르지 않았을 때 쓰는 기본 목록.
export const WEEKEND_BOARD_COURSES = [
  { key: 'winchest', label: '윈체스트 골프클럽', short: '윈체스트', region: '경기', queries: ['윈체스트 골프클럽', '윈체스트GC'], aliases: ['윈체스트', '윈체스트대중'], regions: ['hangang', 'gangbuk'] },
  { key: 'yangpyeong', label: '양평TPC', short: '양평TPC', region: '경기', queries: ['양평TPC'], aliases: ['양평tpc'], regions: ['hangang', 'gangbuk'] },
  { key: 'velut', label: '더시에나 벨루토', short: '더시에나.벨', region: '경기', queries: ['더시에나벨루토', '더시에나 벨루트CC', '세라지오GC'], aliases: ['더시에나벨루토', '더시에나벨루트', '세라지오'], regions: ['hangang', 'gangbuk'] },
  { key: 'kingsdale', label: '킹스데일', short: '킹스데일', region: '충북', queries: ['킹스데일CC', '킹스데일 컨트리클럽'], aliases: ['킹스데일', '킹스테일'], regions: ['chungcheong'] },
  { key: 'daeyoung', label: '대영베이스CC', short: '대영베이스', region: '충북', queries: ['대영베이스cc'], aliases: ['대영베이스'], regions: ['chungcheong'] },
  { key: 'wolsong', label: '월송리 CC', short: '월송리', region: '강원', queries: ['월송리컨트리클럽', '월송리CC'], aliases: ['월송리'], regions: ['gangwon'] },
];

// "오전 1부" = 이른 아침 첫 구간. 09:00 이전 티타임만 본다.
const PART1_BEFORE_MIN = 9 * 60;
function isPart1(timeStr) {
  const m = (timeStr || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) < PART1_BEFORE_MIN : false;
}

const CACHE_TTL_SEC = 10 * 60;
const COORDS_KEY = 'weekend-board:coords:v1';
const WEATHER_TTL_SEC = 3 * 60 * 60; // 날씨는 3시간 캐시 - 호출을 줄여 서브리퀘스트와 Open-Meteo 부담을 줄인다

function norm(name) {
  return normalizeCourseName(name || '').toLowerCase();
}

function rowMatches(row, course) {
  const names = [row.officialName, row.courseName].filter(Boolean).map(norm);
  return names.some((n) => course.aliases.includes(n));
}


const KNOWN_EXTRA_ALIASES = {
  '더시에나벨루토': ['세라지오', '더시에나벨루트'],
  '세라지오': ['더시에나벨루토', '더시에나벨루트'],
  '킹스데일': ['킹스테일'],
};
const stripKind = (n) => n.replace(/(대중제|대중|퍼블릭|회원제|p9)$/i, '');

/** "더시에나 벨루토 컨트리클럽" -> "더시에나.벨", "윈체스트 골프클럽 대중" -> "윈체스트" (CC/골프클럽 등 생략) */
export function shortNameOf(name) {
  let n = (name || '').replace(/\(.*?\)/g, ' ').replace(/(컨트리\s*클럽|골프\s*클럽|골프장|리조트|CC|GC)/gi, ' ');
  n = n.replace(/\s+(대중제?|퍼블릭|회원제|P9)\s*$/i, '').trim().replace(/\s+/g, ' ');
  const parts = n.split(' ').filter(Boolean);
  if (parts.length >= 2) return `${parts[0]}.${parts[1].slice(0, 1)}`;
  return (parts[0] || name || '').slice(0, 7);
}

/** MY골프장 한 곳 -> 주말 현황 검색 대상. 이름 표기가 플랫폼마다 달라서(공식명/약칭/구명칭) 정규화한 별칭 여러 개로 매칭한다. */
function boardCourseFromMy(c) {
  const base = norm(c.name);
  const match = findBestMatch(c.name);
  const aliases = new Set([base, stripKind(base)]);
  if (match) { const mb = norm(match.name); aliases.add(mb); aliases.add(stripKind(mb)); }
  for (const a of [...aliases]) (KNOWN_EXTRA_ALIASES[a] || []).forEach((x) => aliases.add(x));
  const region = c.region || match?.region || '';
  return {
    key: c.id, label: c.name, short: shortNameOf(c.name), region,
    aliases: [...aliases].filter(Boolean),
    regions: DB_REGION_TO_NORMALIZED[region] || ['hangang', 'gangbuk'],
    lat: c.lat ?? null, lon: c.lon ?? null,
    // 좌표가 저장 안 된 MY골프장(예: 윈체스트 골프클럽 대중)은 이 이름들로 위치를 찾는다 - 예전엔 검색어가 없어서
    // 좌표를 못 구했고, 그 골프장만 날씨가 계속 비어 있었다.
    queries: [...new Set([c.name, match?.name].filter(Boolean))],
  };
}

/** mode별 대상 골프장: MY골프장에서 추천 지정한 것(최대 6개), 없으면 기본 목록. */
async function loadBoardCourses(env, mode) {
  const field = mode === 'join' ? 'recJoin' : 'recBooking';
  try {
    const picked = (await listCourses(env)).filter((c) => c[field]).slice(0, 6);
    if (picked.length) return { courses: picked.map(boardCourseFromMy), custom: true };
  } catch { /* 목록을 못 읽으면 기본 목록으로 */ }
  return { courses: WEEKEND_BOARD_COURSES, custom: false };
}

const hashKey = (str) => { let h = 5381; for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0; return h.toString(36); };

/** 오늘(KST) 기준 다가오는 토·일 날짜. 토요일이면 오늘+내일, 일요일이면 다음 주 토·일. */
export function upcomingWeekendDates(todayStr = kstTodayDateStr()) {
  const [y, m, d] = todayStr.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  const dow = base.getUTCDay(); // 0=일 ... 6=토
  const fmt = (dt) => `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
  const add = (n) => new Date(Date.UTC(y, m - 1, d + n));
  // 일요일엔 오늘 1부 티타임은 이미 지났으니 다음 주 토·일을 보여준다.
  const toSat = dow === 0 ? 6 : (6 - dow + 7) % 7;
  return [fmt(add(toSat)), fmt(add(toSat + 1))];
}

async function resolveCoords(env, courses) {
  const cached = (await env.GOLF_KV.get(COORDS_KEY, 'json')) || {};
  let changed = false;
  for (const c of courses) {
    if (c.lat != null && c.lon != null) { cached[c.key] = { lat: c.lat, lon: c.lon }; continue; } // MY골프장 좌표를 그대로 쓴다
    if (cached[c.key]) continue;
    for (const q of (c.queries || [c.query]).filter(Boolean)) {
      try {
        // findGolfPlace: 괄호·"대중/회원제" 꼬리를 뗀 변형까지 검색하고 골프장 카테고리를 우선한다.
        const best = await findGolfPlace(env, q);
        if (best?.lat != null && best?.lon != null) { cached[c.key] = { lat: best.lat, lon: best.lon }; changed = true; break; }
      } catch { /* 다음 검색어로 */ }
    }
  }
  if (changed) await env.GOLF_KV.put(COORDS_KEY, JSON.stringify(cached));
  return cached;
}

/** 한 날짜에 대해: 지역 단위로 골팡/카카오/XGOLF를 한 번씩만 검색하고 골프장별 오전 티타임을 모은다. */
/** mode: 'booking'(예약 탭: 골팡 부킹 + 카카오골프예약 + 대영베이스 홈페이지) | 'join'(조인 탭: 골팡 조인/백업만 - 조인 조건검색과 같은 범위) */
async function collectDate(env, date, ctx = {}, mode = 'booking', courses = WEEKEND_BOARD_COURSES) {
  const slots = Object.fromEntries(courses.map((c) => [c.key, []]));
  const errors = [];
  const regionKeys = [...new Set(courses.flatMap((c) => c.regions))];

  // 골팡(본인예약 '부킹' 매물, 오전, 일반캐디)
  const sectors = [...new Set(regionKeys.map((k) => NORMALIZED_REGION_CODES[k].golfpang))];
  await Promise.all(sectors.map(async (sector) => {
    try {
      const { rounds } = await searchGolfpangRoundsAllPages(env, { date, sector, ampm: 'am', mode: mode === 'join' ? 'join' : 'booking', caddyType: '0' }, 2);
      for (const r of rounds) {
        if (!isPart1(r.time)) continue;
        for (const c of courses) {
          if (!rowMatches(r, c)) continue;
          // 조인 매물은 "남녀무관 2명" 같은 모집 조건(category)을 같이 보여준다.
          slots[c.key].push({ source: '골팡', time: r.time, holes: r.holes, greenFee: r.greenFee, ...(mode === 'join' ? { courseSubName: r.category || '', nickname: r.nickname || '' } : {}) });
        }
      }
    } catch (e) { errors.push(`골팡: ${e.message}`); }
  }));

  if (mode === 'join') {
    for (const k of Object.keys(slots)) slots[k].sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    return { slots, errors };
  }

  // 카카오골프예약: 대권역 요약 → 해당 골프장만 상세조회(오전 timeZone 1|2)
  const majors = [...new Set(regionKeys.map((k) => NORMALIZED_REGION_CODES[k].kakaoMajor))];
  // 카카오 쪽이 막혀 있으면(NAS 중계 꺼짐/차단) 남은 대권역·날짜까지 계속 두드리지 않는다 - 서브리퀘스트만 낭비한다.
  for (const major of majors) {
    if (ctx.kakaoDown) break;
    try {
      const { rounds } = await searchKakaoGolfRounds(env, { date, areas: [major] });
      for (const c of courses) {
        const match = rounds.find((r) => rowMatches(r, c) && r.matchCount > 0);
        if (!match) continue;
        const detail = await fetchKakaoGolfTeeTimes(env, { golfInfoSeq: match.idx, date, timeZone: 3 });
        detail.filter((t) => isPart1(t.time)).forEach((t) => slots[c.key].push({ source: '카카오', time: t.time, holes: t.holes, greenFee: t.greenFee, courseSubName: t.courseSubName }));
      }
    } catch (e) { errors.push(`카카오: ${e.message}`); ctx.kakaoDown = true; }
  }

  // 대영베이스CC는 홈페이지 방화벽이 Worker를 막아서, NAS가 읽어 올려둔 스냅샷을 쓴다(오전·일반캐디만).
  const baseccCourse = courses.find((c) => c.aliases.includes('대영베이스'));
  if (baseccCourse) try {
    const snap = await getBaseccRounds(env, date);
    snap.rounds
      .filter((r) => isPart1(r.time) && r.caddyType === 'general')
      .forEach((r) => slots[baseccCourse.key].push({ source: '대영', time: r.time, holes: r.holes, greenFee: r.greenFee, courseSubName: r.courseSubName }));
    if (snap.missing) errors.push('대영베이스: NAS 수집 데이터가 아직 없어요');
    else if (snap.stale) errors.push('대영베이스: NAS 수집이 1시간 넘게 갱신되지 않았어요');
  } catch (e) { errors.push(`대영베이스: ${e.message}`); }

  for (const k of Object.keys(slots)) slots[k].sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  return { slots, errors };
}

export async function fetchWeekendBoard(env, { refresh = false, mode = 'booking' } = {}) {
  const dates = upcomingWeekendDates();
  const { courses, custom } = await loadBoardCourses(env, mode);
  const cacheKey = `weekend-board:${mode}:v6:${dates.join(',')}:${hashKey(courses.map((c) => c.key).join('|'))}`;
  if (!refresh) {
    const cached = await env.GOLF_KV.get(cacheKey, 'json');
    if (cached) return cached;
  }

  // 서브리퀘스트 한도(무료 플랜 50개) 안에서 안전하도록 가볍고 확실한 날씨/좌표를 먼저 처리하고,
  // 카카오골프예약처럼 403 재시도로 호출이 불어나는 검색은 뒤에서 한다. 날씨는 Open-Meteo 동시 연결
  // 문제(525)를 피하려고 순차 호출.
  const coords = await resolveCoords(env, courses);
  const weather = {};
  for (const c of courses) {
    const pos = coords[c.key];
    if (!pos) continue;
    try {
      const wxKey = `weekend-board:wx:v1:${c.key}`;
      let days = await env.GOLF_KV.get(wxKey, 'json');
      if (!days) {
        days = (await fetchOpenMeteoDaily(pos.lat, pos.lon, 10)).map((d) => ({ date: d.date, sky: d.sky, tempMin: d.tempMin, tempMax: d.tempMax, pop: d.pop }));
        await env.GOLF_KV.put(wxKey, JSON.stringify(days), { expirationTtl: WEATHER_TTL_SEC });
      }
      weather[c.key] = Object.fromEntries(days.filter((d) => dates.includes(d.date)).map((d) => [d.date, { sky: d.sky, tempMin: d.tempMin, tempMax: d.tempMax, pop: d.pop }]));
    } catch { /* 날씨만 비움 */ }
  }
  const perDate = [];
  const ctx = { kakaoDown: false };
  for (const d of dates) perDate.push(await collectDate(env, d, ctx, mode, courses));

  const result = {
    dates,
    fetchedAt: new Date().toISOString(),
    custom,
    courses: courses.map((c) => ({
      key: c.key,
      label: c.label,
      short: c.short,
      region: c.region,
      byDate: Object.fromEntries(dates.map((d, i) => [d, { slots: perDate[i].slots[c.key], weather: weather[c.key]?.[d] || null }])),
    })),
    errors: [...new Set(perDate.flatMap((p) => p.errors))],
  };
  await env.GOLF_KV.put(cacheKey, JSON.stringify(result), { expirationTtl: CACHE_TTL_SEC });
  return result;
}
