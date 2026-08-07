// 골팡(golfpang.com) 비로그인 조회 프록시 (기획서 3-1 "예약 전 비교 검색" 1차 개발 대상).
// 실제 API 문서가 없어 사이트의 검색 폼(join_list.do / booking_list.do)이 호출하는 내부 엔드포인트를
// 직접 관찰해 재현했다: 로그인 세션 없이 Referer + X-Requested-With 헤더만으로 응답하며, 응답은 JSON이
// 아니라 <tr id="tr_{idx}">로 시작하는 HTML 테이블 조각이라 정규식으로 셀을 추출한다(칼럼 순서 고정 확인됨).
// 크롤링이 아니라 사이트 자체가 검색 폼에서 호출하는 것과 동일한 요청을 그대로 재현하는 방식이다.

const GOLFPANG_BASE = 'https://www.golfpang.com';

// 검색 폼(sct select)에서 그대로 가져온 지역 코드. 처음엔 16(영호남/제주)이 sct3 서브셀렉트(영남=3/
// 호남=6/제주=7)로 좁혀지는 구조라고만 보고 상위 지역까지만 지원했는데, 실제 검색 폼 HTML을 다시 받아보니
// sct 자신에 "8=원주/영동"(사실상 강원) 옵션이 별도로 있었고, 직접 curl 검증 결과 sector=3/6/7을 sct3
// 경유 없이 곧장 넣어도 그대로 필터링된다(sector=6 → 28건, 전부 "호남"). 그래서 영남/호남/제주도 각자
// 독립된 지역 코드로 취급한다 — sector2는 실측상 결과에 영향이 없어 안 써도 된다.
export const REGIONS = [
  { code: '', label: '전체' },
  { code: '5', label: '한강이남' },
  { code: '1', label: '강북/경춘' },
  { code: '8', label: '강원' }, // 원주/영동
  { code: '4', label: '충청' },
  { code: '3', label: '경상' }, // 영남
  { code: '6', label: '전라' }, // 호남
  { code: '7', label: '제주' },
  { code: '16', label: '영호남/제주(통합)' },
];

export const AMPM_OPTIONS = [
  { code: '', label: '전체' },
  { code: 'am', label: '오전' },
  { code: 'pm', label: '오후' },
  { code: 'nt', label: '야간' },
];

// 검색 폼의 캐디유무(cadyChk) 셀렉트 그대로. onchange="cdOrder(this.value)" — 요청 바디의 cdOrder 필드에
// 그대로 들어간다. 실제 curl로 cdOrder=2(노캐디) 검증: 100건 중 66건이 전부 노캐디로만 걸러짐.
export const CADDY_TYPES = [
  { code: '', label: '전체' },
  { code: '0', label: '일반캐디' },
  { code: '1', label: '운전캐디' },
  { code: '2', label: '노캐디' },
  { code: '3', label: '인턴캐디' },
];

function stripTags(html) {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function parseTotalCount(html) {
  const m = html.match(/총\s*<strong>\s*([\d,]+)\s*<\/strong>/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

/** <tr id="tr_{idx}">...<td>...</td>...</tr> 반복 구조를 파싱. 칼럼 순서(지역/부킹일/티타임/포함/골프장/
 * 홀수/공백/그린피/작성자/캐디유무/구분/조회수)는 booking_tblList.do·join_tblList.do 양쪽에서 동일 확인됨 */
function parseRoundRows(html) {
  const rows = [];
  const trRegex = /<tr id="tr_(\d+)"[^>]*>([\s\S]*?)<\/tr>/g;
  let trMatch;
  while ((trMatch = trRegex.exec(html))) {
    const idx = trMatch[1];
    const rowHtml = trMatch[2];
    const cells = [];
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
    let tdMatch;
    while ((tdMatch = tdRegex.exec(rowHtml))) {
      cells.push(stripTags(tdMatch[1]));
    }
    if (cells.length < 8) continue;
    const greenFeeMatch = (cells[7] || '').match(/[\d,]+/);
    rows.push({
      idx,
      region: cells[0] || '',
      date: cells[1] || '',
      time: cells[2] || '',
      courseName: cells[4] || '',
      holes: cells[5] || '',
      greenFee: greenFeeMatch ? Number(greenFeeMatch[0].replace(/,/g, '')) : null,
      nickname: cells[8] || '',
      caddyType: cells[9] || '',
      category: cells[10] || '',
      views: cells[11] ? Number(cells[11].replace(/[^\d]/g, '')) || null : null,
    });
  }
  return rows;
}

/** mode: 'booking'(본인예약) | 'join'(조인/백업) */
export async function searchGolfpangRounds(env, { date, ampm = '', sector = '', mode = 'booking', caddyType = '' }) {
  if (!date) throw new Error('date(YYYY-MM-DD)가 필요합니다');
  const isJoin = mode === 'join';
  const endpoint = isJoin ? 'join_tblList.do' : 'booking_tblList.do';
  const refererPage = isJoin ? 'join_list.do' : 'booking_list.do';

  const body = new URLSearchParams({
    pageNum: '1',
    bkOrder: '',
    rd_date: date,
    ampm,
    sector,
    idx: '',
    cust_nick: '',
    clubname: '',
    sector2: sector,
    cdOrder: caddyType,
  });
  if (isJoin) {
    body.set('notima', '');
    body.set('jitype1', '');
  } else {
    body.set('sector3', '');
  }

  const res = await fetch(`${GOLFPANG_BASE}/web/round/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: `${GOLFPANG_BASE}/web/round/${refererPage}`,
      'User-Agent': 'Mozilla/5.0 (compatible; JDGolfHub/1.0)',
    },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`골팡 조회 실패: HTTP ${res.status}`);
  }
  const html = await res.text();
  return {
    mode: isJoin ? 'join' : 'booking',
    totalCount: parseTotalCount(html),
    rounds: parseRoundRows(html),
  };
}
