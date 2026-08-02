import { fetchWeather } from './weather.js';
import { listScores, addScore, updateScore, deleteScore } from './scores.js';
import { computeStats } from './stats.js';

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

    try {
      // GET /api/weather?lat=&lon=
      if (pathname === '/api/weather' && request.method === 'GET') {
        const lat = Number(url.searchParams.get('lat'));
        const lon = Number(url.searchParams.get('lon'));
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          return error('lat, lon 쿼리 파라미터가 필요합니다');
        }
        const result = await fetchWeather(env, lat, lon);
        return json(result);
      }

      // GET /api/scores
      if (pathname === '/api/scores' && request.method === 'GET') {
        const scores = await listScores(env);
        return json({ scores });
      }

      // POST /api/scores
      if (pathname === '/api/scores' && request.method === 'POST') {
        const body = await request.json();
        const record = await addScore(env, body);
        return json({ score: record }, 201);
      }

      // PUT /api/scores/:id
      const scoreMatch = pathname.match(/^\/api\/scores\/([^/]+)$/);
      if (scoreMatch && request.method === 'PUT') {
        const body = await request.json();
        const record = await updateScore(env, scoreMatch[1], body);
        if (!record) return error('해당 기록을 찾을 수 없습니다', 404);
        return json({ score: record });
      }

      // DELETE /api/scores/:id
      if (scoreMatch && request.method === 'DELETE') {
        const ok = await deleteScore(env, scoreMatch[1]);
        if (!ok) return error('해당 기록을 찾을 수 없습니다', 404);
        return json({ deleted: true });
      }

      // GET /api/stats
      if (pathname === '/api/stats' && request.method === 'GET') {
        const scores = await listScores(env);
        return json(computeStats(scores));
      }

      return error('Not found', 404);
    } catch (err) {
      return error(err.message || String(err), 500);
    }
  },
};
