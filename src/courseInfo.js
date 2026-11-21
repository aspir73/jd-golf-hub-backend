// 골프장별 코스(9홀 단위 루프 - 예: LAKE/CHALLENGE/CREEK, 또는 IN/OUT)와 홀별 파, 그리고 코스
// 조합(2개 코스 묶음, 예: 레이크+챌린지)×티박스별 KGA식 코스레이팅/슬로프레이팅/코스길이.
// 문체부 공식 DB(golfCourseDB.js)에는 골프장명·지역·규모만 있고 이런 상세 데이터가 없어서, 이건
// 사용자가 골프장 홈페이지/코스레이팅확인서를 보고 직접 입력해서 채우는 별도 저장소다(스코어 탭
// "홀별 상세 입력"에서 파 정보를 자동으로 채우고, 라운드 시작 시 코스레이팅을 보여주는 데 씀).
// 개인 1인 사용 규모라 scores.js와 동일하게 전체 목록을 단일 JSON 배열로 KV에 저장한다.

import { normalizeCourseName } from './golfCourseDB.js';
import { getCourseHoleDbByName, enrichWithHoleDb } from './courseHoleDb.js';

const COURSE_INFO_KEY = 'courseInfoDb';
const TEE_BOXES = ['white', 'blue', 'red'];

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

/** 코스 조합(예: [레이크, 챌린지] - 2개면 18홀 조합, 1개면 그 자체가 이미 18홀인 단일 코스)
 * × 티박스 하나의 KGA식 코스레이팅/슬로프레이팅/코스길이. courseNames는 순서와 무관하게 같은
 * 조합으로 취급해야 해서 항상 정렬해서 저장한다(OUT/IN 어느 쪽으로 시작했는지와 무관하게 매칭). */
function normalizeRating(r) {
  const num = (v) => (v != null && v !== '' ? Number(v) : null);
  return {
    courseNames: Array.isArray(r?.courseNames) ? [...r.courseNames].filter((n) => n && n.trim()).sort() : [],
    teeBox: TEE_BOXES.includes(r?.teeBox) ? r.teeBox : 'white',
    courseRating: num(r?.courseRating),
    slopeRating: num(r?.slopeRating),
    courseLength: num(r?.courseLength),
  };
}

function normalizeCourseInfo(input, existing = {}) {
  const now = new Date().toISOString();
  const subCoursesInput = Array.isArray(input.subCourses) ? input.subCourses : null;
  const ratingsInput = Array.isArray(input.ratings) ? input.ratings : null;
  return {
    id: existing.id || crypto.randomUUID(),
    courseName: (input.courseName ?? existing.courseName ?? '').trim(),
    subCourses: subCoursesInput ? subCoursesInput.map(normalizeSubCourse) : existing.subCourses || [],
    ratings: ratingsInput ? ratingsInput.map(normalizeRating).filter((r) => r.courseNames.length) : existing.ratings || [],
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };
}

/** 같은 골프장이 회원제/대중제로 나뉘어 있는 경우(예: 태광컨트리클럽(회원제) / (대중제))를 구분한다.
 * normalizeCourseName은 괄호 안 구분을 지워서 둘이 같은 이름이 되므로, 둘 다 구분 표기가 있으면 같은 구분일 때만
 * 같은 골프장으로 본다(한쪽만 표기가 있으면 구분 없이 같은 것으로 취급 - 예전 동작 유지). */
const kindOf = (n) => (/회원제/.test(n) ? 'member' : /대중제/.test(n) ? 'public' : '');
function sameCourseName(a, b) {
  if (a === b) return true;
  if (normalizeCourseName(a) !== normalizeCourseName(b)) return false;
  const ka = kindOf(a);
  const kb = kindOf(b);
  return !ka || !kb || ka === kb;
}

export async function getCourseInfoByName(env, courseName) {
  const list = await listCourseInfo(env);
  const target = (courseName || '').trim();
  if (!target) return null;
  // 정확히 같은 표기는 물론, "양평TPC" vs "양평TPC GC"처럼 골프장명 표기가 조금 다른 경우도
  // 매칭되도록 다른 모듈들(kgaCourseRating, courses, watches 등)과 동일하게 normalizeCourseName을
  // 쓴다 - 안 그러면 코스정보를 등록해둬도 부킹 다이얼로그에서 표기가 살짝만 달라도 못 찾는다.
  const own = list.find((c) => c.courseName === target) || list.find((c) => sameCourseName(c.courseName, target)) || null;
  // 직접 입력한 코스정보가 우선(파 포함 그대로), 전국 코스·홀 DB(D1)로 화이트 거리·핸디캡만 보충한다.
  // 직접 입력한 게 없으면 DB 값을 그대로 돌려준다(source: 'db' - 수정/삭제 대상이 아님).
  const dbInfo = await getCourseHoleDbByName(env, own?.courseName || target);
  if (own) return dbInfo ? enrichWithHoleDb(own, dbInfo) : own;
  return dbInfo;
}

/** 골프장 보기 화면용: 직접 입력한 코스정보(DB로 보충) + 전국 코스DB 원본(소개·티별 거리 표)을 함께 돌려준다. */
export async function getCourseView(env, courseName) {
  const list = await listCourseInfo(env);
  const target = (courseName || '').trim();
  if (!target) return { own: null, db: null };
  const own = list.find((c) => c.courseName === target) || list.find((c) => sameCourseName(c.courseName, target)) || null;
  const db = await getCourseHoleDbByName(env, own?.courseName || target);
  return { own: own ? (db ? enrichWithHoleDb(own, db) : own) : null, db };
}

export async function addCourseInfo(env, input) {
  if (!input.courseName || !input.courseName.trim()) throw new Error('courseName은 필수입니다');
  const list = await listCourseInfo(env);
  if (list.some((c) => sameCourseName(c.courseName, input.courseName.trim()))) {
    throw new Error('이미 등록된 골프장입니다. 수정으로 진행해주세요');
  }
  const record = normalizeCourseInfo(input);
  list.push(record);
  await saveCourseInfo(env, list);
  return record;
}

/** 여러 골프장 코스정보를 KV 읽기 1번/쓰기 1번으로 한꺼번에 등록한다. addCourseInfo를 연달아 호출하면 KV(최종 일관성)가
 * 이전 쓰기를 못 보고 목록을 덮어써서 먼저 넣은 항목이 사라지는 문제가 실제로 있었다(courses.js bulkAddCourses와 같은 이유).
 * 이미 있는 이름은 건너뛰고 결과를 돌려준다. */
export async function bulkAddCourseInfo(env, items) {
  const list = await listCourseInfo(env);
  const result = { added: [], skipped: [], failed: [] };
  for (const input of items) {
    const name = (input?.courseName || '').trim();
    if (!name) { result.failed.push({ courseName: '', error: 'courseName 없음' }); continue; }
    if (list.some((c) => sameCourseName(c.courseName, name))) { result.skipped.push(name); continue; }
    list.push(normalizeCourseInfo(input));
    result.added.push(name);
  }
  if (result.added.length) await saveCourseInfo(env, list);
  return result;
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
