// "티타임 워치" - 이 시스템의 핵심 MVP 기능(기획서와 별개로 사용자 요청에 따라 신설).
// 특정 골프장 + 날짜(+시간대)를 지정해두면 Cloudflare Cron Trigger가 30분마다 백그라운드에서
// 골팡/카카오골프예약을 재검색해서 매칭되는 티타임을 KV에 저장해둔다. 알림(카카오톡/이메일/푸시)은
// 아직 없고 - 앱을 열었을 때 최신 결과를 바로 볼 수 있게 하는 것까지가 1차 범위(사용자가 명시적으로
// "앱 내에서만 확인" 방식을 선택함). 새로 생긴 시간대는 isNew로 표시해서 화면에서 강조할 수 있다.

import { findBestMatch, normalizeCourseName } from './golfCourseDB.js';
import { searchGolfpangRoundsAllPages } from './golfpang.js';
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

// 캐디타입 표준키 → 골팡 cdOrder 값(index.html의 NORMALIZED_CADDY와 동일하게 유지 - 프론트
// 조건검색 캐디 칩과 워치 등록 다이얼로그의 캐디 칩이 같은 값을 쓴다).
export const WATCH_CADDY_TO_GOLFPANG = { general: '0', drive: '1', intern: '3', none: '2' };
const ALLOWED_CADDY_TYPES = Object.keys(WATCH_CADDY_TO_GOLFPANG);

