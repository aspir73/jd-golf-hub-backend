// 스코어 기록(KV 'scores') -> D1 rounds/holes 동기화. 앱이 쓰는 원본은 KV이고, 저장/수정/삭제 때마다 여기로
// upsert해서 리포트(roundReport.js)가 SQL로 집계할 수 있게 한다. D1 반영이 실패해도 스코어 저장 자체는 막지
// 않는다(호출부에서 try/catch) - 빠진 건 POST /api/reports/backfill 로 언제든 다시 채울 수 있다.

import { roundStats, resultOf } from './roundReport.js';

const bool01 = (v) => (v == null ? null : v ? 1 : 0);

function roundRow(r) {
  const st = roundStats(r.holes || []);
  const yearNum = Number((r.date || '').slice(0, 4)) || new Date().getFullYear();
  return [
    r.id, r.date, yearNum, r.courseName || '', r.courseSubName || '', r.outCourseName || '', r.inCourseName || '',
    r.teeBox || '', r.status || 'done', r.kgaCourseRating ?? null, r.kgaSlopeRating ?? null, r.kgaCourseLength ?? null, r.courseRating ?? null,
    st?.n ?? 0, st?.parSum ?? null, st?.score ?? r.totalScore ?? null, st?.toPar ?? null,
    st?.putts ?? null, st?.puttsHoles ?? null, st?.threePutts ?? null, st?.threeExtra ?? null,
    st?.fir?.hit ?? null, st?.fir?.n ?? null, st?.gir?.hit ?? null, st?.gir?.n ?? null,
    st?.dist.eagle ?? 0, st?.dist.birdie ?? 0, st?.dist.par ?? 0, st?.dist.bogey ?? 0, st?.dist.double ?? 0, st?.dist.triple ?? 0,
    st?.penaltyStrokes ?? 0, st?.ob ?? 0, st?.hazard ?? 0, st?.bunker ?? 0, st?.teeMissLeft ?? 0, st?.teeMissRight ?? 0, st?.mulligans ?? 0,
    JSON.stringify(r.companions || []), r.memo || '', r.summary ? JSON.stringify(r.summary) : null,
    r.createdAt || null, r.updatedAt || null,
    r.conditions ? JSON.stringify(r.conditions) : null, r.weather ? JSON.stringify(r.weather) : null,
  ];
}

const ROUND_SQL = `INSERT OR REPLACE INTO rounds (
  id, play_date, year, course_name, sub_course, out_course, in_course, tee_box, status, course_rating, slope_rating, course_length, user_rating,
  holes_played, par_played, total_score, to_par, putts, putts_holes, three_putts, three_putt_extra, fir_hit, fir_n, gir_hit, gir_n,
  eagle, birdie, par_cnt, bogey, double_cnt, triple_cnt, penalty_strokes, ob, hazard, bunker, tee_miss_left, tee_miss_right, mulligans,
  companions, memo, summary_json, created_at, updated_at, conditions_json, weather_json
) VALUES (${new Array(45).fill('?').join(',')})`;

// pro_json: 프로 모드 샷 단위 기록(scores.js normalizePro) - migrations/0006_holes_pro.sql
const HOLE_SQL = `INSERT OR REPLACE INTO holes (round_id, hole_no, sub_course, par, score, diff, result, shots, putts, penalty, mulligan, fairway_hit, green_hit, tee_shot, miss_dir, pro_json, entered_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

function statementsFor(env, r) {
  const db = env.PRICE_DB;
  const stmts = [db.prepare('DELETE FROM holes WHERE round_id = ?').bind(r.id), db.prepare(ROUND_SQL).bind(...roundRow(r))];
  for (const h of r.holes || []) {
    if (h.no == null) continue;
    const diff = h.score != null && h.par != null ? h.score - h.par : null;
    const sub = h.no <= 9 ? (r.outCourseName || '') : (r.inCourseName || r.outCourseName || '');
    stmts.push(db.prepare(HOLE_SQL).bind(
      r.id, h.no, sub, h.par ?? null, h.score ?? null, diff, diff != null ? resultOf(diff) : null,
      h.shots ?? null, h.putts ?? null, h.penalty ?? 0, h.mulligan ? 1 : 0, bool01(h.fairwayHit), bool01(h.greenHit),
      h.teeShot || null, h.missDir || null, h.pro ? JSON.stringify(h.pro) : null, h.at || null,
    ));
  }
  return stmts;
}

/** 간단 입력(홀 기록 없음)도 rounds에는 총타수만 넣는다. */
export async function syncRoundToDb(env, record) {
  if (!env.PRICE_DB || !record?.id) return;
  await env.PRICE_DB.batch(statementsFor(env, record));
}

export async function removeRoundFromDb(env, id) {
  if (!env.PRICE_DB || !id) return;
  await env.PRICE_DB.batch([
    env.PRICE_DB.prepare('DELETE FROM holes WHERE round_id = ?').bind(id),
    env.PRICE_DB.prepare('DELETE FROM rounds WHERE id = ?').bind(id),
  ]);
}

/** KV의 모든 스코어 기록을 D1에 다시 채운다(idempotent). 기록 삭제로 남은 고아 행도 정리한다. */
export async function backfillRoundsToDb(env, scores) {
  if (!env.PRICE_DB) throw new Error('PRICE_DB(D1) 바인딩이 없습니다');
  let n = 0;
  for (const r of scores) {
    await env.PRICE_DB.batch(statementsFor(env, r));
    n += 1;
  }
  const ids = scores.map((r) => r.id);
  const { results } = await env.PRICE_DB.prepare('SELECT id FROM rounds').all();
  const orphans = results.map((x) => x.id).filter((id) => !ids.includes(id));
  for (const id of orphans) await removeRoundFromDb(env, id);
  return { synced: n, orphansRemoved: orphans.length };
}
