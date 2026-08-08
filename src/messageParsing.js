// 예약확정 카카오톡/문자 메시지 붙여넣기 → 정규식/키워드 기반 규칙 파서로 예약 기록 추출.
// 원래는 Claude API(구조화 출력)로 뽑았는데, API 크레딧 없이도 쓸 수 있게 룰 기반으로 바꿨다.
// 골프장마다 메시지 형식이 제각각이라 LLM만큼 정확하지는 않다 - 대신 프론트의 openBookingReviewDialog가
// 항상 "검토 후 저장"을 거치게 되어 있어서, 몇몇 필드가 비거나 틀려도 사용자가 저장 전에 고칠 수 있다.
// 확신이 없는 필드는 억지로 채우지 말고 빈 값으로 두는 걸 원칙으로 한다(틀린 값보다 빈 값이 낫다).

import { findBestMatch } from './golfCourseDB.js';

/** [대괄호] 안의 첫 텍스트를 골프장명 후보로 쓰되, 문체부 공식 DB와 매칭되면 정식 명칭으로 정리한다.
 * "[용인 세현컨트리클럽]"처럼 지역명이 앞에 붙어있으면 그 전체로는 매칭이 애매해질 수 있다
 * (예: "용인"만 떼도 실제로 존재하는 "용인CC"와 겹쳐버려 findBestMatch가 일부러 매칭을 포기함) -
 * 그래서 공백 기준으로 앞 단어를 하나씩 떼어가며 다시 시도해서, 지역명을 뺀 "세현컨트리클럽"만으로
 * 재시도하면 유일하게 매칭되는 경우를 잡아낸다. 그래도 안 되면 원문 그대로 둔다. */
function extractCourseName(text) {
  let raw = '';
  const bracket = text.match(/\[([^\]]+)\]/);
  if (bracket) {
    raw = bracket[1].trim();
  } else {
    const suffixMatch = text.match(/([가-힣A-Za-z0-9]{2,20}(?:컨트리클럽|골프클럽|CC|C\.C\.?|GC|G\.C\.?))/);
    raw = suffixMatch ? suffixMatch[1].trim() : '';
  }
  if (!raw) return '';

  const words = raw.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const candidate = words.slice(i).join(' ');
    const matched = findBestMatch(candidate);
    if (matched) return matched.name;
  }
  return raw;
}

/** "◈ 예약자명 : 손성민님"처럼 라벨로 명시된 경우를 먼저 본다(더 명확한 신호) - 없으면
 * 기존처럼 "OOO 회원님/고객님/예약자님" 접미사 패턴으로 찾는다.
 * "님"을 선택(?)으로 두면 {2,4} 탐욕적 매칭이 "님"까지 이름의 일부로 삼켜버려서
 * "손성민님"이 통째로 잡히는 문제가 있었다 - "님"을 별도의 필수 리터럴로 먼저 시도해서
 * (실패하면 정규식 엔진이 이름 글자 수를 줄여가며 백트래킹하게) 이름만 정확히 분리해낸다. */
function extractReservationName(text) {
  let m = text.match(/예약자\s*명\s*[:：]?\s*([가-힣]{2,4})님/);
  if (m) return m[1];
  m = text.match(/예약자\s*명\s*[:：]?\s*([가-힣]{2,4})/);
  if (m) return m[1];
  m = text.match(/([가-힣]{2,4})\s*(?:회원님|고객님|예약자님)/);
  return m ? m[1] : '';
}

/** "8월 8일", "08월08일(토)", "2026-08-08", "2026.08.08", "8/8" 등을 YYYY-MM-DD로 정규화.
 * 연도가 없으면 오늘 기준 가장 가까운 미래 날짜로 추정한다(취소마감일 파싱과 같은 방식). */
