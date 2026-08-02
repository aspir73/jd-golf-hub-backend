// 동반예약(백업) 비교 그룹 KV CRUD (기획서 3-1 "같은 목적의 라운딩을 여러 골프장에 동시 가예약한 경우
// 그룹으로 묶어서 한 화면에서 비교"). 그룹 = 제목 + 후보(candidates) 목록.

const GROUPS_KEY = 'comparisonGroups';

export async function listGroups(env) {
  const raw = await env.GOLF_KV.get(GROUPS_KEY, 'json');
  return raw || [];
}

async function saveGroups(env, groups) {
  await env.GOLF_KV.put(GROUPS_KEY, JSON.stringify(groups));
}

function normalizeCandidate(input) {
  return {
    id: crypto.randomUUID(),
    source: input.source === 'manual' ? 'manual' : 'golfpang',
    mode: input.mode === 'join' ? 'join' : 'booking',
    golfpangIdx: input.golfpangIdx || null,
    courseName: input.courseName || '',
    region: input.region || '',
    date: input.date || '',
    time: input.time || '',
    holes: input.holes || '',
    greenFee: input.greenFee != null ? Number(input.greenFee) : null,
    nickname: input.nickname || '',
    caddyType: input.caddyType || '',
    category: input.category || '',
  };
}

export async function addGroup(env, input) {
  if (!input.title) throw new Error('title(그룹명)은 필수입니다');
  const groups = await listGroups(env);
  const record = {
    id: crypto.randomUUID(),
    title: input.title,
    candidates: Array.isArray(input.candidates) ? input.candidates.map(normalizeCandidate) : [],
    createdAt: new Date().toISOString(),
  };
  groups.push(record);
  await saveGroups(env, groups);
  return record;
}

export async function addCandidate(env, groupId, input) {
  const groups = await listGroups(env);
  const group = groups.find((g) => g.id === groupId);
  if (!group) return null;
  const candidate = normalizeCandidate(input);
  group.candidates.push(candidate);
  await saveGroups(env, groups);
  return group;
}

export async function removeCandidate(env, groupId, candidateId) {
  const groups = await listGroups(env);
  const group = groups.find((g) => g.id === groupId);
  if (!group) return null;
  group.candidates = group.candidates.filter((c) => c.id !== candidateId);
  await saveGroups(env, groups);
  return group;
}

export async function deleteGroup(env, groupId) {
  const groups = await listGroups(env);
  const next = groups.filter((g) => g.id !== groupId);
  const changed = next.length !== groups.length;
  if (changed) await saveGroups(env, next);
  return changed;
}

export async function getGroup(env, groupId) {
  const groups = await listGroups(env);
  return groups.find((g) => g.id === groupId) || null;
}
