// 스코어 기록 KV CRUD. 개인 1인 사용 규모라 전체 목록을 단일 JSON 배열로 KV에 저장한다
// (레코드별 개별 키로 나누면 목록 조회 시 KV 읽기 횟수가 늘어나 무료 티어 한도에 불리하다).

import { computeRoundSummary, baselinePuttsPerHole } from './roundSummary.js';
import { syncRoundToDb, removeRoundFromDb } from './roundDb.js';
import { captureRoundWeather } from './roundWeather.js';

const SCORES_KEY = 'scores';

export async function listScores(env) {
  const raw = (await env.GOLF_KV.get(SCORES_KEY, 'json')) || [];
  // 요약 기능 도입 전에 저장된 홀별 기록에는 summary가 없어서, 읽을 때 한 번 계산해 채운다(다음 저장 때 같이 영속화).
  for (const s of raw) {
    if (!s.summary && Array.isArray(s.holes) && s.holes.length) {
      s.summary = computeRoundSummary(s.holes, baselinePuttsPerHole(raw, s.id));
    }
  }
  return raw;
}

async function saveScores(env, scores) {
  await env.GOLF_KV.put(SCORES_KEY, JSON.stringify(scores));
}

// in_progress: 라운드 중 홀별 실시간 입력 진행중(스코어 탭에 "진행중인 라운드"로 상단 노출).
// done: 완료된 라운드(간단 입력은 항상 done, 홀별 입력은 18홀 다 돌거나 "라운드 종료"를 눌렀을 때 done).
const ALLOWED_STATUS = ['in_progress', 'done'];

/** 홀별 상세 입력(스코어 탭 "홀별 상세 입력" 모드) 한 홀 - par는 course-info에서 가져온 값을 그대로
 * 스냅샷해서 저장한다(나중에 그 골프장의 코스정보가 수정돼도 이미 기록한 라운드의 파는 안 바뀌게). */
function normalizeHoleScore(h) {
  const no = Number(h?.no);
  if (!Number.isFinite(no)) return null;
  return {
    no,
    par: h?.par != null && h.par !== '' ? Number(h.par) : null,
    // 홀 거리(m)·그 거리의 티 이름·홀 핸디캡 - 라운드 시작 시 코스정보/전국 코스DB에서 채워 둔 참고값(입력 화면 표시용).
    distM: h?.distM != null && h.distM !== '' ? Number(h.distM) : null,
    distTee: h?.distTee ? String(h.distTee) : null,
    handicap: h?.handicap != null && h.handicap !== '' ? Number(h.handicap) : null,
    shots: h?.shots != null && h.shots !== '' ? Number(h.shots) : null,
    putts: h?.putts != null && h.putts !== '' ? Number(h.putts) : null,
    // 페널티 타수(OB·해저드 등) - 스코어에 그대로 더해진다. 멀리건은 스코어에 영향 없이
    // 스코어카드에 표시만 남기는 참고 기록(공식 스트로크로 안 침).
    penalty: h?.penalty != null && h.penalty !== '' ? Number(h.penalty) : 0,
    mulligan: !!h?.mulligan,
    // 페어웨이 안착(FIR) - 파3는 애초에 페어웨이 티샷 개념이 없어서 프론트에서 항상 null로 보낸다.
    // null = 아직 모름(간단 입력 등) → FIR/GIR 분모에서 제외하려고 false와 구분해서 저장한다.
    fairwayHit: h?.par === 3 || h?.fairwayHit == null ? null : !!h.fairwayHit,
    greenHit: h?.greenHit == null ? null : !!h.greenHit, // 그린 적중(GIR) - 모든 홀에 적용
    // 상세 입력: 티샷 결과(fairway/rough/waste/bunker/hazard/ob)와 미스 방향(left/right/unknown)
    teeShot: ['fairway', 'rough', 'waste', 'bunker', 'hazard', 'ob'].includes(h?.teeShot) ? h.teeShot : null,
    missDir: ['left', 'right', 'unknown'].includes(h?.missDir) ? h.missDir : null,
    score: h?.score != null && h.score !== '' ? Number(h.score) : null,
    pro: normalizePro(h?.pro),
    // 이 홀 스코어를 처음 입력한 시각(ISO) - 홀당 소요시간·후반 체력·라운드 시간대 날씨 분석용(자동 기록)
    at: typeof h?.at === 'string' && !Number.isNaN(Date.parse(h.at)) ? h.at : null,
  };
}

