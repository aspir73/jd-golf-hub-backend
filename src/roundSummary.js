// 라운드 결과 요약 - 홀별 기록(holes)에서 스코어/퍼팅/FIR/GIR, 이글~트리플 비율, OB·해저드·벙커,
// "오늘의 베스트"와 "아쉬운 점" 한 줄 요약을 계산한다. 스코어 레코드에 summary로 같이 저장돼서
// 홈/스코어 탭이 항상 같은 값을 보여주고, 다음 라운드가 끝나면 그 라운드 기준으로 갱신된다.
// 퍼팅·티샷 같은 상세 항목은 입력된 홀만 분모로 쓴다(간단 모드로 넘긴 홀은 제외).

const pctOf = (c, n) => (n ? Math.round((c / n) * 100) : 0);
const round1 = (v) => Math.round(v * 10) / 10;

function longestRun(list, pred) {
  let best = 0;
  let cur = 0;
  let prevNo = null;
  for (const h of list) {
    if (pred(h) && (prevNo == null || h.no === prevNo + 1 || cur === 0)) cur += 1;
    else cur = pred(h) ? 1 : 0;
    prevNo = h.no;
    if (cur > best) best = cur;
  }
  return best;
}

/** 다른 완료 라운드들의 홀당 평균 퍼팅(비교 기준). 데이터가 없으면 null. */
export function baselinePuttsPerHole(scores, exceptId) {
  let sum = 0;
  let n = 0;
  for (const s of scores) {
    if (s.id === exceptId || s.status !== 'done' || !Array.isArray(s.holes)) continue;
    for (const h of s.holes) {
      if (h.putts != null) { sum += h.putts; n += 1; }
    }
  }
  return n >= 9 ? sum / n : null;
}

export function computeRoundSummary(holes, baselinePutts = null) {
  if (!Array.isArray(holes)) return null;
  const played = holes.filter((h) => h.score != null && h.par != null).sort((a, b) => a.no - b.no);
  const n = played.length;
  if (!n) return null;

  const totalScore = played.reduce((s, h) => s + h.score, 0);
  const toPar = totalScore - played.reduce((s, h) => s + h.par, 0);

  const counts = { eagle: 0, birdie: 0, par: 0, bogey: 0, double: 0, triple: 0 };
  for (const h of played) {
    const d = h.score - h.par;
    if (d <= -2) counts.eagle += 1;
    else if (d === -1) counts.birdie += 1;
    else if (d === 0) counts.par += 1;
    else if (d === 1) counts.bogey += 1;
    else if (d === 2) counts.double += 1;
    else counts.triple += 1;
  }

  const puttHoles = played.filter((h) => h.putts != null);
  const putts = puttHoles.reduce((s, h) => s + h.putts, 0);
  const puttsPerHole = puttHoles.length ? round1(putts / puttHoles.length) : null;
  const threePutts = puttHoles.filter((h) => h.putts >= 3).length;

  const firKnown = played.filter((h) => h.par !== 3 && h.fairwayHit != null);
  const girKnown = played.filter((h) => h.greenHit != null);
  const firHit = firKnown.filter((h) => h.fairwayHit).length;
  const girHit = girKnown.filter((h) => h.greenHit).length;

  const teeKnown = played.filter((h) => h.teeShot);
  const ob = played.filter((h) => h.teeShot === 'ob').length;
  const hazard = played.filter((h) => h.teeShot === 'hazard').length;
  const bunker = played.filter((h) => h.teeShot === 'bunker').length;
  const penaltyHoles = played.filter((h) => (h.penalty || 0) > 0).length;
  const penaltyStrokes = played.reduce((s, h) => s + (h.penalty || 0), 0);
  const hasDetail = teeKnown.length > 0 || penaltyHoles > 0;

  // ----- 오늘의 베스트 -----
  const birdieStreak = longestRun(played, (h) => h.score - h.par <= -1);
  const parOrBetterStreak = longestRun(played, (h) => h.score - h.par <= 0);
  const best = [];
  if (counts.eagle > 0) best.push(`이글 ${counts.eagle}개`);
  if (birdieStreak >= 2) best.push(`연속 버디 ${birdieStreak}회`);
  if (parOrBetterStreak >= 3) best.push(`연속 파 이상 ${parOrBetterStreak}홀`);
  if (counts.birdie > 0 && birdieStreak < 2) best.push(`버디 ${counts.birdie}개`);
  if (!best.length) {
    const good = counts.eagle + counts.birdie + counts.par;
    best.push(`파 이상 ${good}홀 (${pctOf(good, n)}%)`);
  }

  // ----- 아쉬운 점 -----
  const regret = [];
  const teeMisses = played.filter((h) => h.teeShot && h.teeShot !== 'fairway');
  const right = teeMisses.filter((h) => h.missDir === 'right').length;
  const left = teeMisses.filter((h) => h.missDir === 'left').length;
  if (Math.max(right, left) >= 2) {
    regret.push(right >= left ? `드라이버 슬라이스(우측 미스) ${right}회` : `드라이버 훅(좌측 미스) ${left}회`);
  }
  if (puttsPerHole != null) {
    if (baselinePutts != null && puttsPerHole > baselinePutts + 0.1) {
      regret.push(`퍼팅 ${putts}개 (홀당 ${puttsPerHole}) 평소(${round1(baselinePutts)})보다 많아요`);
    } else if (baselinePutts == null && puttsPerHole >= 2) {
      regret.push(`퍼팅이 홀당 ${puttsPerHole}개로 많았어요`);
    }
  }
  if (threePutts >= 2) regret.push(`3퍼트 ${threePutts}회`);
  if (ob + hazard + penaltyHoles > 0) {
    const parts = [];
    if (ob) parts.push(`OB ${ob}개`);
    if (hazard) parts.push(`해저드 ${hazard}개`);
    if (!ob && !hazard && penaltyHoles) parts.push(`페널티 ${penaltyStrokes}타`);
    regret.push(parts.join(' · '));
  }
  if (counts.double + counts.triple >= 2) regret.push(`더블 이상 ${counts.double + counts.triple}개`);
  if (!regret.length) regret.push('큰 실수 없이 안정적인 라운드였어요');

  const item = (c) => ({ count: c, pct: pctOf(c, n) });
  return {
    holesPlayed: n,
    totalScore,
    toPar,
    putts: puttHoles.length ? putts : null,
    puttsPerHole,
    fir: firKnown.length ? { hit: firHit, n: firKnown.length, pct: pctOf(firHit, firKnown.length) } : null,
    gir: girKnown.length ? { hit: girHit, n: girKnown.length, pct: pctOf(girHit, girKnown.length) } : null,
    results: {
      eagle: item(counts.eagle), birdie: item(counts.birdie), par: item(counts.par),
      bogey: item(counts.bogey), double: item(counts.double), triple: item(counts.triple),
    },
    trouble: hasDetail
      ? { ob: item(ob), hazard: item(hazard), bunker: item(bunker), penaltyStrokes }
      : null,
    best: best.slice(0, 3).join(' · '),
    regret: regret.slice(0, 3).join(' · '),
    computedAt: new Date().toISOString(),
  };
}
