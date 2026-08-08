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

function extractReservationName(text) {
  const m = text.match(/([가-힣]{2,4})\s*(?:회원님|고객님|예약자님)/);
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

/** "카트비 1팀 12만원", "카트비: 120,000원" 등에서 카트비(팀 단위 총액) 추출 */
function extractCartFee(text) {
  const m = text.match(new RegExp(`카트비${FEE_PREFIX}([\\d,]+)\\s*(만)?\\s*원`));
  return m ? parseAmount(m[1], !!m[2]) : null;
}

/** "캐디피 1팀 16만원" 등에서 캐디피(팀 단위 총액) 추출 */
function extractCaddyFee(text) {
  const m = text.match(new RegExp(`캐디피${FEE_PREFIX}([\\d,]+)\\s*(만)?\\s*원`));
  return m ? parseAmount(m[1], !!m[2]) : null;
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

/** "[안내사항]" 섹션 안 내용을 메모로 그대로 가져온다. 다음 "[...]" 섹션(또는 문자열 끝)
 * 직전까지를 범위로 잡고, 줄 단위로 trim + 빈 줄만 제거해서 원래 불릿(·) 서식은 유지한다. */
function extractGuidanceNotes(text) {
  const m = text.match(/\[\s*안내사항\s*\]([\s\S]*?)(?=\[[^\]]+\]|$)/);
  if (!m) return '';
  return m[1]
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
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
    memo: extractGuidanceNotes(text),
  };
}