// 라운드 조건(라운드당 1회 입력, 기본값: 그린 보통·컨디션 보통·친선·카트·캐디 있음).
// 그린 스피드 5단계(스팀프미터): vslow ~1.98m / slow 1.98~2.29 / normal 2.29~2.59 / fast 2.59~3.2 / vfast 3.2~
const COND_ENUMS = {
  greenSpeed: ['vslow', 'slow', 'normal', 'fast', 'vfast'],
  condition: ['good', 'normal', 'bad'],
  roundType: ['friendly', 'bet', 'competition'],
  cart: ['cart', 'walk'],
};
const COND_DEFAULTS = { greenSpeed: 'normal', condition: 'normal', roundType: 'friendly', cart: 'cart', caddie: true, practiced: false };
function normalizeConditions(c) {
  const out = { ...COND_DEFAULTS };
  if (c && typeof c === 'object') {
    for (const [k, list] of Object.entries(COND_ENUMS)) if (list.includes(c[k])) out[k] = c[k];
    if (c.caddie != null) out.caddie = !!c.caddie;
    if (c.practiced != null) out.practiced = !!c.practiced;
  }
  return out;
}

// 프로 모드(샷 단위 기록) - 티샷 1개 + 페어웨이공략(fw)/그린공략(ap)/스크램블링(sc) 각 최대 6개 + 퍼팅.
// res: green(그린적중/온그린) · fairway · twoOn(투온) · short/long/left/right(미스 방향). dist(m): 티샷 거리 또는 핀까지/남은 거리.
const PRO_CLUBS = ['DR', 'W3', 'U3', 'I4', 'I5', 'I6', 'I7', 'I8', 'I9', 'P', 'W52', 'W56', 'W58'];
const PRO_RES = ['green', 'fairway', 'twoOn', 'short', 'long', 'left', 'right'];
// cause: 미스 원인(컨택) / from: 스크램블링 시작 위치 / lie: 직전 샷 결과로 자동 판정한 라이
const PRO_CAUSES = ['top', 'fat', 'shank', 'hook', 'slice'];
const PRO_LIES = ['fairway', 'rough', 'bunker', 'fringe'];
const proNum = (v, max) => {
  const n = Number(v);
  return v != null && v !== '' && Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n) : null;
};

function normalizeProShot(s) {
  if (!s || typeof s !== 'object') return null;
  return {
    club: PRO_CLUBS.includes(s.club) ? s.club : null,
    res: PRO_RES.includes(s.res) ? s.res : null,
    bunker: !!s.bunker,
    ob: !!s.ob,
    hz: !!s.hz, // 해저드(페널티 구역)·분실구
    pen: proNum(s.pen, 5) ?? 0,
    dist: proNum(s.dist, 400),
    distSet: !!s.distSet, // 기본 거리(티샷 210m·페어웨이 180m)를 그대로 둔 게 아니라 직접 고른 거리인지
    cause: PRO_CAUSES.includes(s.cause) ? s.cause : null,
    from: PRO_LIES.includes(s.from) ? s.from : null,
    lie: PRO_LIES.includes(s.lie) ? s.lie : null,
  };
}

function normalizePro(p) {
  if (!p || typeof p !== 'object') return null;
  const list = (a) => (Array.isArray(a) ? a.slice(0, 6).map(normalizeProShot).filter(Boolean) : []);
  return {
    tee: normalizeProShot(p.tee),
    fw: list(p.fw),
    ap: list(p.ap),
    sc: list(p.sc),
    putt: {
      n: proNum(p.putt?.n, 9),
      first: proNum(p.putt?.first, 30),
      shortMiss: !!p.putt?.shortMiss,
      firstRes: ['short', 'long'].includes(p.putt?.firstRes) ? p.putt.firstRes : null, // 첫 퍼트 결과(거리감)
      slope: ['up', 'down', 'flat'].includes(p.putt?.slope) ? p.putt.slope : null, // 첫 퍼트 경사
    },
    manual: !!p.manual,
  };
}

/** 동반자 1명 - 이름 + 그날 그 동반자의 최종 스코어(선택, 참고 기록일 뿐 통계 집계 대상은 아님). */
function normalizeCompanion(c) {
  const name = (c?.name || '').trim();
  if (!name) return null;
  return {
    name,
    score: c?.score != null && c.score !== '' ? Number(c.score) : null,
  };
}

