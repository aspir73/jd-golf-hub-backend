// XGOLF(xgolf.com) 비로그인 조회 프록시. 실제 사용자 HAR 캡처(2026-10-05, 로그인 없이 쿠키 전혀
// 없는 요청으로 확인됨)로 재현했다 - 골팡과 마찬가지로 크롤링이 아니라 사이트 검색 폼이 호출하는
// 요청(booking_quick_search.asp)을 그대로 재현하는 방식이다. 응답은 JSON이 아니라
// <table class="new_list_tbl"> 안에 <tr>로 반복되는 HTML 조각이고, 각 행의 "예약" 버튼
// onclick="fnv_move_normal_info(clubCode,dateCompact,timeCompact,courseCode,courseSubName,
// divisionCode,clubName,?,personCount,originalFee,fee)" 인자가 가장 구조화된 데이터라 그걸
// 1차로 파싱하고, 캐디유무/상세설명은 같은 <tr> 블록 안 td.option/td.subject 텍스트에서 보강한다.

import { findBestMatch } from './golfCourseDB.js';

const XGOLF_BASE = 'https://www.xgolf.com';

// 빠른검색 "지역 선택"(#select_book_arae_code) 버튼의 실제 value 그대로(HAR/정적 페이지로 확인).
// 762(경기/인천)+781(경기/강원, 묶음)은 정규화 지역 그룹과 깔끔히 안 겹쳐서 단일 지역 코드만 쓴다.
export const REGIONS = [
  { code: '', label: '전체' },
  { code: '762', label: '경기/인천' },
  { code: '764', label: '강원' },
  { code: '765', label: '충청' },
  { code: '766', label: '경상' },
  { code: '767', label: '전라' },
  { code: '768', label: '제주' },
];

function stripTags(html) {
  return (html || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const MOVE_INFO_RE =
  /fnv_move_normal_info\('([^']*)','([^']*)','([^']*)','([^']*)','([^']*)','([^']*)','([^']*)','([^']*)','([^']*)','([^']*)','([^']*)'\)/;

/** <table class="new_list_tbl"> 안의 <tr> 반복 구조를 파싱한다. 헤더 행(<thead>)은 <th>만 있고
 * fnv_move_normal_info 호출이 없어 자연히 걸러진다. */
function parseRoundRows(html, { requestedDate } = {}) {
  const rows = [];
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let trMatch;
  while ((trMatch = trRegex.exec(html))) {
    const rowHtml = trMatch[1];
    const moveMatch = rowHtml.match(MOVE_INFO_RE);
    if (!moveMatch) continue; // 헤더 행 등 예약 버튼이 없는 행은 건너뜀
    const [, clubCode, dateCompact, timeCompact, , courseSubName, , clubName, , , originalFeeStr, feeStr] = moveMatch;

    const optionMatch = rowHtml.match(/<td class="option">([\s\S]*?)<\/td>/);
    const subjectMatch = rowHtml.match(/<td class="subject"[^>]*>([\s\S]*?)<\/td>/);
    const regionMatch = rowHtml.match(/<td>([^<]*)<\/td>/); // 첫 <td>는 부킹일, 그 다음이 지역이라 실제 지역은 아래에서 별도 추출
    const tds = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => stripTags(m[1]));

    const fee = Number(feeStr.replace(/[^\d]/g, '')) || null;
    const originalFee = originalFeeStr ? Number(originalFeeStr.replace(/[^\d]/g, '')) || null : null;
    const optionText = stripTags(optionMatch?.[1] || '');
    const date = requestedDate || (dateCompact ? `${dateCompact.slice(0, 4)}-${dateCompact.slice(4, 6)}-${dateCompact.slice(6, 8)}` : '');
    const time = timeCompact && timeCompact.length === 4 ? `${timeCompact.slice(0, 2)}:${timeCompact.slice(2)}` : timeCompact;

    rows.push({
      idx: clubCode,
      region: tds[1] || '',
      officialName: findBestMatch(clubName)?.name || null,
      date,
      time,
      courseName: courseSubName && courseSubName !== '미정' ? `${clubName} (${courseSubName})` : clubName,
      holes: '',
      greenFee: fee,
      originalGreenFee: originalFee,
      nickname: '',
      caddyType: optionText.includes('노캐디') ? '노캐디 가능' : '',
      category: stripTags(subjectMatch?.[1] || ''),
      contactPhone: '',
      distanceKm: null,
      views: null,
    });
    void regionMatch;
  }
  return rows;
}

