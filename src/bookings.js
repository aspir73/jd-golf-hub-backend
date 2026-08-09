// 예약 기록 KV CRUD (기획서 3-1 "예약 기록" 스키마). 동반예약(백업) 비교 그룹과는 별개의 개념 —
// 그룹은 "아직 확정 안 된 후보들의 비교", 예약 기록은 "실제 가예약/확정/취소 상태를 추적하는 개별 건"이다.

import { getSettings } from './settings.js';
import { resolveCourseTravelInfo } from './kakao.js';

const BOOKINGS_KEY = 'bookings';

const ALLOWED_TYPES = ['본인', '조인'];
const ALLOWED_STATUS = ['가예약', '확정', '취소예정', '취소완료'];
// 예약 경로 구분: 골팡 앱을 통한 예약 / 골프장 홈페이지에서 본인이 직접 예약 / 동반자가 예약해준
// 경우 / 카카오골프예약(조인 탭 전용 경로 - 조인 탭에서는 골팡·카카오골프만 선택 가능).
const ALLOWED_SOURCES = ['골팡', '홈페이지(본인예약)', '동반자예약', '카카오골프'];

export async function listBookings(env) {
  const raw = await env.GOLF_KV.get(BOOKINGS_KEY, 'json');
  return raw || [];
}

async function saveBookings(env, bookings) {
  await env.GOLF_KV.put(BOOKINGS_KEY, JSON.stringify(bookings));
}

function normalizeBooking(input, existing = {}) {
  const now = new Date().toISOString();
  return {
    id: existing.id || crypto.randomUUID(),
    type: ALLOWED_TYPES.includes(input.type) ? input.type : existing.type || '본인',
    courseName: input.courseName ?? existing.courseName ?? '',
    courseSubName: input.courseSubName ?? existing.courseSubName ?? '',
    roundDate: input.roundDate ?? existing.roundDate ?? '',
    roundTime: input.roundTime ?? existing.roundTime ?? '',
    status: ALLOWED_STATUS.includes(input.status) ? input.status : existing.status || '가예약',
    reviewCancel: input.reviewCancel != null ? Boolean(input.reviewCancel) : existing.reviewCancel || false,
    cancelable: {
      possible: input.cancelable?.possible ?? existing.cancelable?.possible ?? null, // true|false|null(모름)
      deadline: input.cancelable?.deadline ?? existing.cancelable?.deadline ?? '',
    },
    groupId: input.groupId !== undefined ? input.groupId : existing.groupId ?? null,
    source: ALLOWED_SOURCES.includes(input.source) ? input.source : existing.source || '골팡',
    bookingNumber: input.bookingNumber ?? existing.bookingNumber ?? '',
    greenFeeAmount: input.greenFeeAmount != null ? Number(input.greenFeeAmount) : existing.greenFeeAmount ?? null,
    cartFeeAmount: input.cartFeeAmount != null ? Number(input.cartFeeAmount) : existing.cartFeeAmount ?? null,
    caddyFeeAmount: input.caddyFeeAmount != null ? Number(input.caddyFeeAmount) : existing.caddyFeeAmount ?? null,
    // 선입금(先入金) - 조인 탭 예약 등록 전용 필드(카카오골프/골팡 조인 예약 시 미리 낸 금액).
    depositAmount: input.depositAmount != null ? Number(input.depositAmount) : existing.depositAmount ?? null,
    companionCount: input.companionCount != null ? Number(input.companionCount) : existing.companionCount ?? null,
    paymentMethod: input.paymentMethod ?? existing.paymentMethod ?? '',
    reservationName: input.reservationName ?? existing.reservationName ?? '',
    companions: Array.isArray(input.companions) ? input.companions : existing.companions ?? [],
    contactPhone: input.contactPhone ?? existing.contactPhone ?? '',
    homepageUrl: input.homepageUrl ?? existing.homepageUrl ?? '',
    memo: input.memo ?? existing.memo ?? '',
    // 집 주소 기준 자동차 거리(km)/이동시간(분) - resolveTravelInfoIfNeeded()가 courseName이
    // 새로 생기거나 바뀔 때만 다시 계산해서 채운다. 그 전까지는 기존 값을 유지.
    distanceKm: existing.distanceKm ?? null,
    durationMin: existing.durationMin ?? null,
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };
}

