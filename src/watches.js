// "티타임 워치" - 이 시스템의 핵심 MVP 기능(기획서와 별개로 사용자 요청에 따라 신설).
// 특정 골프장 + 날짜(+시간대)를 지정해두면 Cloudflare Cron Trigger가 30분마다 백그라운드에서
// 골팡/카카오골프예약을 재검색해서 매칭되는 티타임을 KV에 저장해둔다. 알림(카카오톡/이메일/푸시)은
// 아직 없고 - 앱을 열었을 때 최신 결과를 바로 볼 수 있게 하는 것까지가 1차 범위(사용자가 명시적으로
// "앱 내에서만 확인" 방식을 선택함). 새로 생긴 시간대는 isNew로 표시해서 화면에서 강조할 수 있다.

import { findBestMatch, normalizeCourseName } from './golfCourseDB.js';
import { searchGolfpangRounds } from './golfpang.js';
import { searchKakaoGolfRounds, fetchKakaoGolfTeeTimes } from './kakaogolf.js';
import { DB_REGION_TO_NORMALIZED, NORMALIZED_REGION_CODES } from './regionMap.js';

const WATCHES_KEY = 'watches';

// index.html의 NORMALIZED_TIME_OF_DAY(kakaoTimeZones)와 동일 값 - 오전엔 카카오 쪽 "새벽(1)"도
// 합쳐서 본다(원래 프론트 로직 그대로).
const KAKAO_TIME_ZONE_BITS = { am: 1 | 2, pm: 4, nt: 8 };
// "HH:MM" 문자열을 분 단위로 바꿔서 대략적인 시간대 버킷과 비교하기 위한 범위(오전 00:00~11:59,
// 오후 12:00~16:59, 야간 17:00~23:59 - 카카오 timeZone 비트마스크 구간과 맞춤).
const TIME_OF_DAY_RANGES = { am: [0, 719], pm: [720, 1019], nt: [1020, 1439] };

export async function listWatches(env) {
  const raw = await env.GOLF_KV.get(WATCHES_KEY, 'json');
  return raw || [];
}

async function saveWatches(env, watches) {
  await env.GOLF_KV.put(WATCHES_KEY, JSON.stringify(watches));
}

// mode: 'booking'(부킹 탭 - 골팡 '부킹' 매물 + 카카오골프예약도 포함) | 'join'(조인 탭 - 골팡
// '조인/백업' 매물만, 카카오골프예약은 조인 탭 조건검색과 동일하게 제외).
const ALLOWED_MODES = ['booking', 'join'];

function normalizeWatch(input, existing = {}) {
  const now = new Date().toISOString();
  return {
    id: existing.id || crypto.randomUUID(),
    courseName: input.courseName ?? existing.courseName ?? '',
    region: input.region ?? existing.region ?? '',
    date: input.date ?? existing.date ?? '',
    timeOfDay: Array.isArray(input.timeOfDay) ? input.timeOfDay : existing.timeOfDay || [],
    mode: ALLOWED_MODES.includes(input.mode) ? input.mode : existing.mode || 'booking',
    active: input.active != null ? Boolean(input.active) : existing.active ?? true,
    createdAt: existing.createdAt || now,
    updatedAt: now,
    lastCheckedAt: existing.lastCheckedAt || null,
    lastResults: existing.lastResults || [],
    lastError: existing.lastError || null,
  };
}

export async function addWatch(env, input) {
  if (!input.courseName) throw new Error('courseName(골프장명)은 필수입니다');
  if (!input.date) throw new Error('date(감시할 날짜)는 필수입니다');
  const watches = await listWatches(env);
  // region이 명시되지 않았으면(직접 타이핑만 하고 자동완성 후보를 안 고른 경우) DB 매칭을
  // 한 번 더 시도해서 채워둔다 - region을 모르면 재검색할 때 어느 지역을 훑어야 할지 알 수 없다.
  const region = input.region || findBestMatch(input.courseName)?.region || '';
  const record = normalizeWatch({ ...input, region });
  watches.push(record);
  await saveWatches(env, watches);
  return record;
}

