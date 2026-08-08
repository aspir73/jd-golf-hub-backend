// 예약확정 카카오톡/문자 메시지 붙여넣기 → 정규식/키워드 기반 규칙 파서로 예약 기록 추출.
// 원래는 Claude API(구조화 출력)로 뽑았는데, API 크레딧 없이도 쓸 수 있게 룰 기반으로 바꿨다.
// 골프장마다 메시지 형식이 제각각이라 LLM만큼 정확하지는 않다 - 대신 프론트의 openBookingReviewDialog가
// 항상 "검토 후 저장"을 거치게 되어 있어서, 몇몇 필드가 비거나 틀려도 사용자가 저장 전에 고칠 수 있다.
// 확신이 없는 필드는 억지로 채우지 말고 빈 값으로 두는 걸 원칙으로 한다(틀린 값보다 빈 값이 낫다).

import { findBestMatch } from './golfCourseDB.js';

/** [대괄호] 안의 첫 텍스트를 골프장명 후보로 쓰되, 문체부 공식 DB와 매칭되면 정식 명칭으로 정리한다.
 * "[용인 세현컨트리클럽]"처럼 지역명이 섞여 있어도 findBestMatch의 포함관계 매칭이 잡아준다. */
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
  const matched = findBestMatch(raw);
  return matched ? matched.name : raw;
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

/** "그린피"라는 단어가 명시된 경우에만 금액을 뽑는다 - "인터넷회원 15만원 / 비회원 16만원"처럼
 * 여러 요금이 나열된 경우 어느 게 내 요금인지 규칙만으로는 판단할 수 없어서 억지로 고르지 않는다. */
function extractGreenFee(text) {
  const m = text.match(/그린피[^\d]{0,10}([\d,]+)\s*(만)?\s*원/);
  if (!m) return null;
  const num = Number(m[1].replace(/,/g, ''));
  return m[2] ? num * 10000 : num;
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
    greenFeeAmount: extractGreenFee(text),
    paymentMethod: extractPaymentMethod(text),
    cancelable: extractCancelable(text),
    cancelDeadline: extractCancelDeadline(text),
    contactPhone: extractContactPhone(text),
    homepageUrl: extractHomepageUrl(text),
    bookingNumber: extractBookingNumber(text),
  };
}
