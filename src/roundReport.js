// 라운드 리포트: D1(rounds/holes)에서 라운드 분석과 시즌 비교, 시즌 집계 리포트를 만든다.
// roundStats()는 홀 배열 -> 통계 한 가지 계산식이라, D1 행을 채울 때(roundDb.js)와 리포트를 만들 때 같이 쓴다.
// 라운드 분석(buildRoundAnalysis) 결과 모양은 프론트 index.html의 rrAnalysis()가 만들던 것과 같다.

const RESULT_KEYS = ['eagle', 'birdie', 'par', 'bogey', 'double', 'triple'];

export function resultOf(diff) {
  if (diff <= -2) return 'eagle';
  if (diff === -1) return 'birdie';
  if (diff === 0) return 'par';
  if (diff === 1) return 'bogey';
  if (diff === 2) return 'double';
  return 'triple';
}

/** holes: [{ no, par, score, putts, penalty, greenHit, fairwayHit, teeShot, missDir }] (greenHit/fairwayHit: true/false/null) */
export function roundStats(holes) {
  const played = (holes || []).filter((h) => h.score != null && h.par != null).sort((a, b) => a.no - b.no);
  const n = played.length;
  if (!n) return null;
  const score = played.reduce((s, h) => s + h.score, 0);
  const parSum = played.reduce((s, h) => s + h.par, 0);
  const dist = { eagle: 0, birdie: 0, par: 0, bogey: 0, double: 0, triple: 0 };
  played.forEach((h) => { dist[resultOf(h.score - h.par)] += 1; });
  const puttH = played.filter((h) => h.putts != null);
  const putts = puttH.reduce((s, h) => s + h.putts, 0);
  const girK = played.filter((h) => h.greenHit != null);
  const firK = played.filter((h) => h.par !== 3 && h.fairwayHit != null);
  const teeMiss = played.filter((h) => h.teeShot && h.teeShot !== 'fairway');
  return {
    n, score, parSum, toPar: score - parSum, dist, played,
    putts: puttH.length ? putts : null,
    puttsHoles: puttH.length,
    pph: puttH.length ? putts / puttH.length : null,
    threePutts: puttH.filter((h) => h.putts >= 3).length,
    threeExtra: puttH.reduce((s, h) => s + Math.max(0, h.putts - 2), 0),
    gir: girK.length ? { hit: girK.filter((h) => h.greenHit).length, n: girK.length } : null,
    fir: firK.length ? { hit: firK.filter((h) => h.fairwayHit).length, n: firK.length } : null,
    penaltyStrokes: played.reduce((s, h) => s + (h.penalty || 0), 0),
    ob: played.filter((h) => h.teeShot === 'ob').length,
    hazard: played.filter((h) => h.teeShot === 'hazard').length,
    bunker: played.filter((h) => h.teeShot === 'bunker').length,
    hasTee: played.some((h) => h.teeShot),
    teeMissLeft: teeMiss.filter((h) => h.missDir === 'left').length,
    teeMissRight: teeMiss.filter((h) => h.missDir === 'right').length,
    teeMissCount: teeMiss.length,
    mulligans: played.filter((h) => h.mulligan).length,
  };
}

const tri = (v) => (v == null ? null : v ? true : false);

/** D1 holes 행 -> 앱 홀 모양 */
export function holeFromRow(r) {
  return {
    no: r.hole_no, par: r.par, score: r.score, shots: r.shots, putts: r.putts, penalty: r.penalty || 0,
    mulligan: Boolean(r.mulligan), fairwayHit: tri(r.fairway_hit), greenHit: tri(r.green_hit),
    teeShot: r.tee_shot || null, missDir: r.miss_dir || null, subCourseName: r.sub_course || '',
  };
}

async function loadHolesFor(env, roundIds) {
  if (!roundIds.length) return new Map();
  const marks = roundIds.map(() => '?').join(',');
  const { results } = await env.PRICE_DB.prepare(`SELECT * FROM holes WHERE round_id IN (${marks}) ORDER BY round_id, hole_no`).bind(...roundIds).all();
  const map = new Map();
  for (const r of results) {
    if (!map.has(r.round_id)) map.set(r.round_id, []);
    map.get(r.round_id).push(holeFromRow(r));
  }
  return map;
}

