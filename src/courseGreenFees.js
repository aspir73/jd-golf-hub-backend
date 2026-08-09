// MY골프장 카드에 "향후 7일 요일별 최저 그린피"를 보여주기 위한 조회 로직.
// 카카오골프예약 검색 API는 지역 단위로 검색하면 그 지역 골프장 전체의 그날 최저 그린피
// (minGreenFeeDC)를 한 번에 내려준다(개별 골프장마다 따로 검색할 필요가 없음 - 부킹 조건검색
// 결과 카드에서 쓰는 것과 같은 값). 그래서 즐겨찾기를 지역별로 묶어서 "지역당 7번(하루 1번씩)"만
// 호출하면, 즐겨찾기 개수가 많아져도 호출 수는 지역 수 × 7로만 늘어나서 효율적이다.

import { searchKakaoGolfRounds } from './kakaogolf.js';
import { normalizeCourseName } from './golfCourseDB.js';
import { DB_REGION_TO_NORMALIZED, NORMALIZED_REGION_CODES } from './regionMap.js';

/** 오늘(KST) 기준 +offset일의 "YYYY-MM-DD" */
function dateStrForOffset(offset) {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const d = new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate() + offset));
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function courseNameMatches(row, course) {
  if (row.officialName && row.officialName === course.name) return true;
  const norm = normalizeCourseName(row.courseName || '');
  const target = normalizeCourseName(course.name);
  return Boolean(norm && target && norm === target);
}

/** courses: [{id, name, region}] - MY골프장 즐겨찾기 목록(지역 정보 필요, 없으면 그 골프장은
 * 건너뜀). 반환: { [courseId]: [day0Fee, day1Fee, ..., day6Fee] } (매칭 안 되거나 그 날 매물이
 * 없으면 null). 하루 조회가 실패해도 나머지 요일/골프장은 그대로 살린다. */
export async function resolveWeekGreenFees(env, courses) {
  const withRegion = courses.filter((c) => c.region && DB_REGION_TO_NORMALIZED[c.region]?.length);
  const result = {};
  withRegion.forEach((c) => { result[c.id] = new Array(7).fill(null); });
  if (!withRegion.length) return result;

  const byRegion = new Map();
  withRegion.forEach((c) => {
    if (!byRegion.has(c.region)) byRegion.set(c.region, []);
    byRegion.get(c.region).push(c);
  });

  await Promise.all([...byRegion.entries()].map(async ([region, regionCourses]) => {
    const normKeys = DB_REGION_TO_NORMALIZED[region] || [];
    const kakaoMajors = [...new Set(normKeys.map((k) => NORMALIZED_REGION_CODES[k]?.kakaoMajor).filter(Boolean))];
    if (!kakaoMajors.length) return;

    await Promise.all(Array.from({ length: 7 }, (_, offset) => offset).map(async (offset) => {
      try {
        const { rounds } = await searchKakaoGolfRounds(env, { date: dateStrForOffset(offset), areas: kakaoMajors });
        regionCourses.forEach((c) => {
          const match = rounds.find((r) => courseNameMatches(r, c) && r.matchCount > 0);
          if (match && match.greenFee != null) result[c.id][offset] = match.greenFee;
        });
      } catch {
        // 그 날짜 검색 실패 - 나머지 요일은 그대로 살린다
      }
    }));
  }));

  return result;
}
