// 문화체육관광부 "전국 골프장 현황" 공식 DB (기준일 2024-12-31, data/문화체육관광부_전국 골프장 현황_20241231.csv 원본).
// 골프장 즐겨찾기 등록 자동완성, 플랫폼(골팡/카카오골프예약) 간 골프장명 매칭, 지역/구분별 탐색에 쓴다.
// 정적 참고자료라 KV가 아니라 리포지토리에 JSON으로 커밋해뒀다 - 배포 때마다 매번 재조회할 필요가 없어서.
import golfCourseDB from './data/golfCourseDB.json';

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
  return golfCourseDB
    .filter((c) => (!region || c.region === region) && (!type || c.type === type))
    .filter((c) => normalizeCourseName(c.name).includes(q) || c.name.includes(query))
    .slice(0, limit);
}

// 골팡/카카오골프예약/공식DB가 같은 골프장을 각자 다른 표기로 부르는 걸 맞추기 위한 정규화.
// 프론트(index.html)의 normalizeCourseName과 동일 규칙을 유지해야 매칭이 어긋나지 않는다 - 바꾸게 되면 양쪽 다 같이 고칠 것.
export function normalizeCourseName(name) {
  return (name || '')
    .replace(/\(.*?\)/g, '')
    .replace(/(컨트리클럽|컨트리\s*클럽|골프클럽|골프\s*클럽|골프리조트|리조트|앤리조트|골프장|CC|C\.C\.?|GC|G\.C\.?)/gi, '')
    .replace(/\s+/g, '')
    .trim();
}

/** 플랫폼에서 내려온 골프장명(rawName) -> 공식 DB 매칭. 지역을 같이 주면 동명이인(같은 이름, 다른 지역) 오매칭을 줄일 수 있다.
 *  정확히 일치하는 정규화명이 있으면 그걸, 없으면 포함관계로 가장 짧은(=더 구체적인) 후보를 돌려준다.
 *  확신이 없으면(후보가 여러 지역에 흩어져 있으면) null - 틀린 골프장에 갖다붙이는 것보단 매칭 안 하는 게 낫다. */
export function findBestMatch(rawName, { region } = {}) {
  const norm = normalizeCourseName(rawName);
  if (!norm) return null;

  const pool = region ? golfCourseDB.filter((c) => c.region === region) : golfCourseDB;

  const exact = pool.filter((c) => normalizeCourseName(c.name) === norm);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null; // 동명이인이 여러 지역에 있는데 지역 정보가 없어 못 좁힘

  const partial = pool.filter((c) => {
    const cn = normalizeCourseName(c.name);
    return cn.includes(norm) || norm.includes(cn);
  });
  if (partial.length === 1) return partial[0];
  return null;
}
