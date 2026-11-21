// 대한골프협회(KGA) 공식 코스레이팅™ 현황(kgagolf.or.kr/infor/infor_data/AllRatings_25.pdf, 2024-08-06 발행)을
// 경기·강원·충북·충남 274개 골프장 목록과 매칭한 정적 데이터(원본: data/kga_course_ratings.csv,
// 111개 골프장 매칭 성공 - src/data/kgaCourseRatings.json으로 미리 변환해서 커밋해둠. 변환 스크립트는
// scripts/build_kga_ratings.py - CSV가 갱신되면 다시 돌려서 JSON을 재생성).
//
// ★ 중요 한계(원본 데이터 자체의 한계, 안내 시트 참고): 이 데이터는 "코스"(9홀×2 조합) 단위의
// 코스레이팅·슬로프레이팅·총거리(야드)만 제공한다. 홀별(1~18번) 개별 파·거리·핸디캡(스트로크
// 인덱스)은 없다 - 그건 courseInfo.js(사용자 직접 입력)가 계속 담당한다. 이 모듈은 오직 "코스
// 레이팅" 정보(공식 수치)만 제공하고, holes/par 쪽에는 관여하지 않는다.
//
// comboLabel의 원문(예: "코리아 레이크+챌린지")에는 골프장명에서 파생된 접두어가 섞여 있어서,
// 변환 스크립트가 같은 골프장의 여러 코스조합 사이의 공통 접두어를 찾아 제거하고, 남은 부분이
// "A+B" 패턴(괄호로 묶인 그룹명 포함 가능 - 예: "신(아웃+인)" -> 그룹 "신" + "아웃"/"인")으로
// 깔끔하게 쪼개지면 loopNames:[A,B]를 채워뒀다(OUT/IN 두 드롭다운 UI용). 코스조합이 1개뿐이거나
// 표기가 불규칙해서 못 쪼갠 골프장은 loopBased:false로 표시되고, 프론트는 그 경우 코스조합
// 목록을 그대로 하나씩 보여주는 폴백 UI를 쓴다.
import kgaData from './data/kgaCourseRatings.json';
import { normalizeCourseName } from './golfCourseDB.js';

const indexed = kgaData.map((c) => ({ ...c, _norm: normalizeCourseName(c.courseName) }));

function stripNorm(c) {
  if (!c) return c;
  const { _norm, ...rest } = c;
  return rest;
}

/** 골프장명으로 KGA 코스레이팅 데이터를 찾는다. golfCourseDB.findBestMatch와 같은 방식
 * (정확히 일치하는 정규화명이 있으면 그걸, 없으면 포함관계로 가장 구체적인 후보 하나,
 * 후보가 여러 개면 확신이 없으니 null). 매칭 대상이 274개(경기·강원·충북·충남)뿐이라
 * 그 외 지역 골프장은 항상 null - 그 경우 프론트가 기존 수동입력 방식으로 자연스럽게 폴백한다. */
export function findKgaRating(courseName) {
  const norm = normalizeCourseName(courseName);
  if (!norm) return null;

  const exact = indexed.filter((c) => c._norm === norm);
  if (exact.length === 1) return stripNorm(exact[0]);
  if (exact.length > 1) return null;

  const partial = indexed.filter((c) => c._norm.includes(norm) || norm.includes(c._norm));
  if (partial.length === 1) return stripNorm(partial[0]);
  return null;
}