/** MY골프장에서 여러 개를 한 번에 골라 워치로 등록할 때 사용 - courses.js의 bulkAddCourses와
 * 같은 이유로(KV 읽기-쓰기 레이스 컨디션 방지) 배치 전체를 KV 읽기 1번/쓰기 1번으로 처리한다.
 * items: [{courseName, region, date, timeOfDay, mode}] */
export async function bulkAddWatches(env, items) {
  const watches = await listWatches(env);
  const added = [];
  for (const item of items) {
    if (!item.courseName || !item.date) continue;
    const region = item.region || findBestMatch(item.courseName)?.region || '';
    const record = normalizeWatch({ ...item, region });
    watches.push(record);
    added.push(record);
  }
  await saveWatches(env, watches);
  return added;
}

export async function updateWatch(env, id, input) {
  const watches = await listWatches(env);
  const idx = watches.findIndex((w) => w.id === id);
  if (idx === -1) return null;
  watches[idx] = normalizeWatch(input, watches[idx]);
  await saveWatches(env, watches);
  return watches[idx];
}

export async function deleteWatch(env, id) {
  const watches = await listWatches(env);
  const next = watches.filter((w) => w.id !== id);
  const changed = next.length !== watches.length;
  if (changed) await saveWatches(env, next);
  return changed;
}

/** 여러 워치를 한 번에 지울 때("선택 삭제"/"전체 삭제") 쓴다 - bulkAddWatches와 같은 이유로
 * (KV 읽기-쓰기 레이스 컨디션 방지) 배치 전체를 KV 읽기 1번/쓰기 1번으로 처리한다. */
export async function bulkDeleteWatches(env, ids) {
  const watches = await listWatches(env);
  const idSet = new Set(ids);
  const next = watches.filter((w) => !idSet.has(w.id));
  const deletedCount = watches.length - next.length;
  if (deletedCount > 0) await saveWatches(env, next);
  return deletedCount;
}

