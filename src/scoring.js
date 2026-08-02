// 골프장 선호 가중치 스코어 알고리즘 (기획서 3-1). 각 후보의 원시 데이터(거리·평가·그린피·시간대)만
// 서버에서 계산해 내려주고, 가중치별 최종 점수 합산은 프론트에서 슬라이더로 즉시 재계산한다
// (가중치를 바꿀 때마다 API를 다시 부를 필요가 없도록).
import { searchKeyword, distanceKm } from './kakao.js';
import { getSettings } from './settings.js';
import { listScores } from './scores.js';

const TIME_SLOT_RANGES = [
  { slot: 'dawn', start: 0, end: 8 },
  { slot: 'morning', start: 8, end: 12 },
  { slot: 'afternoon', start: 12, end: 16 },
  { slot: 'evening', start: 16, end: 24 },
];

function timeSlotOf(timeStr) {
  const m = (timeStr || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const hour = Number(m[1]);
  const found = TIME_SLOT_RANGES.find((r) => hour >= r.start && hour < r.end);
  return found ? found.slot : null;
}

function courseRatingAverage(scores, courseName) {
  const matches = scores.filter((s) => s.courseName === courseName && s.courseRating != null);
  if (!matches.length) return null;
  return Math.round((matches.reduce((sum, s) => sum + s.courseRating, 0) / matches.length) * 10) / 10;
}

/** 그룹의 각 후보에 대해 거리(km)/내 평가 평균/그린피/시간대를 채워서 반환 */
export async function computeCandidateComponents(env, group) {
  const settings = await getSettings(env);
  const scores = await listScores(env);

  const results = [];
  for (const candidate of group.candidates) {
    let distance = null;
    if (settings.homeLat != null && settings.homeLon != null && candidate.courseName) {
      try {
        const places = await searchKeyword(env, candidate.courseName);
        if (places[0]) {
          distance = distanceKm(settings.homeLat, settings.homeLon, places[0].lat, places[0].lon);
        }
      } catch {
        // 카카오 검색 실패 시 거리 없이 진행 (평가/그린피/시간대만으로도 비교 가능)
        distance = null;
      }
    }
    results.push({
      candidateId: candidate.id,
      courseName: candidate.courseName,
      distanceKm: distance,
      courseRatingAvg: courseRatingAverage(scores, candidate.courseName),
      greenFee: candidate.greenFee,
      timeSlot: timeSlotOf(candidate.time),
      time: candidate.time,
      date: candidate.date,
    });
  }

  return {
    preferredTimeSlot: settings.preferredTimeSlot,
    candidates: results,
  };
}
