// 예약 기록 KV CRUD (기획서 3-1 "예약 기록" 스키마). 동반예약(백업) 비교 그룹과는 별개의 개념 —
// 그룹은 "아직 확정 안 된 후보들의 비교", 예약 기록은 "실제 가예약/확정/취소 상태를 추적하는 개별 건"이다.

const BOOKINGS_KEY = 'bookings';

const ALLOWED_TYPES = ['본인', '조인'];
const ALLOWED_STATUS = ['가예약', '확정', '취소예정', '취소완료'];
const ALLOWED_SOURCES = ['골팡', '골프장 홈페이지', '직접입력'];

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
    source: ALLOWED_SOURCES.includes(input.source) ? input.source : existing.source || '직접입력',
    bookingNumber: input.bookingNumber ?? existing.bookingNumber ?? '',
    greenFeeAmount: input.greenFeeAmount != null ? Number(input.greenFeeAmount) : existing.greenFeeAmount ?? null,
    paymentMethod: input.paymentMethod ?? existing.paymentMethod ?? '',
    reservationName: input.reservationName ?? existing.reservationName ?? '',
    companions: Array.isArray(input.companions) ? input.companions : existing.companions ?? [],
    contactPhone: input.contactPhone ?? existing.contactPhone ?? '',
    homepageUrl: input.homepageUrl ?? existing.homepageUrl ?? '',
    memo: input.memo ?? existing.memo ?? '',
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };
}

export async function addBooking(env, input) {
  if (!input.courseName) throw new Error('골프장명(courseName)은 필수입니다');
  const bookings = await listBookings(env);
  const record = normalizeBooking(input);
  bookings.push(record);
  await saveBookings(env, bookings);
  return record;
}

export async function updateBooking(env, id, input) {
  const bookings = await listBookings(env);
  const idx = bookings.findIndex((b) => b.id === id);
  if (idx === -1) return null;
  const record = normalizeBooking(input, bookings[idx]);
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

  const confirmed = normalizeBooking({ ...parsedInput, status: '확정', reviewCancel: false }, bookings[idx]);
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
