// 골프장 마스터 DB(즐겨찾기) KV CRUD. 개인 규모라 단일 JSON 배열로 저장 (기획서 3-1 골프장 마스터 DB 구조 참고).
import { coordToRegion, fetchDrivingRoute, searchKeyword } from './kakao.js';
import { getSettings } from './settings.js';
import { findBestMatch, normalizeCourseName } from './golfCourseDB.js';

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

/** homeDurationMin이 없는데 좌표+집 주소는 있는 기존 즐겨찾기(자동차 길찾기 도입 전에 등록됐거나,
 * 예전 직선거리 방식으로만 채워졌던 것들)를 실제 자동차 경로(거리+시간)로 다시 채운다. */
async function backfillHomeTravelInfo(env, record) {
  if (record.homeDurationMin != null || record.lat == null || record.lon == null) return false;
  try {
    const settings = await getSettings(env);
    if (settings.homeLat == null || settings.homeLon == null) return false;
    const route = await fetchDrivingRoute(env, settings.homeLat, settings.homeLon, record.lat, record.lon);
    if (!route) return false;
    record.homeDistanceKm = route.distanceKm;
    record.homeDurationMin = route.durationMin;
    return true;
  } catch {
    return false;
  }
}

export async function listCourses(env) {
  const raw = await env.GOLF_KV.get(COURSES_KEY, 'json');
  const courses = raw || [];
  // 보통은 이미 다 채워져 있어서(등록 시점에 채움) 여기서 실제로 API를 부르는 경우가 드물지만,
  // 혹시 한꺼번에 여러 건이 채워야 할 상태로 남아있으면(예: 이 필드들이 생기기 전에 등록된
  // 기존 데이터 마이그레이션) 골프장별로 순서대로 기다리지 않고 동시에 처리한다.
  const changedFlags = await Promise.all(courses.map(async (c) => {
    const a = await backfillRegion(env, c);
    const b = await backfillHomeTravelInfo(env, c);
    return a || b;
  }));
  if (changedFlags.some(Boolean)) await saveCourses(env, courses);
  return courses;
}

async function saveCourses(env, courses) {
  await env.GOLF_KV.put(COURSES_KEY, JSON.stringify(courses));
}

/** 집~골프장 자동차 거리/이동시간을 카카오모빌리티 길찾기로 계산해서 채운다(직선거리 근사 대신
 * 실제 도로 기준 - bookings.js의 resolveCourseTravelInfo와 같은 방식). */
async function withHomeDistance(env, record) {
  if (record.lat == null || record.lon == null) return record;
  const settings = await getSettings(env);
  if (settings.homeLat == null || settings.homeLon == null) return record;
  const route = await fetchDrivingRoute(env, settings.homeLat, settings.homeLon, record.lat, record.lon);
  return {
    ...record,
    homeDistanceKm: route?.distanceKm ?? record.homeDistanceKm ?? null,
    homeDurationMin: route?.durationMin ?? record.homeDurationMin ?? null,
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
    homeDurationMin: existing.homeDurationMin ?? null,
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };
}

/** input.name을 문체부 공식 DB와 매칭해서 표준 명칭/지역으로 정리하고("코리아cc" vs
 * "코리아컨트리클럽" 같은 표기 차이를 하나로 합침 - 중복 판정의 기준이 됨), courses(현재까지의
 * 즐겨찾기 배열)에 이미 같은 골프장이 있으면 예외를 던진다. 좌표가 없으면 카카오 검색으로
 * 좌표/주소/연락처도 최대한 채운다. courses 배열 자체는 건드리지 않는다(호출부가 push 시점을
 * 결정 - addCourse는 즉시, bulkAddCourses는 반복 중 계속 같은 배열에 누적). */
