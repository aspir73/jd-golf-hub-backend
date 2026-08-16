// 골프장별 코스(9홀 단위 루프 - 예: LAKE/CHALLENGE/CREEK, 또는 IN/OUT)와 홀별 파·핸디캡 정보.
// 문체부 공식 DB(golfCourseDB.js)에는 골프장명·지역·규모만 있고 홀별 데이터가 없어서, 이건 사용자가
// 직접 입력해서 채우는 별도 저장소다(스코어 탭 "홀별 상세 입력"에서 파 정보를 자동으로 채우는 데 씀).
// 개인 1인 사용 규모라 scores.js와 동일하게 전체 목록을 단일 JSON 배열로 KV에 저장한다.

const COURSE_INFO_KEY = 'courseInfoDb';

export async function listCourseInfo(env) {
  const raw = await env.GOLF_KV.get(COURSE_INFO_KEY, 'json');
  return raw || [];
}

async function saveCourseInfo(env, list) {
  await env.GOLF_KV.put(COURSE_INFO_KEY, JSON.stringify(list));
}

function normalizeHole(h, no) {
  const par = Number(h?.par);
  return {
    no,
    par: [3, 4, 5].includes(par) ? par : 4,
    handicap: h?.handicap != null && h.handicap !== '' ? Number(h.handicap) : null,
  };
}

function normalizeSubCourse(sc, idx) {
  const holesInput = Array.isArray(sc?.holes) ? sc.holes : [];
  const count = holesInput.length || 9;
  return {
    id: sc?.id || crypto.randomUUID(),
    name: (sc?.name || '').trim() || `코스${idx + 1}`,
    holes: Array.from({ length: count }, (_, i) => normalizeHole(holesInput[i], i + 1)),
  };
}

function normalizeCourseInfo(input, existing = {}) {
  const now = new Date().toISOString();
  const subCoursesInput = Array.isArray(input.subCourses) ? input.subCourses : null;
  return {
    id: existing.id || crypto.randomUUID(),
    courseName: (input.courseName ?? existing.courseName ?? '').trim(),
    subCourses: subCoursesInput ? subCoursesInput.map(normalizeSubCourse) : existing.subCourses || [],
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };
}

export async function getCourseInfoByName(env, courseName) {
  const list = await listCourseInfo(env);
  const target = (courseName || '').trim();
  if (!target) return null;
  return list.find((c) => c.courseName === target) || null;
}

export async function addCourseInfo(env, input) {
  if (!input.courseName || !input.courseName.trim()) throw new Error('courseName은 필수입니다');
  const list = await listCourseInfo(env);
  if (list.some((c) => c.courseName === input.courseName.trim())) {
    throw new Error('이미 등록된 골프장입니다. 수정으로 진행해주세요');
  }
  const record = normalizeCourseInfo(input);
  list.push(record);
  await saveCourseInfo(env, list);
  return record;
}

export async function updateCourseInfo(env, id, input) {
  const list = await listCourseInfo(env);
  const idx = list.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  const record = normalizeCourseInfo(input, list[idx]);
  list[idx] = record;
  await saveCourseInfo(env, list);
  return record;
}

export async function deleteCourseInfo(env, id) {
  const list = await listCourseInfo(env);
  const next = list.filter((c) => c.id !== id);
  const changed = next.length !== list.length;
  if (changed) await saveCourseInfo(env, next);
  return changed;
}
