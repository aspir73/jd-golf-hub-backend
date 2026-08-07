// 카카오맵(로컬) REST API 연동. 검색/좌표변환 용도의 무료 쿼터 API만 사용하고,
// 실제 턴바이턴 길찾기는 카카오맵 앱/웹 딥링크로 위임한다 (기획서 4장: "지도 연동은 카카오맵으로 단일화").

const KAKAO_BASE = 'https://dapi.kakao.com/v2/local';

export const CATEGORY_GROUP = {
  FOOD: 'FD6',
  CAFE: 'CE7',
};

async function kakaoFetch(env, path, params) {
  if (!env.KAKAO_API_KEY) {
    throw new Error('KAKAO_API_KEY가 설정되지 않았습니다 (wrangler secret put KAKAO_API_KEY)');
  }
  const url = new URL(KAKAO_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: `KakaoAK ${env.KAKAO_API_KEY}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`카카오맵 API 호출 실패: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

function mapPlace(d) {
  return {
    name: d.place_name,
    address: d.road_address_name || d.address_name || '',
    phone: d.phone || '',
    lat: Number(d.y),
    lon: Number(d.x),
    category: d.category_name || '',
    placeUrl: d.place_url || '',
    distanceMeters: d.distance ? Number(d.distance) : null,
  };
}

/** 키워드로 장소 검색 (골프장 즐겨찾기 등록 시 주소/연락처/좌표 자동완성용) */
export async function searchKeyword(env, query, { lat, lon } = {}) {
  const data = await kakaoFetch(env, '/search/keyword.json', {
    query,
    size: 10,
    x: lon,
    y: lat,
  });
  return (data.documents || []).map(mapPlace);
}

function mapAddress(d) {
  const road = d.road_address;
  const jibun = d.address;
  return {
    name: road?.building_name || d.address_name || '',
    address: road?.address_name || jibun?.address_name || d.address_name || '',
    phone: '',
    lat: Number(d.y),
    lon: Number(d.x),
    category: '',
    placeUrl: '',
    distanceMeters: null,
  };
}

/** 도로명/지번 주소로 검색 (keyword.json은 상호명 위주라 "백현로277"처럼 건물명 없는
 *  순수 주소는 못 찾는 경우가 많음 - 카카오가 주소 전용으로 제공하는 별도 API) */
export async function searchAddress(env, query) {
  const data = await kakaoFetch(env, '/search/address.json', { query, size: 10 });
  return (data.documents || []).map(mapAddress);
}

/** 주소 검색과 키워드(상호명) 검색을 함께 돌려서 합친다.
 *  "백현로277" 같은 순수 도로명 주소와 "OO컨트리클럽" 같은 상호명 둘 다 자동완성되게.
 *  주소 검색 결과를 우선 배치하고(더 정확한 매칭), 좌표가 거의 같은 중복은 제거한다. */
export async function searchPlaces(env, query) {
  const [addressResults, keywordResults] = await Promise.all([
    searchAddress(env, query).catch(() => []),
    searchKeyword(env, query).catch(() => []),
  ]);
  const seen = new Set();
  const merged = [];
  for (const p of [...addressResults, ...keywordResults]) {
    const key = p.lat != null && p.lon != null ? `${p.lat.toFixed(5)},${p.lon.toFixed(5)}` : `${p.name}|${p.address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(p);
  }
  return merged;
}

/** 좌표 주변 카테고리/키워드 검색 (맛집 찾기용). query가 있으면 좌표 기준 정렬 키워드검색, 없으면 카테고리검색 */
export async function searchNearby(env, { lat, lon, categoryGroupCode, radius = 3000, query }) {
  if (!lat || !lon) throw new Error('lat, lon이 필요합니다');
  const path = query ? '/search/keyword.json' : '/search/category.json';
  const params = query
    ? { query, x: lon, y: lat, radius, sort: 'distance' }
    : { category_group_code: categoryGroupCode, x: lon, y: lat, radius, sort: 'distance' };
  const data = await kakaoFetch(env, path, params);
  return (data.documents || []).map(mapPlace);
}

/** Haversine 직선거리(km). 카카오 길찾기(내비) API는 별도 승인/유료라 MVP2에서는 직선거리로 근사한다 */
export function distanceKm(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some((v) => v == null || Number.isNaN(v))) return null;
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 10) / 10;
}

/** 카카오맵 길찾기 딥링크 (앱/웹 공용) */
export function kakaoMapDirectionsUrl(name, lat, lon) {
  return `https://map.kakao.com/link/to/${encodeURIComponent(name)},${lat},${lon}`;
}
