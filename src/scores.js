// 스코어 기록 KV CRUD. 개인 1인 사용 규모라 전체 목록을 단일 JSON 배열로 KV에 저장한다
// (레코드별 개별 키로 나누면 목록 조회 시 KV 읽기 횟수가 늘어나 무료 티어 한도에 불리하다).

const SCORES_KEY = 'scores';

export async function listScores(env) {
  const raw = await env.GOLF_KV.get(SCORES_KEY, 'json');
  return raw || [];
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
    shots: h?.shots != null && h.shots !== '' ? Number(h.shots) : null,
    putts: h?.putts != null && h.putts !== '' ? Number(h.putts) : null,
    score: h?.score != null && h.score !== '' ? Number(h.score) : null,
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
    courseRating: input.courseRating != null ? Number(input.courseRating) : existing.courseRating ?? null,
    status: ALLOWED_STATUS.includes(input.status) ? input.status : existing.status || 'done',
    memo: input.memo ?? existing.memo ?? '',
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
  scores.push(record);
  await saveScores(env, scores);
  return record;
}

export async function updateScore(env, id, input) {
  const scores = await listScores(env);
  const idx = scores.findIndex((s) => s.id === id);
  if (idx === -1) return null;
  const record = normalizeScore(input, scores[idx]);
  scores[idx] = record;
  await saveScores(env, scores);
  return record;
}

export async function deleteScore(env, id) {
  const scores = await listScores(env);
  const next = scores.filter((s) => s.id !== id);
  const changed = next.length !== scores.length;
  if (changed) await saveScores(env, next);
  return changed;
}
