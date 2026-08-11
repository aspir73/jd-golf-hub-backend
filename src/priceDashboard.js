// 골프장 부킹 가격 히스토리(D1). 집에 있는 NAS가 매일 새벽 1시에 골팡(부킹)과 카카오골프예약을
// 같이 수집해서 POST /api/price-dashboard/ingest 로 원자료(raw entry)를 그대로 밀어넣고
// (nas-collector/README.md 참고), 여기서는 공식 골프장명 매칭 + "골프장·라운드일·시간대" 단위로
// 두 플랫폼 중 더 싼 쪽만 남기는 병합 + 저장 + 대시보드용 집계 쿼리를 담당한다. Cloudflare
// Workers의 서브리퀘스트 한도 때문에 수집 자체는 Worker 쪽에서 하지 않는다(watches.js의
// refreshAllWatches가 이미 이 한도로 워치 15개까지만 처리하는 것과 같은 이유).

import { findBestMatch } from './golfCourseDB.js';

// "오전(~12시)/오후(12~16시)/야간(16시~)" - 카카오골프예약 자체 timeZone 버킷(오전 2 + 새벽 1 /
// 오후 4 / 야간 8)과 경계가 정확히 일치해서, 골팡의 개별 시간(HH:MM)도 같은 기준으로 묶으면 두
// 플랫폼을 "골프장+라운드일+시간대" 단위로 바로 비교할 수 있다.
function timeBucketOf(hhmm) {
  if (!hhmm) return null;
  const m = String(hhmm).match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const hour = Number(m[1]);
  if (hour < 12) return '오전';
  if (hour < 16) return '오후';
  return '야간';
}

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

/** NAS가 라운드일 하나를 수집할 때마다 이 함수를 한 번 호출한다(부분 실패에도 이미 보낸 날짜는
 * 보존됨). entries는 골팡(부킹)·카카오골프예약 양쪽에서 모은 원자료를 섞어서 그대로 보낸다:
 *   { source: 'golfpang'|'kakaogolf', regionGroup: 'hangang'|'gangbuk'|'gangwon'|'chungcheong'|null,
 *     courseName, time (골팡만, "HH:MM"), timeBucket ('오전'|'오후'|'야간'), greenFee, holes, caddyType }
 * regionGroup이 null인 경우는 카카오골프예약의 "서울/경기" 대권역이 한강이남/강북·경춘을 구분하지
 * 않기 때문(regionMap.js 주석 참고) - 같은 배치 안에 골팡이 같은 골프장을 hangang/gangbuk 중
 * 하나로 이미 보고했으면 그 값을 그대로 물려받고, 어느 쪽에서도 못 찾으면 hangang으로 채운다
 * (완벽하진 않지만, 매주 golfpang 쪽에서 점점 더 많은 골프장의 실제 지역이 채워지면서 보완된다).
 *
 * 공식명 매칭(findBestMatch)을 거친 뒤 "골프장+라운드일+시간대" 단위로 묶어서, 두 플랫폼 모두에
 * 값이 있으면(=중복) 더 싼 쪽 하나만 남기고 저장한다 - source 컬럼에 어느 쪽이 이겼는지 남긴다. */
export async function ingestPriceSnapshot(env, { collectedDate, roundDate, entries }) {
  const cDate = toDateOnly(collectedDate);
  const rDate = toDateOnly(roundDate);
  if (!cDate || !rDate) throw new Error('collectedDate, roundDate(YYYY-MM-DD)가 필요합니다');
  if (!Array.isArray(entries) || !entries.length) return { inserted: 0 };

  const leadDays = daysBetween(cDate, rDate);
  const weekday = new Date(`${rDate}T00:00:00Z`).getUTCDay();

  // 1) 공식명 매칭 + 유효성 필터
  const resolved = entries
    .filter((e) => e && e.courseName && e.greenFee != null)
    .map((e) => ({
      ...e,
      officialName: findBestMatch(e.courseName)?.name || null,
      timeBucket: e.timeBucket || timeBucketOf(e.time),
    }))
    .filter((e) => e.officialName && e.timeBucket);

  // 2) 카카오골프예약의 regionGroup:null(서울/경기 - 한강이남/강북·경춘 미구분)을, 같은 배치의
  // 골팡 결과에서 같은 골프장이 어느 지역으로 보고됐는지 찾아 물려받는다. 못 찾으면 hangang 기본값.
  const knownRegionByCourse = new Map();
  for (const e of resolved) {
    if (e.source === 'golfpang' && e.regionGroup) knownRegionByCourse.set(e.officialName, e.regionGroup);
  }
  for (const e of resolved) {
    if (!e.regionGroup) e.regionGroup = knownRegionByCourse.get(e.officialName) || 'hangang';
  }

  // 3) "골프장+시간대" 단위로 묶어서(라운드일은 이 배치 전체가 동일) 최저가만 남긴다.
  const groups = new Map();
  for (const e of resolved) {
    const key = `${e.officialName}::${e.timeBucket}`;
    const existing = groups.get(key);
    if (!existing || e.greenFee < existing.greenFee) groups.set(key, e);
  }

  const stmt = env.PRICE_DB.prepare(
    `INSERT INTO price_snapshots
      (collected_date, round_date, lead_days, weekday, region_group, mode,
       course_name_raw, official_course_name, time, holes, green_fee, caddy_type, source, time_bucket)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const batch = Array.from(groups.values()).map((e) =>
    stmt.bind(
      cDate,
      rDate,
      leadDays,
      weekday,
      e.regionGroup,
      'booking',
      e.courseName,
      e.officialName,
      e.time || null,
      e.holes || null,
      Number(e.greenFee),
      e.caddyType || null,
      e.source || null,
      e.timeBucket
    )
  );
  if (!batch.length) return { inserted: 0 };
  await env.PRICE_DB.batch(batch);
  return { inserted: batch.length, receivedEntries: entries.length, mergedFrom: resolved.length };
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