function normalizeWatch(input, existing = {}) {
  const now = new Date().toISOString();
  return {
    id: existing.id || crypto.randomUUID(),
    courseName: input.courseName ?? existing.courseName ?? '',
    region: input.region ?? existing.region ?? '',
    date: input.date ?? existing.date ?? '',
    timeOfDay: Array.isArray(input.timeOfDay) ? input.timeOfDay : existing.timeOfDay || [],
    caddyType: ALLOWED_CADDY_TYPES.includes(input.caddyType) ? input.caddyType : existing.caddyType || 'general',
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
async function fetchWatchResults(env, watch, { maxGolfpangPages = 1 } = {}) {
  const normKeys = DB_REGION_TO_NORMALIZED[watch.region] || [];
  const results = [];

  const golfpangSectors = normKeys.length
    ? [...new Set(normKeys.map((k) => NORMALIZED_REGION_CODES[k].golfpang))]
    : [''];
  const golfpangMode = watch.mode === 'join' ? 'join' : 'booking';
  // 워치 등록 시 고른 캐디 옵션(기본값 "일반캐디")을 그대로 써서 탭 조건검색과 동일한 조건으로
  // 맞춘다 - 예전엔 캐디타입을 아예 안 넘겨서(=전체 캐디) 탭 기본 검색(일반캐디만)엔 안 보이는
  // 매물까지 워치 결과에 섞여 "워치 결과가 검색과 다르다"는 문제가 있었다.
  const golfpangCaddyType = WATCH_CADDY_TO_GOLFPANG[watch.caddyType] || WATCH_CADDY_TO_GOLFPANG.general;
  // watch.timeOfDay 값(am/pm/nt) 자체가 골팡 ampm 파라미터 코드와 동일해서 그대로 넘길 수
  // 있다(index.html의 NORMALIZED_TIME_OF_DAY[t].golfpangAmpm과 같은 값). 예전엔 골팡에
  // ampm을 안 넘기고 전체 시간대를 받아서 우리가 만든 시간 범위(TIME_OF_DAY_RANGES)로
  // 직접 다시 걸렀는데, 그 경계가 골팡이 실제로 쓰는 "야간" 기준(17시가 아니라 16시대부터
  // 시작 - 실측 확인됨)과 달라서 "조인 조건검색은 8건인데 워치는 5건"처럼 검색과 결과가
  // 달라 보이는 문제가 있었다. ampm을 그대로 넘겨 골팡 서버가 매기는 기준을 그대로 믿는
  // 쪽으로 바꿔서 조건검색과 완전히 같은 기준이 되게 한다(전체 시간대면 ampm='').
  const ampms = watch.timeOfDay.length ? watch.timeOfDay : [''];
  for (const sector of golfpangSectors) {
    for (const ampm of ampms) {
      try {
        // maxGolfpangPages=1(크론 배치)이면 예전처럼 페이지 1만 보고, 사용자가 직접 "지금
        // 새로고침"을 눌렀을 때(refreshWatch 호출부 참고)는 여러 페이지까지 훑어서 매물 많은
        // 지역/날짜에서도 그 골프장 매물을 놓치지 않는다("조인 조건검색은 8건인데 워치는 1건"
        // 처럼 검색과 결과가 달라 보이던 문제 - 둘 다 페이지 1만 보던 게 원인이었음).
        const { rounds } = await searchGolfpangRoundsAllPages(env, { date: watch.date, sector, ampm, mode: golfpangMode, caddyType: golfpangCaddyType }, maxGolfpangPages);
        rounds
          .filter((r) => courseNameMatches(r, watch))
          .forEach((r) => results.push({ source: '골팡', time: r.time, holes: r.holes, greenFee: r.greenFee }));
      } catch {
        // 골팡 조회 실패 - 조용히 건너뜀(카카오 쪽이라도 남기기 위해)
      }
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

/** 워치 객체 하나를 실제로 재검색해서 lastResults/lastError/lastCheckedAt을 갱신한다(watch
 * 객체를 그 자리에서 직접 mutate - KV 읽기/쓰기는 호출부 책임). refreshWatch(단건 새로고침)와
 * refreshAllWatches(크론 배치)가 이 로직을 공유하되, KV 읽기/쓰기 횟수만 다르게 가져간다. */
async function applyWatchRefresh(env, watch, { maxGolfpangPages = 1 } = {}) {
  const previousKeys = new Set((watch.lastResults || []).map((r) => `${r.source}:${r.time}`));
  try {
    const results = await fetchWatchResults(env, watch, { maxGolfpangPages });
    watch.lastResults = results.map((r) => ({ ...r, isNew: !previousKeys.has(`${r.source}:${r.time}`) }));
    watch.lastError = null;
  } catch (e) {
    watch.lastError = e.message || String(e);
  }
  watch.lastCheckedAt = new Date().toISOString();
}

/** 워치 하나를 재검색하고 결과를 KV에 반영한다. 직전 결과에 없던 시간대는 isNew:true로 표시해서
 * 화면에서 "새로 생긴 자리"를 강조할 수 있게 한다. maxGolfpangPages: 크론 배치(refreshAllWatches)는
 * 서브리퀘스트 예산 때문에 1(페이지 1만)로 부르고, 사용자가 "🔄 지금 새로고침"을 직접 눌렀을 때는
 * index.js에서 더 큰 값으로 불러서 정확한 결과를 준다. */
export async function refreshWatch(env, watchId, opts = {}) {
  const watches = await listWatches(env);
  const idx = watches.findIndex((w) => w.id === watchId);
  if (idx === -1) return null;
  await applyWatchRefresh(env, watches[idx], opts);
  await saveWatches(env, watches);
  return watches[idx];
}

/** Cron 트리거에서 호출 - 활성 상태고 아직 지나지 않은 날짜의 워치만 순서대로 갱신한다.
 * Worker 서브리퀘스트 한도(무료 플랜 기준 요청당 50개, 워치 하나당 최대 3개 소모 - 골팡 지역별
 * 호출 + 카카오 검색 + 카카오 상세) 안에서 안전하게 처리하려고 한 번에 최대 15개까지만 처리한다
 * (개인용 앱이라 동시에 활성 워치가 많지 않을 걸 전제로 한 값 - 실사용 중 부족하면 늘릴 것).
 * KV는 배치 전체에 대해 읽기 1번/쓰기 1번만 한다 - 예전엔 워치마다 refreshWatch를 그대로
 * 호출해서 15개면 KV 읽기/쓰기가 각각 15번씩 반복됐는데(불필요한 낭비이자, courses.js/
 * bulkAddWatches 등에서 이미 고쳤던 것과 같은 종류의 KV 레이스 컨디션 위험도 있었다 - 크론이
 * 배치를 도는 몇 초 사이 사용자가 앱에서 워치를 추가/삭제하면 서로의 쓰기를 덮어쓸 수 있었음),
 * targets가 watches 배열 안의 같은 객체를 참조한다는 점을 이용해 메모리에서 다 갱신한 뒤
 * 마지막에 한 번만 저장한다. */
export async function refreshAllWatches(env) {
  const watches = await listWatches(env);
  const today = new Date().toISOString().slice(0, 10);
  // 감시 날짜가 지난 워치(부킹/조인 모두)는 더 이상 갱신할 이유가 없으니 크론이 도는 김에
  // 같이 정리한다 - 예전엔 갱신 대상에서만 빠지고 목록엔 계속 남아있어서 부킹/조인 탭
  // 모니터링 목록에 지난 날짜가 계속 쌓이는 문제가 있었다.
  const kept = watches.filter((w) => w.date >= today);
  const targets = kept.filter((w) => w.active).slice(0, 15);
  for (const watch of targets) {
    await applyWatchRefresh(env, watch, { maxGolfpangPages: 1 });
  }
  await saveWatches(env, kept);
  return targets.length;
}
