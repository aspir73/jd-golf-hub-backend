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

const ALLOWED_SOURCES = ['직접입력', '보이스캐디', '스마트스코어', '종이스코어카드'];

function normalizeScore(input, existing = {}) {
  const now = new Date().toISOString();
  return {
    id: existing.id || crypto.randomUUID(),
    date: input.date ?? existing.date ?? now.slice(0, 10),
    courseName: input.courseName ?? existing.courseName ?? '',
    courseSubName: input.courseSubName ?? existing.courseSubName ?? '',
    totalScore: input.totalScore != null ? Number(input.totalScore) : existing.totalScore ?? null,
    fir: input.fir != null ? Number(input.fir) : existing.fir ?? null,
    gir: input.gir != null ? Number(input.gir) : existing.gir ?? null,
    putts: input.putts != null ? Number(input.putts) : existing.putts ?? null,
    courseRating: input.courseRating != null ? Number(input.courseRating) : existing.courseRating ?? null,
    source: ALLOWED_SOURCES.includes(input.source) ? input.source : existing.source || '직접입력',
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
