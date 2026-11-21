// 문화체육관광부 "전국 골프장 현황" 공식 DB (기준일 2024-12-31, 원본 CSV는 data/mcst_registrations.csv에 club_id와 함께 정리돼 있음).
// 골프장 즐겨찾기 등록 자동완성, 플랫폼(골팡/카카오골프예약) 간 골프장명 매칭, 지역/구분별 탐색에 쓴다.
// 정적 참고자료라 KV가 아니라 리포지토리에 JSON으로 커밋해뒀다 - 배포 때마다 매번 재조회할 필요가 없어서.
import golfCourseDB from './data/golfCourseDB.json';

// 골팡/카카오골프예약/공식DB가 같은 골프장을 각자 다른 표기로 부르는 걸 맞추기 위한 정규화.
// 프론트(index.html)의 normalizeCourseName과 동일 규칙을 유지해야 매칭이 어긋나지 않는다 - 바꾸게 되면 양쪽 다 같이 고칠 것.
export function normalizeCourseName(name) {
  return (name || '')
    .replace(/\(.*?\)/g, '')
    .replace(/(컨트리클럽|컨트리\s*클럽|골프클럽|골프\s*클럽|골프리조트|리조트|앤리조트|골프장|CC|C\.C\.?|GC|G\.C\.?)/gi, '')
    .replace(/\s+/g, '')
    .trim();
}

// golfCourseDB(541건)는 배포 시점에 고정된 정적 데이터라, 각 행의 정규화 이름을 요청마다 다시
// 계산하지 않고 모듈 로드 시 한 번만 미리 계산해둔다. findBestMatch는 골팡/카카오골프예약 검색
// 결과 매물 하나하나마다 호출되는데(golfpang.js parseRoundRows 등), 페이지네이션 도입 이후로는
// 검색 한 번에 최대 1,500행까지 처리할 수 있어서 - 매번 541건 전체를 정규화하면 요청 하나에서
// 정규화 연산이 80만 번 넘게 반복될 수 있었다. _norm은 내부용이라 응답으로 내보내기 전에 뗀다.
const golfCourseDBIndexed = golfCourseDB.map((c) => ({ ...c, _norm: normalizeCourseName(c.name) }));

function stripNorm(c) {
  if (!c) return c;
  const { _norm, ...rest } = c;
  return rest;
}

export function listGolfCourseDB({ region, type } = {}) {
  return golfCourseDB.filter(
    (c) => (!region || c.region === region) && (!type || c.type === type)
  );
}

/** 지역 목록(건수 포함) - 탐색 화면 드롭다운용 */
export function listRegions() {
  const counts = new Map();
  for (const c of golfCourseDB) counts.set(c.region, (counts.get(c.region) || 0) + 1);
  return [...counts.entries()].map(([region, count]) => ({ region, count })).sort((a, b) => a.region.localeCompare(b.region, 'ko'));
}

/** 즐겨찾기 등록 시 이름 검색용 자동완성. region/type으로 좁힐 수 있고, 기본은 이름 부분일치. */
export function searchGolfCourseDB(query, { region, type, limit = 20 } = {}) {
  const q = normalizeCourseName(query);
  if (!q) return [];
  return golfCourseDBIndexed
    .filter((c) => (!region || c.region === region) && (!type || c.type === type))
    .filter((c) => c._norm.includes(q) || c.name.includes(query))
    .slice(0, limit)
    .map(stripNorm);
}

/** 플랫폼에서 내려온 골프장명(rawName) -> 공식 DB 매칭. 지역을 같이 주면 동명이인(같은 이름, 다른 지역) 오매칭을 줄일 수 있다.
 *  정확히 일치하는 정규화명이 있으면 그걸, 없으면 포함관계로 가장 짧은(=더 구체적인) 후보를 돌려준다.
 *  확신이 없으면(후보가 여러 지역에 흩어져 있으면) null - 틀린 골프장에 갖다붙이는 것보단 매칭 안 하는 게 낫다. */
export function findBestMatch(rawName, { region } = {}) {
  const norm = normalizeCourseName(rawName);
  if (!norm) return null;

  const pool = region ? golfCourseDBIndexed.filter((c) => c.region === region) : golfCourseDBIndexed;

  const exact = pool.filter((c) => c._norm === norm);
  if (exact.length === 1) return stripNorm(exact[0]);
  if (exact.length > 1) return null; // 동명이인이 여러 지역에 있는데 지역 정보가 없어 못 좁힘

  const partial = pool.filter((c) => c._norm.includes(norm) || norm.includes(c._norm));
  if (partial.length === 1) return stripNorm(partial[0]);
  return null;
}