function extractDate(text) {
  let y, m, d;
  let mm = text.match(/(\d{4})[-.](\d{1,2})[-.](\d{1,2})/);
  if (mm) {
    [, y, m, d] = mm;
  } else {
    mm = text.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
    if (mm) {
      [, m, d] = mm;
    } else {
      mm = text.match(/(?<!\d)(\d{1,2})\/(\d{1,2})(?!\d)/);
      if (mm) [, m, d] = mm;
    }
  }
  if (!m || !d) return '';
  m = Number(m);
  d = Number(d);
  if (y) return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  const now = new Date();
  let year = now.getFullYear();
  let candidate = new Date(year, m - 1, d);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (candidate < startOfToday) {
    year += 1;
    candidate = new Date(year, m - 1, d);
  }
  return `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function extractTime(text) {
  const m = text.match(/([01]?\d|2[0-3]):([0-5]\d)/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : '';
}

function extractSubCourse(text) {
  const m = text.match(/([가-힣]{1,6}코스)/);
  return m ? m[1] : '';
}

/** 금액 표현("15만원", "150,000원") 하나를 원 단위 숫자로 변환 */
function parseAmount(numStr, manWon) {
  const num = Number(numStr.replace(/,/g, ''));
  return manWon ? num * 10000 : num;
}

/** 그린피는 우선순위를 두고 찾는다:
 * 1) "그린피"라는 단어가 명시돼 있으면 그 금액.
 * 2) 없으면 "인터넷회원" 요금(회원 가입 후 적용받는, 사실상 표준 요금인 경우가 많음)을 우선 채택.
 * 3) 그것도 없으면(예: "회원"/"비회원" 요금만 여러 개 나열된 경우) 어느 게 내 요금인지 규칙만으로는
 *    판단할 수 없어서 억지로 고르지 않고 null로 둔다 - 사용자가 검토 화면에서 직접 채우면 된다. */
function extractGreenFee(text) {
  let m = text.match(/그린피[^\d]{0,10}([\d,]+)\s*(만)?\s*원/);
  if (m) return parseAmount(m[1], !!m[2]);
  m = text.match(/인터넷\s*회원[^\d]{0,10}([\d,]+)\s*(만)?\s*원/);
  if (m) return parseAmount(m[1], !!m[2]);
  return null;
}

// "카트비 1팀 12만원"처럼 금액 앞에 "N팀"이 끼어있으면 [^\d]{0,N} 방식으로는 "1"(팀 수)을
// 금액으로 잘못 캡처해버린다 - "N팀" 부분을 먼저 건너뛰도록 별도 그룹으로 명시해야 한다.
const FEE_PREFIX = '\\s*(?:\\d+\\s*팀\\s*)?[:\\-]?\\s*';

/** "카트비 1팀 12만원", "카트비: 120,000원" 등에서 카트비(팀 단위 총액) 추출.
 * 메시지에 명시가 없으면 사용자가 주로 이용하는 골프장 기준 기본값(12만원)을 채운다 -
 * 다른 필드들과 달리 "억지로 채우지 않는다" 원칙의 예외: 카트비는 거의 항상 이 금액이라
 * 매번 빈칸으로 두고 직접 입력하는 게 오히려 번거롭다는 사용자 피드백에 따른 것. */
function extractCartFee(text) {
  const m = text.match(new RegExp(`카트비${FEE_PREFIX}([\\d,]+)\\s*(만)?\\s*원`));
  return m ? parseAmount(m[1], !!m[2]) : 120000;
}

/** "캐디피 1팀 16만원" 등에서 캐디피(팀 단위 총액) 추출. 명시 없으면 기본값 16만원(카트비와 같은 이유). */
function extractCaddyFee(text) {
  const m = text.match(new RegExp(`캐디피${FEE_PREFIX}([\\d,]+)\\s*(만)?\\s*원`));
  return m ? parseAmount(m[1], !!m[2]) : 160000;
}

function extractPaymentMethod(text) {
  const known = ['선불', '후불', '현장결제', '카드결제', '계좌이체', '무통장입금', '현금결제'];
  for (const k of known) {
    if (text.includes(k)) return k;
  }
  return '';
}

function extractCancelable(text) {
  if (/취소\s*불가|환불\s*불가/.test(text)) return '불가';
  if (/취소\s*가능/.test(text)) return '가능';
  return '알수없음';
}

/** "취소 마감 8/18 10:00", "취소마감: 2026-08-18" 처럼 "취소"와 가까운 날짜/시간 조합을 찾는다. */
function extractCancelDeadline(text) {
  const idx = text.search(/취소.{0,10}(마감|까지)/);
  if (idx === -1) return '';
  const window = text.slice(idx, idx + 60);
  const dm = window.match(/(\d{4}[-.]\d{1,2}[-.]\d{1,2}|\d{1,2}\s*월\s*\d{1,2}\s*일|\d{1,2}\/\d{1,2})/);
  const tm = window.match(/([01]?\d|2[0-3]):([0-5]\d)/);
  const parts = [];
  if (dm) parts.push(dm[1]);
  if (tm) parts.push(`${tm[1]}:${tm[2]}`);
  return parts.join(' ');
}

function extractContactPhone(text) {
  const m = text.match(/(0\d{1,2}-\d{3,4}-\d{4})/);
  return m ? m[1] : '';
}

function extractHomepageUrl(text) {
  const m = text.match(/(?:https?:\/\/)?([a-zA-Z0-9][a-zA-Z0-9-]*\.(?:com|co\.kr|kr|net|golf)\b[^\s,]*)/i);
  if (!m) return '';
  const full = m[0];
  return /^https?:\/\//i.test(full) ? full : `https://${full}`;
}

