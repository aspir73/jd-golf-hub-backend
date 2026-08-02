// 동반자(함께 라운딩하는 멤버) KV CRUD.

const COMPANIONS_KEY = 'companions';

export async function listCompanions(env) {
  const raw = await env.GOLF_KV.get(COMPANIONS_KEY, 'json');
  return raw || [];
}

async function saveCompanions(env, companions) {
  await env.GOLF_KV.put(COMPANIONS_KEY, JSON.stringify(companions));
}

function normalizeCompanion(input, existing = {}) {
  const now = new Date().toISOString();
  return {
    id: existing.id || crypto.randomUUID(),
    name: input.name ?? existing.name ?? '',
    phone: input.phone ?? existing.phone ?? '',
    kakaoNickname: input.kakaoNickname ?? existing.kakaoNickname ?? '',
    memo: input.memo ?? existing.memo ?? '',
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };
}

export async function addCompanion(env, input) {
  if (!input.name) throw new Error('이름(name)은 필수입니다');
  const companions = await listCompanions(env);
  const record = normalizeCompanion(input);
  companions.push(record);
  await saveCompanions(env, companions);
  return record;
}

export async function updateCompanion(env, id, input) {
  const companions = await listCompanions(env);
  const idx = companions.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  const record = normalizeCompanion(input, companions[idx]);
  companions[idx] = record;
  await saveCompanions(env, companions);
  return record;
}

export async function deleteCompanion(env, id) {
  const companions = await listCompanions(env);
  const next = companions.filter((c) => c.id !== id);
  const changed = next.length !== companions.length;
  if (changed) await saveCompanions(env, next);
  return changed;
}
