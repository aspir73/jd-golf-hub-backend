// 골프장 주변 맛집: 카카오 로컬 API 검색 프록시 + 개인 즐겨찾기 맛집 KV CRUD (기획서 3-4).
import { searchNearby, CATEGORY_GROUP } from './kakao.js';

const FAVORITES_KEY = 'favoriteRestaurants';

/** 라운딩 전/후 타이밍에 맞춘 키워드 프리셋 */
const TIMING_KEYWORDS = {
  before: '해장국 국밥',
  after: '고기 맛집',
  cafe: null, // 카테고리 검색(CE7) 사용
};

export async function searchRestaurants(env, { lat, lon, timing, keyword, radius }) {
  if (timing === 'cafe') {
    return searchNearby(env, { lat, lon, categoryGroupCode: CATEGORY_GROUP.CAFE, radius });
  }
  const q = keyword || TIMING_KEYWORDS[timing] || null;
  if (q) {
    return searchNearby(env, { lat, lon, query: q, radius });
  }
  return searchNearby(env, { lat, lon, categoryGroupCode: CATEGORY_GROUP.FOOD, radius });
}

export async function listFavoriteRestaurants(env) {
  const raw = await env.GOLF_KV.get(FAVORITES_KEY, 'json');
  return raw || [];
}

async function saveFavorites(env, list) {
  await env.GOLF_KV.put(FAVORITES_KEY, JSON.stringify(list));
}

export async function addFavoriteRestaurant(env, input) {
  if (!input.name) throw new Error('가게 이름(name)은 필수입니다');
  const list = await listFavoriteRestaurants(env);
  const record = {
    id: crypto.randomUUID(),
    name: input.name,
    address: input.address || '',
    phone: input.phone || '',
    lat: input.lat != null ? Number(input.lat) : null,
    lon: input.lon != null ? Number(input.lon) : null,
    courseName: input.courseName || '',
    category: input.category || '',
    placeUrl: input.placeUrl || '',
    memo: input.memo || '',
    createdAt: new Date().toISOString(),
  };
  list.push(record);
  await saveFavorites(env, list);
  return record;
}

export async function deleteFavoriteRestaurant(env, id) {
  const list = await listFavoriteRestaurants(env);
  const next = list.filter((r) => r.id !== id);
  const changed = next.length !== list.length;
  if (changed) await saveFavorites(env, next);
  return changed;
}
