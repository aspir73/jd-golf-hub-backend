// 골프장 마스터 DB(즐겨찾기) KV CRUD. 개인 규모라 단일 JSON 배열로 저장 (기획서 3-1 골프장 마스터 DB 구조 참고).
import { distanceKm, coordToRegion } from './kakao.js';
import { getSettings } from './settings.js';

const COURSES_KEY = 'courses';

// 카카오 좌표역지오코딩(coordToRegion)이 돌려주는 시/도 전체 명칭을 문체부 DB 표기(짧은 형태)로
// 맞춘다 - MY골프장 지역 필터가 이 값을 기준으로 동작한다.
const SIDO_TO_DB_REGION = {
  '서울특별시': '서울', '부산광역시': '부산', '대구광역시': '대구', '인천광역시': '인천',
  '광주광역시': '광주', '대전광역시': '대전', '울산광역시': '울산', '세종특별자치시': '세종',
  '경기도': '경기', '강원도': '강원', '강원특별자치도': '강원',
  '충청북도': '충북', '충청남도': '충남', '전라북도': '전북', '전북특별자치도': '전북',
  '전라남도': '전남', '경상북도': '경북', '경상남도': '경남', '제주특별자치도': '제주',
};

/** region이 없는데 좌표는 있는 기존 즐겨찾기(지역 필터 추가 전에 등록된 것들)를 카카오
 * 좌표역지오코딩으로 채워준다. 실패해도 목록 조회 자체를 막지 않도록 조용히 넘어간다. */
async function backfillRegion(env, record) {
  if (record.region || record.lat == null || record.lon == null) return false;
  try {
    const geo = await coordToRegion(env, record.lat, record.lon);
    if (geo?.sido) {
      record.region = SIDO_TO_DB_REGION[geo.sido] || '';
      return Boolean(record.region);
    }
  } catch {
    // 실패해도 조용히 무시 - 지역 필터 하나 덜 맞는 것뿐, 목록 조회를 막으면 안 됨
  }
  return false;
}

export async function listCourses(env) {
  const raw = await env.GOLF_KV.get(COURSES_KEY, 'json');
  const courses = raw || [];
  let changed = false;
  for (const c of courses) {
    if (await backfillRegion(env, c)) changed = true;
  }
  if (changed) await saveCourses(env, courses);
  return courses;
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
    // 문체부 공식 DB의 지역(시/도) 값 - MY골프장 지역 필터링에 씀(추가할 때 DB 매칭 결과로
    // 자동 채워짐. 검색 결과에서 직접 고른 카카오 장소는 지역 정보가 없어서 빈 값일 수 있음).
    region: input.region ?? existing.region ?? '',
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

/** MY골프장 카드를 위/아래로 한 칸 옮긴다 - 저장은 단순 JSON 배열이라 목록 순서 자체가 곧
 * 표시 순서다(별도 order 필드 없이 배열 안에서 인접 항목과 자리를 바꾸는 방식). */
export async function moveCourse(env, id, direction) {
  const courses = await listCourses(env);
  const idx = courses.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (targetIdx < 0 || targetIdx >= courses.length) return courses; // 맨 위/아래에서는 더 이동 못 함(에러 아님)
  [courses[idx], courses[targetIdx]] = [courses[targetIdx], courses[idx]];
  await saveCourses(env, courses);
  return courses;
}
