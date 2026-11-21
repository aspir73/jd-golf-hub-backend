// 스코어 기록 기반 기본 통계 (기획서 3-2 통계 대시보드의 MVP1 범위: 최근10 평균/베스트/코스별 평균/트렌드)

function avg(nums) {
  const vals = nums.filter((v) => v != null && !Number.isNaN(v));
  if (!vals.length) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
}

export function computeStats(allScores) {
  // 진행중/임시저장(in_progress) 라운드는 18홀을 다 입력해 종료하기 전까지 통계에 넣지 않는다(부분 합계가 평균을 왜곡함).
  const scores = allScores.filter((s) => s.status !== 'in_progress');
  const sorted = [...scores].sort((a, b) => (a.date < b.date ? 1 : -1)); // 최신순
  const recent10 = sorted.slice(0, 10);

  const byCourseMap = new Map();
  for (const s of scores) {
    const key = s.courseName || '미상';
    if (!byCourseMap.has(key)) byCourseMap.set(key, []);
    byCourseMap.get(key).push(s.totalScore);
  }
  const byCourse = Array.from(byCourseMap.entries())
    .map(([course, list]) => ({ course, rounds: list.length, avgScore: avg(list) }))
    .sort((a, b) => b.rounds - a.rounds);

  const trend = sorted
    .slice(0, 20)
    .reverse()
    .map((s) => ({ date: s.date, courseName: s.courseName, totalScore: s.totalScore }));

  return {
    totalRounds: scores.length,
    recentAvg10: avg(recent10.map((s) => s.totalScore)),
    bestScore: scores.length ? Math.min(...scores.map((s) => s.totalScore).filter((v) => v != null)) : null,
    avgFIR: avg(scores.map((s) => s.fir)),
    avgGIR: avg(scores.map((s) => s.gir)),
    avgPutts: avg(scores.map((s) => s.putts)),
    byCourse,
    trend,
  };
}