/** jv_search_data는 커스텀 파이프(|)/세미콜론(;) 구분 포맷이고, 실제 요청에서 따옴표(")만
 * %22로 인코딩되고 대괄호/파이프/세미콜론/콤마는 그대로 남아있다(HAR로 확인) - URLSearchParams나
 * encodeURIComponent를 쓰면 이 문자들까지 인코딩돼서 서버가 못 알아듣는다(실제로 안 써보고
 * 바로 확인된 부분). 그래서 문자열을 직접 조립한다. */
function buildJvSearchData({ dateCompact, areaCode, startHour, endHour, minFee, maxFee, holes }) {
  const q = (s) => `%22${s}%22`;
  const parts = [
    `sBookDate;[${q(dateCompact)},${q('')},${q('')},${q('')},${q('')},${q('')}]`,
    `sAreaCode;[${q(areaCode)}]`,
    `sBookTime;[${q(startHour)},${q(endHour)}]`,
    `startBookTime;${startHour}`,
    `endBookTime;${endHour}`,
    `sGreenfee;[${q(minFee)},${q(maxFee)}]`,
    `startGreenfee;${minFee}`,
    `endGreenfee;${maxFee}`,
    `sSubAreaCode;`,
    `sHole;${holes}`,
    `sPerson;`,
    `sClubCode;`,
    `sDivis;0`,
    `sOrder;`,
  ];
  return parts.join('|');
}

/** areaCode: REGIONS의 code. startHour/endHour: 티타임 시간대(시 단위, 0~24).
 * minFee/maxFee: 그린피 범위(원). holes: 9 또는 18(기본 18 - 검색 폼 기본값과 동일). */
export async function searchXgolfRounds(
  env,
  { date, areaCode = '', startHour = 0, endHour = 24, minFee = 0, maxFee = 1000000, holes = 18, page = 1 }
) {
  if (!date) throw new Error('date(YYYY-MM-DD)가 필요합니다');
  const dateCompact = date.replace(/-/g, '');
  const jvSearchData = buildJvSearchData({ dateCompact, areaCode, startHour, endHour, minFee, maxFee, holes });
  const url = `${XGOLF_BASE}/booking/booking_quick_search.asp?pr_gotopage=${page}&jv_search_data=${jvSearchData}`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; JDGolfHub/1.0)',
      Referer: `${XGOLF_BASE}/booking/booking_quick_search.asp`,
    },
  });
  if (!res.ok) throw new Error(`XGOLF 조회 실패: HTTP ${res.status}`);
  // 페이지 자체가 euc-kr로 선언돼 있지만 실측 응답은 이미 UTF-8 바이트로 내려온다(HAR 기준) - 혹시
  // euc-kr로 깨져 오는 경우까지 대비해 Buffer를 utf-8로만 해석한다(추가 변환 없이 그대로 사용).
  const html = await res.text();
  // 처음엔 HAR 캡처에 쿠키가 전혀 없어서 로그인 없이 되는 줄 알았는데(2026-10-05 최초 구현),
  // 그 HAR를 재생해보니 서버가 "document.location.href='/member/login.asp?...'" 로 리다이렉트
  // 시키는 걸 확인했다 - HAR 내보내기 과정에서 쿠키 헤더가 통째로 빠져있었을 뿐, 실제로는
  // 로그인 세션이 있어야 결과가 나온다. 로그인 연동 전까지는 "결과 0건"으로 조용히 넘기지 않고
  // 명확히 에러로 알린다(안 그러면 "그냥 빈 자리가 없나보다"로 오해하기 쉬움).
  if (html.includes('/member/login.asp')) {
    throw new Error('XGOLF는 로그인한 세션이 있어야 조회가 됩니다 (게스트 조회 불가 - 로그인 연동 필요)');
  }
  const rounds = parseRoundRows(html, { requestedDate: date });
  return { mode: 'booking', totalCount: rounds.length, rounds };
}
