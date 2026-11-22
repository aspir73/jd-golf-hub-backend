// 골프장 주변 맛집: 카카오 로컬 API 검색 프록시 + 개인 즐겨찾기 맛집 KV CRUD (기획서 3-4).
import { searchNearby, CATEGORY_GROUP } from './kakao.js';
import { findGoogleRating } from './googlePlaces.js';

const FAVORITES_KEY = 'favoriteRestaurants';

/** 라운딩 전(아침) 프리셋용 키워드 목록. 카카오 로컬 API는 영업시간 필드를 전혀 안 내려주고
 * (네이버 지역검색도 마찬가지) "실제 7시 이전 오픈" 여부를 확인할 무료 데이터 소스가 없다.
 * 그래서 정확한 오픈시간 필터 대신, 전통적으로 새벽부터 여는 업종(해장국/국밥류, 24시 식당)
 * 키워드로 근사한다 - 한 번호출당 한 키워드만 매칭되는 카카오 검색 특성상 여러 키워드로 각각
 * 검색해 합쳐야 커버리지가 넓어진다(검색어 하나로 합쳐 보내면 그 문구를 포함하는 상호만 걸림). */
const MORNING_KEYWORDS = ['해장국', '국밥', '콩나물국밥', '순대국', '감자탕', '24시'];
const TIMING_KEYWORDS = {
  after: '고기 맛집',
  cafe: null, // 카테고리 검색(CE7) 사용
};

/** 카카오 검색 결과 중복 제거 - 같은 가게가 여러 키워드 검색에 다 걸릴 수 있어서(예: "국밥집"이
 * "국밥"과 "24시" 양쪽에 매칭) 좌표 기준으로 합친다(kakao.js searchPlaces와 동일 방식). */
function dedupePlaces(list) {
  const seen = new Set();
  const merged = [];
  for (const p of list) {
    const key = p.lat != null && p.lon != null ? `${p.lat.toFixed(5)},${p.lon.toFixed(5)}` : `${p.name}|${p.address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(p);
  }
  return merged;
}

export async function searchRestaurants(env, { lat, lon, timing, keyword, radius }) {
  let list;
  if (timing === 'cafe') {
    list = await searchNearby(env, { lat, lon, categoryGroupCode: CATEGORY_GROUP.CAFE, radius });
  } else if (!keyword && timing === 'before') {
    const results = await Promise.all(MORNING_KEYWORDS.map((q) => searchNearby(env, { lat, lon, query: q, radius })));
    // 키워드 6개를 각각 검색해 합치면 다른 프리셋(키워드 1개, 최대 15건)보다 결과가 훨씬 많아져서,
    // 거리순으로 추려 15건으로 맞춘다 - 결과 개수를 맞추는 목적도 있지만, 무엇보다 이 목록 그대로
    // 구글 평점 조회(findGoogleRating)를 결과 수만큼 돌리므로, 자르지 않으면 다른 프리셋보다
    // 최대 6배 많은 구글 API 호출이 나간다(나중에 구글 API 키를 등록했을 때를 대비한 비용 방어).
    list = dedupePlaces(results.flat())
      .sort((a, b) => (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity))
      .slice(0, 15);
  } else {
    const q = keyword || TIMING_KEYWORDS[timing] || null;
    list = q
      ? await searchNearby(env, { lat, lon, query: q, radius })
      : await searchNearby(env, { lat, lon, categoryGroupCode: CATEGORY_GROUP.FOOD, radius });
  }
  // 가게별 평점 조회는 서로 독립적이라 병렬로 처리(순차 처리 시 결과 15건이면 구글 API를
  // 15번 순서대로 기다리게 됨 - scoring.js computeCandidateComponents와 같은 이유로 병렬화).
  const withRatings = await Promise.all(list.map(async (r) => {
    const g = await findGoogleRating(env, { name: r.name, lat: r.lat, lon: r.lon });
    return { ...r, rating: g?.rating ?? null, reviewCount: g?.reviewCount ?? null };
  }));
  // 라운딩 후(한끼)는 평점 높은 순으로 바로 훑어볼 수 있게 정렬해서 내려준다(구글 평점 매칭
  // 실패/미설정으로 rating이 없는 곳은 뒤로 - 정렬 자체가 무의미해지지 않도록 맨 끝에 배치).
  if (timing === 'after') {
    withRatings.sort((a, b) => {
      if (a.rating == null && b.rating == null) return 0;
      if (a.rating == null) return 1;
      if (b.rating == null) return -1;
      return b.rating - a.rating;
    });
  }
  return withRatings;
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
    rating: input.rating != null ? Number(input.rating) : null,
    reviewCount: input.reviewCount != null ? Number(input.reviewCount) : null,
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
