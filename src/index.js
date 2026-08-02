import { fetchWeather } from './weather.js';
import { listScores, addScore, updateScore, deleteScore } from './scores.js';
import { computeStats } from './stats.js';
import { getSettings, updateSettings } from './settings.js';
import { listCourses, addCourse, updateCourse, deleteCourse } from './courses.js';
import { listCompanions, addCompanion, updateCompanion, deleteCompanion } from './companions.js';
import { computeSettlement } from './settlement.js';
import { searchRestaurants, listFavoriteRestaurants, addFavoriteRestaurant, deleteFavoriteRestaurant } from './restaurants.js';
import { searchKeyword, kakaoMapDirectionsUrl } from './kakao.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}

function error(message, status = 400) {
  return json({ error: message }, status);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    try {
      // ===== 날씨 =====
      if (pathname === '/api/weather' && method === 'GET') {
        const lat = Number(url.searchParams.get('lat'));
        const lon = Number(url.searchParams.get('lon'));
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          return error('lat, lon 쿼리 파라미터가 필요합니다');
        }
        return json(await fetchWeather(env, lat, lon));
      }

      // ===== 스코어 =====
      if (pathname === '/api/scores' && method === 'GET') {
        return json({ scores: await listScores(env) });
      }
      if (pathname === '/api/scores' && method === 'POST') {
        const record = await addScore(env, await request.json());
        return json({ score: record }, 201);
      }
      const scoreMatch = pathname.match(/^\/api\/scores\/([^/]+)$/);
      if (scoreMatch && method === 'PUT') {
        const record = await updateScore(env, scoreMatch[1], await request.json());
        if (!record) return error('해당 기록을 찾을 수 없습니다', 404);
        return json({ score: record });
      }
      if (scoreMatch && method === 'DELETE') {
        const ok = await deleteScore(env, scoreMatch[1]);
        if (!ok) return error('해당 기록을 찾을 수 없습니다', 404);
        return json({ deleted: true });
      }

      // ===== 통계 =====
      if (pathname === '/api/stats' && method === 'GET') {
        return json(computeStats(await listScores(env)));
      }

      // ===== 설정(집 주소) =====
      if (pathname === '/api/settings' && method === 'GET') {
        return json(await getSettings(env));
      }
      if (pathname === '/api/settings' && method === 'PUT') {
        return json(await updateSettings(env, await request.json()));
      }

      // ===== 장소 검색 (골프장 등록용 카카오 자동완성) =====
      if (pathname === '/api/places/search' && method === 'GET') {
        const query = url.searchParams.get('query');
        if (!query) return error('query 쿼리 파라미터가 필요합니다');
        return json({ places: await searchKeyword(env, query) });
      }

      // ===== 골프장 마스터 DB(즐겨찾기) =====
      if (pathname === '/api/courses' && method === 'GET') {
        return json({ courses: await listCourses(env) });
      }
      if (pathname === '/api/courses' && method === 'POST') {
        const record = await addCourse(env, await request.json());
        return json({ course: record }, 201);
      }
      const courseMatch = pathname.match(/^\/api\/courses\/([^/]+)$/);
      if (courseMatch && method === 'PUT') {
        const record = await updateCourse(env, courseMatch[1], await request.json());
        if (!record) return error('해당 골프장을 찾을 수 없습니다', 404);
        return json({ course: record });
      }
      if (courseMatch && method === 'DELETE') {
        const ok = await deleteCourse(env, courseMatch[1]);
        if (!ok) return error('해당 골프장을 찾을 수 없습니다', 404);
        return json({ deleted: true });
      }

      // ===== 동반자 =====
      if (pathname === '/api/companions' && method === 'GET') {
        return json({ companions: await listCompanions(env) });
      }
      if (pathname === '/api/companions' && method === 'POST') {
        const record = await addCompanion(env, await request.json());
        return json({ companion: record }, 201);
      }
      const companionMatch = pathname.match(/^\/api\/companions\/([^/]+)$/);
      if (companionMatch && method === 'PUT') {
        const record = await updateCompanion(env, companionMatch[1], await request.json());
        if (!record) return error('해당 동반자를 찾을 수 없습니다', 404);
        return json({ companion: record });
      }
      if (companionMatch && method === 'DELETE') {
        const ok = await deleteCompanion(env, companionMatch[1]);
        if (!ok) return error('해당 동반자를 찾을 수 없습니다', 404);
        return json({ deleted: true });
      }

      // ===== 정산 =====
      if (pathname === '/api/settlement/calculate' && method === 'POST') {
        return json(computeSettlement(await request.json()));
      }

      // ===== 맛집 =====
      if (pathname === '/api/restaurants/search' && method === 'GET') {
        const lat = Number(url.searchParams.get('lat'));
        const lon = Number(url.searchParams.get('lon'));
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          return error('lat, lon 쿼리 파라미터가 필요합니다');
        }
        const timing = url.searchParams.get('timing') || undefined;
        const keyword = url.searchParams.get('keyword') || undefined;
        const restaurants = await searchRestaurants(env, { lat, lon, timing, keyword });
        return json({
          restaurants: restaurants.map((r) => ({ ...r, directionsUrl: kakaoMapDirectionsUrl(r.name, r.lat, r.lon) })),
        });
      }
      if (pathname === '/api/restaurants/favorites' && method === 'GET') {
        return json({ favorites: await listFavoriteRestaurants(env) });
      }
      if (pathname === '/api/restaurants/favorites' && method === 'POST') {
        const record = await addFavoriteRestaurant(env, await request.json());
        return json({ favorite: record }, 201);
      }
      const favMatch = pathname.match(/^\/api\/restaurants\/favorites\/([^/]+)$/);
      if (favMatch && method === 'DELETE') {
        const ok = await deleteFavoriteRestaurant(env, favMatch[1]);
        if (!ok) return error('해당 즐겨찾기를 찾을 수 없습니다', 404);
        return json({ deleted: true });
      }

      return error('Not found', 404);
    } catch (err) {
      return error(err.message || String(err), 500);
    }
  },
};
