// 골프장 마스터 DB(즐겨찾기) KV CRUD. 개인 규모라 단일 JSON 배열로 저장 (기획서 3-1 골프장 마스터 DB 구조 참고).
import { distanceKm } from './kakao.js';
import { getSettings } from './settings.js';

const COURSES_KEY = 'courses';

export async function listCourses(env) {
  const raw = await env.GOLF_KV.get(COURSES_KEY, 'json');
  return raw || [];
}

async function saveCourses(env, courses) {
  await env.GOLF_KV.put(COURSES_KEY, JSON.stringify(courses));
}

async function withHomeDistance(env, record) {
  if (record.lat == null || record.lon == null) return record;
  const settings = await getSettings(env);
  if (settings.homeLat == null || settings.homeLon == null) return record;
  return {
    ...record,
    homeDistanceKm: distanceKm(settings.homeLat, settings.homeLon, record.lat, record.lon),
  };
}

function normalizeCourse(input, existing = {}) {
  const now = new Date().toISOString();
  return {
    id: existing.id || crypto.randomUUID(),
    name: input.name ?? existing.name ?? '',
    address: input.address ?? existing.address ?? '',
    lat: input.lat != null ? Number(input.lat) : existing.lat ?? null,
    lon: input.lon != null ? Number(input.lon) : existing.lon ?? null,
    bookingPhone: input.bookingPhone ?? existing.bookingPhone ?? '',
    bookingRule: input.bookingRule ?? existing.bookingRule ?? '',
    courseList: Array.isArray(input.courseList) ? input.courseList : existing.courseList ?? [],
    cartFee: input.cartFee != null ? Number(input.cartFee) : existing.cartFee ?? null,
    caddyFee: input.caddyFee != null ? Number(input.caddyFee) : existing.caddyFee ?? null,
    bookingLinks: {
      golfpang: input.bookingLinks?.golfpang ?? existing.bookingLinks?.golfpang ?? '',
      coursePage: input.bookingLinks?.coursePage ?? existing.bookingLinks?.coursePage ?? '',
    },
    memo: input.memo ?? existing.memo ?? '',
    homeDistanceKm: existing.homeDistanceKm ?? null,
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };
}

export async function addCourse(env, input) {
  if (!input.name) throw new Error('골프장명(name)은 필수입니다');
  const courses = await listCourses(env);
  let record = normalizeCourse(input);
  record = await withHomeDistance(env, record);
  courses.push(record);
  await saveCourses(env, courses);
  return record;
}

export async function updateCourse(env, id, input) {
  const courses = await listCourses(env);
  const idx = courses.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  let record = normalizeCourse(input, courses[idx]);
  record = await withHomeDistance(env, record);
  courses[idx] = record;
  await saveCourses(env, courses);
  return record;
}

export async function deleteCourse(env, id) {
  const courses = await listCourses(env);
  const next = courses.filter((c) => c.id !== id);
  const changed = next.length !== courses.length;
  if (changed) await saveCourses(env, next);
  return changed;
}