function extractBookingNumber(text) {
  const m = text.match(/예약\s*번호\s*[:\-]?\s*([A-Za-z0-9-]{4,20})/);
  return m ? m[1] : '';
}

function extractReservationType(text) {
  return /조인|합류|동반\s*모집|인원\s*모집/.test(text) ? '조인' : '본인';
}

/** 각 필드 추출기가 실제로 값을 뽑아내는 패턴들. 어떤 줄이 이 중 하나라도 걸리면 "이미 어느
 * 항목엔가 자동으로 채워진 줄"로 보고 메모에서 제외한다. (실제 extractXxx 함수들과 동일한
 * 정규식을 재사용 - 한쪽만 고치고 잊어버리는 일이 없도록 아래에서 그대로 가져다 쓴다.) */
const CONSUMED_LINE_PATTERNS = [
  /\[[^\]]+\]/, // [골프장명], [안내사항] 같은 대괄호 헤더/섹션 줄 자체(내용 줄은 아래 다른 패턴으로 판단)
  /예약자\s*명\s*[:：]?\s*([가-힣]{2,4})\s*님?/, // 예약자명(라벨 형식: "◈ 예약자명 : 손성민님")
  /([가-힣]{2,4})\s*(?:회원님|고객님|예약자님)/, // 예약자명(접미사 형식)
  /(\d{4})[-.](\d{1,2})[-.](\d{1,2})/, // 날짜(yyyy-mm-dd)
  /(\d{1,2})\s*월\s*(\d{1,2})\s*일/, // 날짜(N월N일)
  /(?<!\d)(\d{1,2})\/(\d{1,2})(?!\d)/, // 날짜(N/N)
  /([01]?\d|2[0-3]):([0-5]\d)/, // 시간
  /([가-힣]{1,6}코스)/, // 코스명
  /그린피[^\d]{0,10}([\d,]+)\s*(만)?\s*원/, // 그린피
  /인터넷\s*회원[^\d]{0,10}([\d,]+)\s*(만)?\s*원/, // 그린피(인터넷회원가)
  new RegExp(`카트비${FEE_PREFIX}([\\d,]+)\\s*(만)?\\s*원`), // 카트비
  new RegExp(`캐디피${FEE_PREFIX}([\\d,]+)\\s*(만)?\\s*원`), // 캐디피
  /취소\s*불가|환불\s*불가|취소\s*가능/, // 취소 가능 여부
  /취소.{0,10}(마감|까지)/, // 취소 가능 마감
  /(0\d{1,2}-\d{3,4}-\d{4})/, // 문의 연락처
  /(?:https?:\/\/)?[a-zA-Z0-9][a-zA-Z0-9-]*\.(?:com|co\.kr|kr|net|golf)\b/i, // 홈페이지
  /예약\s*번호\s*[:\-]?\s*([A-Za-z0-9-]{4,20})/, // 예약번호
];

/** 항목에 자동으로 채워지는 내용(위 CONSUMED_LINE_PATTERNS)을 제외한 나머지 줄은 전부
 * 메모에 그대로 남긴다 - [안내사항] 문구뿐 아니라 우리가 못 알아본 다른 내용도 버리지 않고
 * 최소한 메모에서라도 확인할 수 있게 하려는 것("확신이 없는 필드는 채우지 않는다" 원칙과
 * 짝을 이루는 규칙: 못 알아본 내용을 그냥 버리지 않는다).
 * 결제방식 키워드(선불/후불 등)는 일부러 제외 판단에 안 쓴다 - "이용요금은 선불 정산입니다"처럼
 * 더 긴 안내 문장 안에 낱말로만 등장하는 경우가 많아서, 그걸로 줄 전체를 지워버리면 문맥이 사라진다. */
function buildLeftoverMemo(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !CONSUMED_LINE_PATTERNS.some((re) => re.test(line)))
    .join('\n');
}

export async function parseBookingMessage(text) {
  if (!text || !text.trim()) {
    throw new Error('분석할 메시지 내용이 필요합니다');
  }

  return {
    reservationType: extractReservationType(text),
    courseName: extractCourseName(text),
    courseSubName: extractSubCourse(text),
    roundDate: extractDate(text),
    roundTime: extractTime(text),
    reservationName: extractReservationName(text),
    companions: [],
    companionCount: null,
    greenFeeAmount: extractGreenFee(text),
    cartFeeAmount: extractCartFee(text),
    caddyFeeAmount: extractCaddyFee(text),
    paymentMethod: extractPaymentMethod(text),
    cancelable: extractCancelable(text),
    cancelDeadline: extractCancelDeadline(text),
    contactPhone: extractContactPhone(text),
    homepageUrl: extractHomepageUrl(text),
    bookingNumber: extractBookingNumber(text),
    memo: buildLeftoverMemo(text),
  };
}
