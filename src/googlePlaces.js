// 카카오 로컬 API에는 평점(rating) 필드가 아예 없다(공식 문서 기준 - 별점·리뷰는 카카오맵
// 웹페이지에만 있고 API 응답으로는 내려주지 않음). 그래서 평점만 구글 Places API로 별도 조회해서
// 카카오 검색 결과에 보강한다. "Find Place from Text"에 가게 이름 + locationbias(좌표 반경)를
// 같이 넘겨서 동명이인(동명 다른 지점) 매칭 오류를 줄인다.
const GOOGLE_PLACES_BASE = 'https://maps.googleapis.com/maps/api/place';

/** 가게 하나의 평점/리뷰수를 조회. API 키 미설정이거나 매칭 실패/에러 시 null - 호출부는 null이면
 * 그냥 평점 없이 표시한다(맛집 검색 자체가 이 조회 때문에 실패하면 안 됨). */
export async function findGoogleRating(env, { name, lat, lon }) {
  if (!env.GOOGLE_PLACES_API_KEY || !name || lat == null || lon == null) return null;
  try {
    const url = new URL(`${GOOGLE_PLACES_BASE}/findplacefromtext/json`);
    url.searchParams.set('input', name);
    url.searchParams.set('inputtype', 'textquery');
    url.searchParams.set('fields', 'rating,user_ratings_total');
    url.searchParams.set('locationbias', `circle:200@${lat},${lon}`);
    url.searchParams.set('language', 'ko');
    url.searchParams.set('key', env.GOOGLE_PLACES_API_KEY);
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const data = await res.json();
    const candidate = data.candidates?.[0];
    if (!candidate || candidate.rating == null) return null;
    return { rating: candidate.rating, reviewCount: candidate.user_ratings_total ?? null };
  } catch {
    return null;
  }
}
