// 골프장 조인/부킹 가격 히스토리(D1). 집에 있는 NAS가 매일 새벽 1시에 골팡을 수집해서
// POST /api/price-dashboard/ingest 로 원자료(raw row)를 그대로 밀어넣고(nas-collector/README.md 참고),
// 여기서는 공식 골프장명 매칭 + 저장 + 대시보드용 집계 쿼리만 담당한다. Cloudflare Workers의
// 서브리퀘스트 한도 때문에 수집 자체는 Worker 쪽에서 하지 않는다(watches.js의 refreshAllWatches가
// 이미 이 한도로 워치 15개까지만 처리하는 것과 같은 이유).

import { findBestMatch } from './golfCourseDB.js';

const LEADTIME_BUCKETS = [
  { label: '0-3일', min: 0, max: 3 },
  { label: '4-7일', min: 4, max: 7 },
  { label: '8-14일', min: 8, max: 14 },
  { label: '15-30일', min: 15, max: 30 },
  { label: '31일+', min: 31, max: Infinity },
];

function toDateOnly(str) {
  // "YYYY-MM-DD" 외의 형태가 섞여 들어와도(예: 시간 포함) 앞 10자리만 날짜로 취급.
  return (str || '').slice(0, 10);
}

function daysBetween(fromDate, toDate) {
  const a = new Date(`${fromDate}T00:00:00Z`);
  const b = new Date(`${toDate}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

/** NAS가 region×date×mode 조합 하나를 수집할 때마다 즉시 이 함수를 호출한다(부분 실패에도 이미
 * 보낸 데이터는 보존됨). rows는 골팡 파싱 결과 그대로(courseName, time, holes, greenFee, caddyType) -
 * 공식명 매칭(findBestMatch)과 lead_days/weekday 계산은 여기서 한 번만 하면 되므로 NAS 쪽 Python
 * 스크립트에 golfCourseDB.js 로직을 이식할 필요가 없다. */
export async function ingestPriceSnapshot(env, { collectedDate, roundDate, regionGroup, mode, rows }) {
  const cDate = toDateOnly(collectedDate);
  const rDate = toDateOnly(roundDate);
  if (!cDate || !rDate) throw new Error('collectedDate, roundDate(YYYY-MM-DD)가 필요합니다');
  if (!['hangang', 'gangbuk', 'gangwon', 'chungcheong'].includes(regionGroup)) {
    throw new Error('regionGroup 값이 올바르지 않습니다');
  }
  if (!['booking', 'join'].includes(mode)) throw new Error('mode는 booking|join 이어야 합니다');
  if (!Array.isArray(rows) || !rows.length) return { inserted: 0 };

  const leadDays = daysBetween(cDate, rDate);
  const weekday = new Date(`${rDate}T00:00:00Z`).getUTCDay();

  const stmt = env.PRICE_DB.prepare(
    `INSERT INTO price_snapshots
      (collected_date, round_date, lead_days, weekday, region_group, mode,
       course_name_raw, official_course_name, time, holes, green_fee, caddy_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const batch = rows
    .filter((r) => r && r.courseName)
    .map((r) =>
      stmt.bind(
        cDate,
        rDate,
        leadDays,
        weekday,
        regionGroup,
        mode,
        r.courseName,
        findBestMatch(r.courseName)?.name || null,
        r.time || null,
        r.holes || null,
        r.greenFee != null ? Number(r.greenFee) : null,
        r.caddyType || null
      )
    );
  if (!batch.length) return { inserted: 0 };
  await env.PRICE_DB.batch(batch);
  return { inserted: batch.length };
}

/** 대시보드 골프장 선택 목록 - 지금까지 관측된 official_course_name마다 가장 최근 수집일의 최저가를 곁들인다. */
export async function listTrackedCourses(env) {
  const { results } = await env.PRICE_DB.prepare(
    `SELECT official_course_name AS courseName,
            COUNT(*) AS sampleCount,
            MIN(green_fee) AS minGreenFee,
            MAX(collected_date) AS lastCollectedDate
     FROM price_snapshots
     WHERE official_course_name IS NOT NULL
     GROUP BY official_course_name
     ORDER BY courseName`
  ).all();
  return results;
}

/** 골프장 하나의 시계열(라인차트용) - round_date별로, 같은 라운드일이 여러 번 관측됐으면 그중
 * 가장 최근 수집치를 대표값으로 쓴다(리드타임 추이는 getLeadTimeTrend에서 따로 본다). */
export async function getCourseHistory(env, { courseName, days = 90 }) {
  if (!courseName) throw new Error('courseName이 필요합니다');
  const { results } = await env.PRICE_DB.prepare(
    `SELECT round_date AS roundDate, MIN(green_fee) AS minGreenFee, AVG(green_fee) AS avgGreenFee, COUNT(*) AS sampleCount
     FROM price_snapshots
     WHERE official_course_name = ?
       AND collected_date >= date('now', ?)
     GROUP BY round_date
     ORDER BY round_date`
  ).bind(courseName, `-${Number(days) || 90} days`).all();
  return results;
}

/** 요일별 평균 그린피 - "무슨 요일이 저렴한지" 학습용. */
export async function getWeekdayTrend(env, { courseName }) {
  if (!courseName) throw new Error('courseName이 필요합니다');
  const { results } = await env.PRICE_DB.prepare(
    `SELECT weekday, AVG(green_fee) AS avgGreenFee, COUNT(*) AS sampleCount
     FROM price_snapshots
     WHERE official_course_name = ? AND green_fee IS NOT NULL
     GROUP BY weekday
     ORDER BY weekday`
  ).bind(courseName).all();
  // 0(일)~6(토) 전부 채워서 반환 - 데이터 없는 요일은 null로 표시(프론트에서 빈 막대 처리).
  const byWeekday = new Map(results.map((r) => [r.weekday, r]));
  return Array.from({ length: 7 }, (_, w) => byWeekday.get(w) || { weekday: w, avgGreenFee: null, sampleCount: 0 });
}

/** 리드타임(라운드일까지 남은 일수) 구간별 평균 그린피 - "며칠 전에 예약해야 저렴한지" 학습용. */
export async function getLeadTimeTrend(env, { courseName }) {
  if (!courseName) throw new Error('courseName이 필요합니다');
  const { results } = await env.PRICE_DB.prepare(
    `SELECT lead_days AS leadDays, green_fee AS greenFee
     FROM price_snapshots
     WHERE official_course_name = ? AND green_fee IS NOT NULL`
  ).bind(courseName).all();

  return LEADTIME_BUCKETS.map((b) => {
    const inBucket = results.filter((r) => r.leadDays >= b.min && r.leadDays <= b.max);
    const avg = inBucket.length ? inBucket.reduce((sum, r) => sum + r.greenFee, 0) / inBucket.length : null;
    return { label: b.label, avgGreenFee: avg, sampleCount: inBucket.length };
  });
}

/** 오늘(또는 지정 날짜) 기준, 지역별 최저가 골프장 Top N - 대시보드 요약 카드용. */
export async function getLowestToday(env, { region, roundDate, limit = 10 } = {}) {
  const date = toDateOnly(roundDate) || new Date().toISOString().slice(0, 10);
  const conditions = ['round_date = ?', 'green_fee IS NOT NULL', 'official_course_name IS NOT NULL'];
  const params = [date];
  if (region) {
    conditions.push('region_group = ?');
    params.push(region);
  }
  const { results } = await env.PRICE_DB.prepare(
    `SELECT official_course_name AS courseName, region_group AS regionGroup, MIN(green_fee) AS minGreenFee
     FROM price_snapshots
     WHERE ${conditions.join(' AND ')}
     GROUP BY official_course_name
     ORDER BY minGreenFee ASC
     LIMIT ?`
  ).bind(...params, limit).all();
  return { date, results };
}