/** courseName이 새로 생겼거나 바뀐 경우, 또는 아직 거리 정보가 한 번도 채워진 적 없는 기존
 * 기록(이 기능 추가 전에 만들어진 예약 등)을 수정할 때 집~골프장 자동차 거리/시간을 계산해서 채운다
 * (courseName이 그대로인데 상태만 바꾸는 등 이미 값이 있는 사소한 수정에서는 매번 카카오 API를
 * 다시 부르지 않는다). 집 주소가 아직 설정 안 돼 있으면 조용히 생략. */
async function resolveTravelInfoIfNeeded(env, record, previousCourseName) {
  const needsBackfill = record.distanceKm == null && record.courseName;
  if (!record.courseName || (record.courseName === previousCourseName && !needsBackfill)) return record;
  const settings = await getSettings(env);
  if (settings.homeLat == null || settings.homeLon == null) return record;
  const info = await resolveCourseTravelInfo(env, record.courseName, settings.homeLat, settings.homeLon);
  record.distanceKm = info?.distanceKm ?? null;
  record.durationMin = info?.durationMin ?? null;
  return record;
}

export async function addBooking(env, input) {
  if (!input.courseName) throw new Error('골프장명(courseName)은 필수입니다');
  const bookings = await listBookings(env);
  let record = normalizeBooking(input);
  record = await resolveTravelInfoIfNeeded(env, record, null);
  bookings.push(record);
  await saveBookings(env, bookings);
  return record;
}

export async function updateBooking(env, id, input) {
  const bookings = await listBookings(env);
  const idx = bookings.findIndex((b) => b.id === id);
  if (idx === -1) return null;
  const previousCourseName = bookings[idx].courseName;
  let record = normalizeBooking(input, bookings[idx]);
  record = await resolveTravelInfoIfNeeded(env, record, previousCourseName);
  bookings[idx] = record;
  await saveBookings(env, bookings);
  return record;
}

export async function deleteBooking(env, id) {
  const bookings = await listBookings(env);
  const next = bookings.filter((b) => b.id !== id);
  const changed = next.length !== bookings.length;
  if (changed) await saveBookings(env, next);
  return changed;
}

/** 같은 골프장·라운딩 날짜의 기존 "가예약" 기록을 찾는다 (확정 메시지 매칭용) */
export function findMatchingBooking(bookings, courseName, roundDate) {
  if (!courseName || !roundDate) return null;
  return bookings.find((b) => b.status === '가예약' && b.courseName === courseName && b.roundDate === roundDate) || null;
}

/**
 * 확정 메시지 매칭 결과 반영: 매칭된 기록을 "확정"으로 갱신하고, 같은 동반예약 그룹의 나머지
 * "가예약" 건은 자동으로 취소 검토 대상(reviewCancel)으로 표시한다.
 */
export async function confirmMatchedBooking(env, matchedId, parsedInput) {
  const bookings = await listBookings(env);
  const idx = bookings.findIndex((b) => b.id === matchedId);
  if (idx === -1) return null;

  const previousCourseName = bookings[idx].courseName;
  let confirmed = normalizeBooking({ ...parsedInput, status: '확정', reviewCancel: false }, bookings[idx]);
  confirmed = await resolveTravelInfoIfNeeded(env, confirmed, previousCourseName);
  bookings[idx] = confirmed;

  let siblingsUpdated = 0;
  if (confirmed.groupId) {
    for (let i = 0; i < bookings.length; i++) {
      const b = bookings[i];
      if (b.id !== confirmed.id && b.groupId === confirmed.groupId && b.status === '가예약') {
        bookings[i] = { ...b, reviewCancel: true, updatedAt: new Date().toISOString() };
        siblingsUpdated++;
      }
    }
  }

  await saveBookings(env, bookings);
  return { booking: confirmed, siblingsUpdated };
}