function normalizeScore(input, existing = {}) {
  const now = new Date().toISOString();
  return {
    id: existing.id || crypto.randomUUID(),
    date: input.date ?? existing.date ?? now.slice(0, 10),
    courseName: input.courseName ?? existing.courseName ?? '',
    courseSubName: input.courseSubName ?? existing.courseSubName ?? '',
    // 홀별 상세 입력 모드에서만 채워짐(어느 코스로 OUT/IN을 돌았는지) - 간단 입력 모드는 비워둔다.
    outCourseName: input.outCourseName ?? existing.outCourseName ?? '',
    inCourseName: input.inCourseName ?? existing.inCourseName ?? '',
    holes: Array.isArray(input.holes) ? input.holes.map(normalizeHoleScore).filter(Boolean) : existing.holes ?? null,
    totalScore: input.totalScore != null ? Number(input.totalScore) : existing.totalScore ?? null,
    fir: input.fir != null ? Number(input.fir) : existing.fir ?? null,
    gir: input.gir != null ? Number(input.gir) : existing.gir ?? null,
    putts: input.putts != null ? Number(input.putts) : existing.putts ?? null,
    // 개인 평점(1~5, "골프장 평점")과 별개 - 아래 kga* 필드는 라운드 시작 시 코스정보에 등록해둔
    // KGA식 코스레이팅/슬로프레이팅을 그대로 스냅샷한 값(핸디캡 지수 계산 등에 나중에 쓸 수 있게).
    courseRating: input.courseRating != null ? Number(input.courseRating) : existing.courseRating ?? null,
    teeBox: input.teeBox ?? existing.teeBox ?? '',
    kgaCourseRating: input.kgaCourseRating != null ? Number(input.kgaCourseRating) : existing.kgaCourseRating ?? null,
    kgaSlopeRating: input.kgaSlopeRating != null ? Number(input.kgaSlopeRating) : existing.kgaSlopeRating ?? null,
    // KGA 공식 데이터(야드)든 코스정보 직접입력(미터)이든, 프론트에서 항상 미터로 환산해서
    // 보내주므로 여기는 단위 구분 없이 미터로 저장한다.
    kgaCourseLength: input.kgaCourseLength != null ? Number(input.kgaCourseLength) : existing.kgaCourseLength ?? null,
    status: ALLOWED_STATUS.includes(input.status) ? input.status : existing.status || 'done',
    // 동반자 목록(이름 + 그 동반자의 최종 스코어) - 통계 집계 없이 그냥 기록용.
    companions: Array.isArray(input.companions) ? input.companions.map(normalizeCompanion).filter(Boolean) : existing.companions ?? [],
    memo: input.memo ?? existing.memo ?? '',
    // 라운드 조건 - 홀별 입력 화면이 보내줄 때만 저장한다(예전 라운드에 기본값을 지어내 붙이지 않음).
    conditions: input.conditions ? normalizeConditions(input.conditions) : existing.conditions ?? null,
    // 라운드 시간대 날씨 스냅샷 - 서버가 완료 저장 때 채운다(captureRoundWeather). 클라이언트 입력으로는 바꾸지 않는다.
    weather: existing.weather ?? null,
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };
}

export async function addScore(env, input) {
  if (!input.date || input.totalScore == null) {
    throw new Error('date, totalScore는 필수입니다');
  }
  const scores = await listScores(env);
  const record = normalizeScore(input);
  record.summary = Array.isArray(record.holes) ? computeRoundSummary(record.holes, baselinePuttsPerHole(scores, record.id)) : null;
  scores.push(record);
  await saveScores(env, scores);
  await syncRoundToDb(env, record).catch(() => {}); // 리포트용 D1 반영 - 실패해도 저장은 유지
  return record;
}

/** 여러 라운드를 KV 읽기 1번/쓰기 1번으로 한꺼번에 등록한다(과거 라운드 이관 등). addScore를 연달아 부르면 KV(최종 일관성)가
 * 이전 쓰기를 못 보고 덮어써서 먼저 넣은 기록이 사라질 수 있다. 같은 날짜+골프장 기록이 이미 있으면 건너뛴다. */
export async function bulkAddScores(env, inputs) {
  const scores = await listScores(env);
  const result = { added: [], skipped: [] };
  const records = [];
  for (const input of inputs) {
    if (!input.date || input.totalScore == null) { result.skipped.push({ date: input.date, reason: 'date/totalScore 필요' }); continue; }
    if (scores.some((x) => x.date === input.date && x.courseName === input.courseName)) { result.skipped.push({ date: input.date, reason: '이미 있음' }); continue; }
    const record = normalizeScore(input);
    record.summary = Array.isArray(record.holes) ? computeRoundSummary(record.holes, baselinePuttsPerHole(scores, record.id)) : null;
    scores.push(record);
    records.push(record);
    result.added.push({ id: record.id, date: record.date, totalScore: record.totalScore });
  }
  if (records.length) {
    await saveScores(env, scores);
    for (const r of records) await syncRoundToDb(env, r).catch(() => {});
  }
  return result;
}

export async function updateScore(env, id, input) {
  const scores = await listScores(env);
  const idx = scores.findIndex((s) => s.id === id);
  if (idx === -1) return null;
  const record = normalizeScore(input, scores[idx]);
  record.summary = Array.isArray(record.holes) ? computeRoundSummary(record.holes, baselinePuttsPerHole(scores, record.id)) : null;
  // 라운드 완료 저장 때 한 번만 그 시간대 날씨를 붙인다(실패하면 다음 저장 때 재시도).
  if (record.status === 'done' && !record.weather && Array.isArray(record.holes)) {
    record.weather = await captureRoundWeather(env, record).catch(() => null);
  }
  scores[idx] = record;
  await saveScores(env, scores);
  await syncRoundToDb(env, record).catch(() => {});
  return record;
}

export async function deleteScore(env, id) {
  const scores = await listScores(env);
  const next = scores.filter((s) => s.id !== id);
  const changed = next.length !== scores.length;
  if (changed) {
    await saveScores(env, next);
    await removeRoundFromDb(env, id).catch(() => {});
  }
  return changed;
}