function timeToMinutes(timeStr) {
  const m = (timeStr || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function matchesTimeOfDay(timeStr, timeOfDay) {
  if (!timeOfDay || !timeOfDay.length) return true;
  const mins = timeToMinutes(timeStr);
  if (mins == null) return true; // 시간 정보를 못 읽으면 걸러내지 않고 일단 남겨둔다(빈값보다 낫다)
  return timeOfDay.some((t) => {
    const range = TIME_OF_DAY_RANGES[t];
    return range && mins >= range[0] && mins <= range[1];
  });
}

function courseNameMatches(row, watch) {
  if (row.officialName && row.officialName === watch.courseName) return true;
  const norm = normalizeCourseName(row.officialName || row.courseName || '');
  const target = normalizeCourseName(watch.courseName);
  return Boolean(norm && target && norm === target);
}

/** 워치 하나를 실제로 재검색해서 최신 티타임 목록을 얻는다. 골팡은 지역 섹터별로 개별 티타임까지
 * 바로 오지만, 카카오골프예약은 먼저 골프장 단위 요약에서 golfInfoSeq를 찾은 뒤 상세조회를 한 번
 * 더 호출해야 실제 시간대가 나온다. 어느 한쪽이 실패해도 나머지 쪽 결과는 살리기 위해 각각
 * try/catch로 조용히 건너뛴다 - 워치 갱신 전체가 외부 API 하나 때문에 막히면 안 된다. */
async function fetchWatchResults(env, watch) {
  const normKeys = DB_REGION_TO_NORMALIZED[watch.region] || [];
  const results = [];

  const golfpangSectors = normKeys.length
    ? [...new Set(normKeys.map((k) => NORMALIZED_REGION_CODES[k].golfpang))]
    : [''];
  const golfpangMode = watch.mode === 'join' ? 'join' : 'booking';
  // 부킹/조인 탭 조건검색은 캐디 칩 기본값이 "일반캐디"라 골팡 cdOrder=0으로 항상 필터링해서
  // 보여준다(index.html의 NORMALIZED_CADDY.general.golfpang와 동일 값) - 워치도 캐디타입을
  // 안 넘기면(=전체 캐디, 노캐디/운전캐디/인턴캐디까지 포함) 탭에서 기본 검색했을 때 안 보이는
  // 매물까지 잡아내서 "워치 결과가 검색과 다르다"는 걸로 보였다. 탭의 기본 검색과 같은 조건으로
  // 맞춘다.
  const WATCH_GOLFPANG_CADDY_TYPE = '0';
  for (const sector of golfpangSectors) {
    try {
      const { rounds } = await searchGolfpangRounds(env, { date: watch.date, sector, mode: golfpangMode, caddyType: WATCH_GOLFPANG_CADDY_TYPE });
      rounds
        .filter((r) => courseNameMatches(r, watch) && matchesTimeOfDay(r.time, watch.timeOfDay))
        .forEach((r) => results.push({ source: '골팡', time: r.time, holes: r.holes, greenFee: r.greenFee }));
    } catch {
      // 골팡 조회 실패 - 조용히 건너뜀(카카오 쪽이라도 남기기 위해)
    }
  }

  // 조인 탭 워치는 조인 탭 조건검색과 동일하게 카카오골프예약을 아예 제외한다.
  if (watch.mode === 'join') return results.sort((a, b) => (a.time || '').localeCompare(b.time || ''));

  try {
    const kakaoMajors = normKeys.length
      ? [...new Set(normKeys.map((k) => NORMALIZED_REGION_CODES[k].kakaoMajor))]
      : [''];
    for (const major of kakaoMajors) {
      const { rounds } = await searchKakaoGolfRounds(env, { date: watch.date, areas: major ? [major] : [] });
      const match = rounds.find((r) => courseNameMatches(r, watch) && r.matchCount > 0);
      if (match) {
        const timeZone = watch.timeOfDay.reduce((sum, t) => sum + (KAKAO_TIME_ZONE_BITS[t] || 0), 0);
        const detail = await fetchKakaoGolfTeeTimes(env, { golfInfoSeq: match.idx, date: watch.date, timeZone });
        detail
          .filter((t) => matchesTimeOfDay(t.time, watch.timeOfDay))
          .forEach((t) => results.push({ source: '카카오', time: t.time, holes: t.holes, greenFee: t.greenFee, courseSubName: t.courseSubName }));
        break; // 같은 골프장이 여러 대권역에 중복 등록돼 있을 리 없으니 찾았으면 종료
      }
    }
  } catch {
    // 카카오 조회 실패 - 조용히 건너뜀
  }

  return results.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
}

/** 워치 하나를 재검색하고 결과를 KV에 반영한다. 직전 결과에 없던 시간대는 isNew:true로 표시해서
 * 화면에서 "새로 생긴 자리"를 강조할 수 있게 한다. */
export async function refreshWatch(env, watchId) {
  const watches = await listWatches(env);
  const idx = watches.findIndex((w) => w.id === watchId);
  if (idx === -1) return null;
  const watch = watches[idx];
  const previousKeys = new Set((watch.lastResults || []).map((r) => `${r.source}:${r.time}`));
  try {
    const results = await fetchWatchResults(env, watch);
    watch.lastResults = results.map((r) => ({ ...r, isNew: !previousKeys.has(`${r.source}:${r.time}`) }));
    watch.lastError = null;
  } catch (e) {
    watch.lastError = e.message || String(e);
  }
  watch.lastCheckedAt = new Date().toISOString();
  watches[idx] = watch;
  await saveWatches(env, watches);
  return watch;
}

/** Cron 트리거에서 호출 - 활성 상태고 아직 지나지 않은 날짜의 워치만 순서대로 갱신한다.
 * Worker 서브리퀘스트 한도(무료 플랜 기준 요청당 50개, 워치 하나당 최대 3개 소모 - 골팡 지역별
 * 호출 + 카카오 검색 + 카카오 상세) 안에서 안전하게 처리하려고 한 번에 최대 15개까지만 처리한다
 * (개인용 앱이라 동시에 활성 워치가 많지 않을 걸 전제로 한 값 - 실사용 중 부족하면 늘릴 것). */
export async function refreshAllWatches(env) {
  const watches = await listWatches(env);
  const today = new Date().toISOString().slice(0, 10);
  const targets = watches.filter((w) => w.active && w.date >= today).slice(0, 15);
  for (const w of targets) {
    await refreshWatch(env, w.id);
  }
  return targets.length;
}
