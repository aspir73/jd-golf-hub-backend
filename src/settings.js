// 개인 설정(집 주소 좌표 등). 골프장 즐겨찾기 등록 시 거리 계산의 기준점으로 쓰인다.

const SETTINGS_KEY = 'settings';

// 시간대 선호(가중치 점수 알고리즘의 "시간대 선호 점수"에서 기준으로 사용)
const TIME_SLOTS = ['dawn', 'morning', 'afternoon', 'evening'];

const DEFAULT_SETTINGS = {
  homeAddress: '',
  homeLat: null,
  homeLon: null,
  preferredTimeSlots: ['morning'],
};

export async function getSettings(env) {
  const raw = await env.GOLF_KV.get(SETTINGS_KEY, 'json');
  const merged = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  // 이전 버전(단일값 preferredTimeSlot)으로 저장된 데이터를 배열로 보정한다.
  if (!Array.isArray(merged.preferredTimeSlots)) {
    merged.preferredTimeSlots = raw?.preferredTimeSlot && TIME_SLOTS.includes(raw.preferredTimeSlot)
      ? [raw.preferredTimeSlot]
      : DEFAULT_SETTINGS.preferredTimeSlots;
  }
  delete merged.preferredTimeSlot;
  return merged;
}

export async function updateSettings(env, input) {
  const current = await getSettings(env);
  const next = {
    homeAddress: input.homeAddress ?? current.homeAddress,
    homeLat: input.homeLat != null ? Number(input.homeLat) : current.homeLat,
    homeLon: input.homeLon != null ? Number(input.homeLon) : current.homeLon,
    preferredTimeSlots: Array.isArray(input.preferredTimeSlots)
      ? input.preferredTimeSlots.filter((s) => TIME_SLOTS.includes(s))
      : current.preferredTimeSlots,
  };
  if (!next.preferredTimeSlots.length) next.preferredTimeSlots = current.preferredTimeSlots;
  await env.GOLF_KV.put(SETTINGS_KEY, JSON.stringify(next));
  return next;
}
