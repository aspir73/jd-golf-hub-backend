// 전국 골프장(문체부 DB 541곳)의 위치 좌표를 한 번만 계산해서 KV에 저장해 둔다. 골프장 목록의 "집에서 가까운 순"
// 정렬은 집 좌표와 이 좌표의 직선거리로 하고, 소요시간 정렬은 가까운 후보만 길찾기로 보강한다(프론트 처리).
// 문체부 DB에는 좌표가 없어서 카카오 장소검색으로 찾는다. Worker 한 번에 보낼 수 있는 요청 수 한도 때문에
// 한 번에 몇 곳씩만 처리하고(build), 프론트가 끝날 때까지 반복 호출한다. 좌표는 변하지 않으니 한번 찾으면 영구 보관한다.

import { listGolfCourseDB } from './golfCourseDB.js';
import { findGolfPlace } from './kakao.js';
import { getSettings } from './settings.js';

const KEY = 'golfgeo:v1';
const CHUNK = 12; // 한 번 호출에 처리할 골프장 수 (곳당 최대 3번 검색 -> 서브리퀘스트 한도 안)
const CONCURRENCY = 4;

async function load(env) {
  return (await env.GOLF_KV.get(KEY, 'json')) || { coords: {}, notFound: [] };
}

export async function getGolfGeo(env) {
  const data = await load(env);
  const all = listGolfCourseDB().map((c) => c.name);
  const done = new Set([...Object.keys(data.coords), ...data.notFound]);
  const settings = await getSettings(env);
  return {
    home: settings.homeLat != null && settings.homeLon != null ? { lat: settings.homeLat, lon: settings.homeLon } : null,
    coords: data.coords,
    total: all.length,
    missing: all.filter((n) => !done.has(n)).length,
  };
}

/** 아직 좌표가 없는 골프장 몇 곳을 찾아 저장하고 남은 수를 돌려준다. */
export async function buildGolfGeoChunk(env) {
  const data = await load(env);
  const all = listGolfCourseDB().map((c) => c.name);
  const done = new Set([...Object.keys(data.coords), ...data.notFound]);
  const todo = all.filter((n) => !done.has(n)).slice(0, CHUNK);
  const queue = [...todo];
  async function worker() {
    while (queue.length) {
      const name = queue.shift();
      try {
        const place = await findGolfPlace(env, name);
        if (place && place.lat != null && place.lon != null) data.coords[name] = { lat: place.lat, lon: place.lon };
        else data.notFound.push(name);
      } catch {
        // 일시 오류는 결과에 넣지 않아 다음 호출에서 다시 시도된다
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (todo.length) await env.GOLF_KV.put(KEY, JSON.stringify(data));
  const left = all.filter((n) => !data.coords[n] && !data.notFound.includes(n)).length;
  return { processed: todo.length, remaining: left, total: all.length };
}