function seasonFrom(statsList, allFullScores) {
  const full = statsList.filter((s) => s.n >= 18);
  const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  const totalN = statsList.reduce((s, x) => s + x.n, 0);
  const dist = {};
  RESULT_KEYS.forEach((k) => { dist[k] = totalN ? (statsList.reduce((s, x) => s + x.dist[k], 0) / totalN) * 100 : 0; });
  return {
    rounds: statsList.length,
    avgScore: mean(full.map((s) => s.score)),
    gir: mean(statsList.filter((s) => s.gir).map((s) => (s.gir.hit / s.gir.n) * 100)),
    fir: mean(statsList.filter((s) => s.fir).map((s) => (s.fir.hit / s.fir.n) * 100)),
    pph: mean(statsList.filter((s) => s.pph != null).map((s) => s.pph)),
    doubleRate: totalN ? (statsList.reduce((s, x) => s + x.dist.double + x.dist.triple, 0) / totalN) * 100 : null,
    dist: totalN ? dist : null,
    best: allFullScores.length ? Math.min(...allFullScores) : null,
  };
}

/** 한 라운드의 분석(시즌 비교 포함). round: D1 rounds 행(id, play_date, year). */
export async function buildRoundAnalysis(env, round) {
  const { results: otherRows } = await env.PRICE_DB
    .prepare("SELECT id, year FROM rounds WHERE status = 'done' AND id != ?").bind(round.id).all();
  const ids = [round.id, ...otherRows.map((r) => r.id)];
  const holeMap = await loadHolesFor(env, ids);
  const s = roundStats(holeMap.get(round.id));
  if (!s) return null;
  const others = otherRows.map((r) => ({ year: r.year, st: roundStats(holeMap.get(r.id)) })).filter((o) => o.st);
  const sea = seasonFrom(others.filter((o) => o.year === round.year).map((o) => o.st), others.map((o) => o.st).filter((x) => x.n >= 18).map((x) => x.score));

  const girPct = s.gir ? Math.round((s.gir.hit / s.gir.n) * 100) : null;
  const firPct = s.fir ? Math.round((s.fir.hit / s.fir.n) * 100) : null;
  const dblPct = Math.round(((s.dist.double + s.dist.triple) / s.n) * 100);
  const scoreVs = sea.avgScore != null && s.n >= 18 ? Math.round(sea.avgScore - s.score) : null;
  const girVs = girPct != null && sea.gir != null ? Math.round(girPct - sea.gir) : null;
  const pphVs = s.pph != null && sea.pph != null ? Math.round((s.pph - sea.pph) * 10) / 10 : null;

  const over = Math.max(0, s.toPar);
  const threeLoss = Math.min(over, s.threeExtra);
  const penLoss = Math.min(over - threeLoss, s.penaltyStrokes);
  const otherLoss = over - threeLoss - penLoss;

  const missed = s.played.filter((h) => h.greenHit === false);
  const saves = missed.filter((h) => h.score <= h.par).length;
  let best = 0, cur = 0, prev = null;
  s.played.forEach((h) => {
    if (h.score <= h.par && (prev == null || h.no === prev + 1 || cur === 0)) cur += 1; else cur = h.score <= h.par ? 1 : 0;
    prev = h.no;
    if (cur > best) best = cur;
  });
  const bogeys = s.dist.bogey;
  const bogey3 = s.played.filter((h) => h.score - h.par === 1 && h.putts != null && h.putts >= 3).length;

  const { played, ...stats } = s;
  return {
    s: stats, sea, girPct, firPct, dblPct, scoreVs, girVs, pphVs,
    over, threeLoss, penLoss, otherLoss,
    missed: missed.length, saves, parStreak: best,
    teeMissCount: s.teeMissCount, right: s.teeMissRight, left: s.teeMissLeft, bogeys, bogey3,
  };
}