async function resolveNewCourseRecord(env, input, courses) {
  if (!input.name) throw new Error('골프장명(name)은 필수입니다');

  const matched = findBestMatch(input.name, { region: input.region || undefined });
  const resolvedName = matched?.name || input.name;
  const resolvedRegion = input.region || matched?.region || '';

  const normTarget = normalizeCourseName(resolvedName);
  const dup = courses.find((c) => normalizeCourseName(c.name) === normTarget);
  if (dup) {
    throw new Error(`이미 등록된 골프장입니다: ${dup.name}`);
  }

  const mergedInput = { ...input, name: resolvedName, region: resolvedRegion };

  // 좌표가 없으면(이름만으로 추가하는 경우 - 예: 일괄 등록) 카카오 검색으로 좌표/주소/연락처를
  // 최대한 자동으로 채운다. 실패해도 이름만으로는 등록을 계속 진행한다(부가정보라 필수는 아님).
  if (mergedInput.lat == null || mergedInput.lon == null) {
    try {
      const places = await searchKeyword(env, resolvedName);
      const best = places[0];
      if (best) {
        mergedInput.lat = mergedInput.lat ?? best.lat;
        mergedInput.lon = mergedInput.lon ?? best.lon;
        mergedInput.address = mergedInput.address || best.address;
        mergedInput.bookingPhone = mergedInput.bookingPhone || best.phone;
      }
    } catch {
      // 실패해도 조용히 무시
    }
  }

  let record = normalizeCourse(mergedInput);
  record = await withHomeDistance(env, record);
  return record;
}

export async function addCourse(env, input) {
  const courses = await listCourses(env);
  const record = await resolveNewCourseRecord(env, input, courses);
  courses.push(record);
  await saveCourses(env, courses);
  return record;
}

/** 골프장명 목록을 한 번에 등록한다. addCourse를 항목마다 반복 호출하면 매번 KV를 읽고-쓰는데,
 * Cloudflare KV는 최종 일관성(쓰기가 전세계에 반영되기까지 지연 가능)이라 짧은 간격으로 연달아
 * 호출하면 뒤 요청이 앞 요청의 쓰기를 못 보고 그대로 덮어써서 먼저 추가한 게 사라지는 문제가
 * 실제로 있었다(레이스 컨디션 - 34개 일괄 등록 중 11개가 이렇게 유실됐던 걸 발견하고 수정).
 * 그래서 목록 전체를 KV 읽기 1번 + 쓰기 1번으로 처리한다(항목별 결과는 메모리 상의 같은 배열에
 * 계속 누적해서 판단 - 중간에 KV를 다시 읽지 않으므로 레이스가 원천적으로 발생하지 않는다). */
export async function bulkAddCourses(env, names) {
  const courses = await listCourses(env);
  const results = { added: [], skipped: [], failed: [] };
  for (const rawName of names) {
    const name = (rawName || '').trim();
    if (!name) continue;
    try {
      const record = await resolveNewCourseRecord(env, { name }, courses);
      courses.push(record);
      results.added.push({ input: name, name: record.name, hasCoords: record.lat != null });
    } catch (e) {
      if ((e.message || '').includes('이미 등록된')) {
        results.skipped.push({ input: name, reason: e.message });
      } else {
        results.failed.push({ input: name, error: e.message });
      }
    }
  }
  await saveCourses(env, courses);
  return results;
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

/** MY골프장 카드를 드래그로 재정렬한 뒤, 프론트가 넘겨준 최종 순서(orderedIds)대로 배열을
 * 통째로 다시 저장한다 - 저장은 단순 JSON 배열이라 목록 순서 자체가 곧 표시 순서다(별도 order
 * 필드 없음). orderedIds에 없는 항목(동시 수정 등으로 최신 목록과 안 맞는 경우)은 데이터가
 * 사라지지 않도록 뒤에 그대로 이어붙인다. */
export async function reorderCourses(env, orderedIds) {
  const courses = await listCourses(env);
  const byId = new Map(courses.map((c) => [c.id, c]));
  const reordered = orderedIds.map((id) => byId.get(id)).filter(Boolean);
  const reorderedIdSet = new Set(reordered.map((c) => c.id));
  const missing = courses.filter((c) => !reorderedIdSet.has(c.id));
  const next = [...reordered, ...missing];
  await saveCourses(env, next);
  return next;
}
