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

const HTML_TAG_RE = /<\/?[a-z]+>/gi;

/** 골프장 홈페이지 URL 후보 검색 (카카오 웹검색). 실제 캡처로 확인해보니 1등 결과가 골프장 공식
 * 사이트가 아니라 후기 블로그/코스 소개 사이트인 경우가 흔해서(예: "코리아컨트리클럽" 검색 시
 * heyjayboy.com 같은 후기 사이트가 1등) 자동으로 하나를 골라 채워넣지 않고, 후보 목록을 그대로
 * 돌려줘서 프론트에서 사용자가 직접 고르게 한다 - 잘못된 사이트를 자동으로 넣는 것보단 안전하다. */
export async function searchHomepageCandidates(env, courseName) {
  if (!env.KAKAO_API_KEY) return [];
  const url = new URL('https://dapi.kakao.com/v2/search/web');
  url.searchParams.set('query', `${courseName} 홈페이지`);
  url.searchParams.set('size', '5');
  const res = await fetch(url.toString(), {
    headers: { Authorization: `KakaoAK ${env.KAKAO_API_KEY}` },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.documents || []).map((d) => ({
    title: (d.title || '').replace(HTML_TAG_RE, ''),
    url: d.url,
  }));
}

/** 골프장명 -> 집 주소까지의 자동차 거리/이동시간을 한 번에 계산(이름으로 좌표 찾기 + 길찾기).
 * 예약 기록 저장 시 자동으로 채워주는 용도 - 이름으로 좌표를 못 찾거나 길찾기가 실패하면 null
 * (부가정보라 실패해도 예약 저장 자체를 막지 않는다). */
export async function resolveCourseTravelInfo(env, courseName, homeLat, homeLon) {
  if (!courseName || homeLat == null || homeLon == null) return null;
  try {
    const places = await searchKeyword(env, courseName);
    const best = places[0];
    if (!best || best.lat == null || best.lon == null) return null;
    return await fetchDrivingRoute(env, homeLat, homeLon, best.lat, best.lon);
  } catch {
    return null;
  }
}

/** 카카오모빌리티 길찾기(자동차 경로) - 집 주소 <-> 골프장 검색결과 거리/이동시간 계산용.
 * dapi.kakao.com(Local API)과는 별도 base(apis-navi.kakaomobility.com)이지만 같은 REST API 키로 호출된다
 * (별도 활용신청/제품 등록 없이 실제 호출로 확인됨). 경로를 못 찾는 경우(고속도로 미개통 지역 등)엔
 * null을 돌려주고 호출부에서 조용히 생략하게 한다 - 거리/시간은 부가정보라 실패해도 검색 자체는 막지 않는다. */
export async function fetchDrivingRoute(env, originLat, originLon, destLat, destLon) {
  if (!env.KAKAO_API_KEY) return null;
  const url = new URL('https://apis-navi.kakaomobility.com/v1/directions');
  url.searchParams.set('origin', `${originLon},${originLat}`);
  url.searchParams.set('destination', `${destLon},${destLat}`);
  try {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `KakaoAK ${env.KAKAO_API_KEY}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const summary = data?.routes?.[0]?.summary;
    if (!summary || data.routes[0].result_code !== 0) return null;
    return {
      distanceKm: Math.round((summary.distance / 1000) * 10) / 10,
      durationMin: Math.round(summary.duration / 60),
    };
  } catch {
    return null;
  }
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

/** 좌표 -> 행정구역(시/도, 시/군/구) 역지오코딩. 기상청 중기예보 지역코드 매칭용(골프장 좌표 -> regId) */
export async function coordToRegion(env, lat, lon) {
  const data = await kakaoFetch(env, '/geo/coord2regioncode.json', { x: lon, y: lat });
  // region_type 'H'(행정동) 우선, 없으면 'B'(법정동)
  const docs = data.documents || [];
  const doc = docs.find((d) => d.region_type === 'H') || docs[0];
  if (!doc) return null;
  return {
    sido: doc.region_1depth_name || '',
    sigungu: doc.region_2depth_name || '',
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