/** 시즌 집계 리포트(rounds 테이블 컬럼만으로 SQL 집계). year 생략 시 올해. */
export async function buildSeasonReport(env, year) {
  const db = env.PRICE_DB;
  const y = Number(year) || new Date().getFullYear();
  const one = async (sql, ...binds) => (await db.prepare(sql).bind(...binds).first()) || {};
  const t = await one(`SELECT COUNT(*) AS rounds,
      SUM(CASE WHEN holes_played >= 18 THEN 1 ELSE 0 END) AS full_rounds,
      AVG(CASE WHEN holes_played >= 18 THEN total_score END) AS avg_score,
      MIN(CASE WHEN holes_played >= 18 THEN total_score END) AS best_score,
      MAX(CASE WHEN holes_played >= 18 THEN total_score END) AS worst_score,
      SUM(holes_played) AS holes, SUM(putts) AS putts, SUM(putts_holes) AS putts_holes,
      SUM(three_putts) AS three_putts, SUM(fir_hit) AS fir_hit, SUM(fir_n) AS fir_n, SUM(gir_hit) AS gir_hit, SUM(gir_n) AS gir_n,
      SUM(eagle) AS eagle, SUM(birdie) AS birdie, SUM(par_cnt) AS par_cnt, SUM(bogey) AS bogey, SUM(double_cnt) AS double_cnt, SUM(triple_cnt) AS triple_cnt,
      SUM(ob) AS ob, SUM(hazard) AS hazard, SUM(bunker) AS bunker, SUM(penalty_strokes) AS penalty_strokes,
      SUM(tee_miss_left) AS tee_miss_left, SUM(tee_miss_right) AS tee_miss_right
    FROM rounds WHERE year = ? AND status = 'done'`, y);
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
  const holes = t.holes || 0;
  const { results: byCourse } = await db.prepare(`SELECT course_name AS course, COUNT(*) AS rounds,
      AVG(CASE WHEN holes_played >= 18 THEN total_score END) AS avg_score,
      MIN(CASE WHEN holes_played >= 18 THEN total_score END) AS best_score
    FROM rounds WHERE year = ? AND status = 'done' GROUP BY course_name ORDER BY rounds DESC, course_name`).bind(y).all();
  const { results: trend } = await db.prepare(`SELECT id, play_date AS date, course_name AS course, holes_played, total_score AS score, to_par,
      putts, putts_holes, gir_hit, gir_n, fir_hit, fir_n, three_putts
    FROM rounds WHERE year = ? AND status = 'done' ORDER BY play_date DESC LIMIT 20`).bind(y).all();
  const { results: yearsRows } = await db.prepare("SELECT DISTINCT year FROM rounds WHERE status = 'done' ORDER BY year DESC").all();

  return {
    year: y,
    years: yearsRows.map((r) => r.year),
    rounds: t.rounds || 0,
    fullRounds: t.full_rounds || 0,
    avgScore: t.avg_score != null ? Math.round(t.avg_score * 10) / 10 : null,
    bestScore: t.best_score ?? null,
    worstScore: t.worst_score ?? null,
    puttsPerHole: t.putts_holes ? Math.round((t.putts / t.putts_holes) * 100) / 100 : null,
    threePuttsPerRound: t.rounds ? Math.round(((t.three_putts || 0) / t.rounds) * 10) / 10 : null,
    girPct: pct(t.gir_hit, t.gir_n),
    firPct: pct(t.fir_hit, t.fir_n),
    distribution: {
      eagle: { count: t.eagle || 0, pct: pct(t.eagle, holes) },
      birdie: { count: t.birdie || 0, pct: pct(t.birdie, holes) },
      par: { count: t.par_cnt || 0, pct: pct(t.par_cnt, holes) },
      bogey: { count: t.bogey || 0, pct: pct(t.bogey, holes) },
      double: { count: t.double_cnt || 0, pct: pct(t.double_cnt, holes) },
      triple: { count: t.triple_cnt || 0, pct: pct(t.triple_cnt, holes) },
    },
    trouble: { ob: t.ob || 0, hazard: t.hazard || 0, bunker: t.bunker || 0, penaltyStrokes: t.penalty_strokes || 0 },
    teeMiss: { left: t.tee_miss_left || 0, right: t.tee_miss_right || 0 },
    byCourse: byCourse.map((c) => ({ course: c.course, rounds: c.rounds, avgScore: c.avg_score != null ? Math.round(c.avg_score * 10) / 10 : null, bestScore: c.best_score ?? null })),
    trend: trend.reverse().map((r) => ({
      id: r.id, date: r.date, course: r.course, holes: r.holes_played, score: r.score, toPar: r.to_par,
      puttsPerHole: r.putts_holes ? Math.round((r.putts / r.putts_holes) * 100) / 100 : null,
      girPct: pct(r.gir_hit, r.gir_n), firPct: pct(r.fir_hit, r.fir_n), threePutts: r.three_putts,
    })),
  };
}
