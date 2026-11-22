import { fetchWeather, fetchMidTermWeather, fetchWeekAheadWeather, fetchGolfWeatherBoard, fetchOpenMeteoForDate, fetchOpenMeteoWeekly, fetchOpenMeteoHourlyForRound, fetchOpenMeteoHourlyRange, kstTodayDateStr } from './weather.js';
import { resolveCourseCoords } from './roundWeather.js';
import { listScores, addScore, updateScore, deleteScore, bulkAddScores } from './scores.js';
import { computeStats } from './stats.js';
import { getSettings, updateSettings } from './settings.js';
import { listCourses, addCourse, updateCourse, deleteCourse, reorderCourses, bulkAddCourses, setCourseRecommend } from './courses.js';
import { resolveWeekGreenFees } from './courseGreenFees.js';
import { searchRestaurants, listFavoriteRestaurants, addFavoriteRestaurant, deleteFavoriteRestaurant } from './restaurants.js';
import { searchPlaces, kakaoMapDirectionsUrl, searchHomepageCandidates, searchNearbyGolfCourses, findGolfPlace, cachedDrivingRoute } from './kakao.js';
import { searchGolfpangRoundsAllPages } from './golfpang.js';
import { searchGolfmonRounds } from './golfmon.js';
import { searchKakaoGolfRounds, fetchKakaoGolfTeeTimes, checkNasRelay } from './kakaogolf.js';
import { searchXgolfRounds } from './xgolf.js';
import { listGroups, addGroup, addCandidate, removeCandidate, deleteGroup, getGroup } from './comparisonGroups.js';
import { computeCandidateComponents } from './scoring.js';
import { listBookings, addBooking, updateBooking, deleteBooking, findMatchingBooking, confirmMatchedBooking } from './bookings.js';
import { parseBookingMessage } from './messageParsing.js';
import { listGolfCourseDB, listRegions, searchGolfCourseDB } from './golfCourseDB.js';
import { listWatches, addWatch, updateWatch, deleteWatch, refreshWatch, refreshAllWatches, bulkAddWatches, bulkDeleteWatches } from './watches.js';
import { ingestPriceSnapshot, listTrackedCourses, getCourseHistory, getWeekdayTrend, getLeadTimeTrend, getLowestToday } from './priceDashboard.js';
import { listCourseInfo, getCourseInfoByName, getCourseView, addCourseInfo, updateCourseInfo, deleteCourseInfo, bulkAddCourseInfo } from './courseInfo.js';
import { findKgaRating } from './kgaCourseRating.js';
import { listCourseHoleDbIndex } from './courseHoleDb.js';
import { fetchWeekendBoard } from './weekendBoard.js';
import { saveBaseccSnapshot, getBaseccRounds } from './teeSnapshots.js';
import { getGolfGeo, buildGolfGeoChunk } from './golfGeo.js';
import { buildRoundAnalysis, buildSeasonReport } from './roundReport.js';
import { syncRoundToDb, backfillRoundsToDb } from './roundDb.js';

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
        const date = url.searchParams.get('date') || undefined; // YYYY-MM-DD 또는 YYYYMMDD, 없으면 오늘(KST)
        return json(await fetchWeather(env, lat, lon, date));
      }

      if (pathname === '/api/weather/midterm' && method === 'GET') {
        const lat = Number(url.searchParams.get('lat'));
        const lon = Number(url.searchParams.get('lon'));
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          return error('lat, lon 쿼리 파라미터가 필요합니다');
        }
        const date = url.searchParams.get('date') || undefined;
        return json(await fetchMidTermWeather(env, lat, lon, date));
      }

      // 오늘부터 +6일(7일)치 요약 - MY골프장 카드처럼 날짜별로 여러 번 조회하기엔 API 호출이
      // 많아지는 곳에서 한 번에 쓰는 용도
      if (pathname === '/api/weather/week' && method === 'GET') {
        const lat = Number(url.searchParams.get('lat'));
        const lon = Number(url.searchParams.get('lon'));
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          return error('lat, lon 쿼리 파라미터가 필요합니다');
        }
        return json(await fetchWeekAheadWeather(env, lat, lon));
      }

      // 홈 탭 "주간 골프 기상도" - 경기남부/북부·경춘·강원·충청 5개 고정 권역, 위치 권한 불필요
      if (pathname === '/api/weather/board' && method === 'GET') {
        return json(await fetchGolfWeatherBoard(env));
      }

      // "티타임 모니터링"(워치 그룹) 카드 날씨 타일 전용 - 특정 좌표의 특정 날짜 하루치(Open-Meteo)
      if (pathname === '/api/weather/openmeteo' && method === 'GET') {
        const lat = Number(url.searchParams.get('lat'));
        const lon = Number(url.searchParams.get('lon'));
        const date = url.searchParams.get('date');
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || !date) {
          return error('lat, lon, date 쿼리 파라미터가 필요합니다');
        }
        return json(await fetchOpenMeteoForDate(lat, lon, date));
      }

      // 날씨 탭 "골프장 날씨 검색" - 검색해서 추가한 골프장의 7일 온도·강우 예보(Open-Meteo)
      if (pathname === '/api/weather/course' && method === 'GET') {
        const lat = Number(url.searchParams.get('lat'));
        const lon = Number(url.searchParams.get('lon'));
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          return error('lat, lon 쿼리 파라미터가 필요합니다');
        }
        return json(await fetchOpenMeteoWeekly(lat, lon));
      }

      // 날씨 탭 - "라운드 일정"에 예약된 골프장의 라운딩 전날~당일 시간별 예보(Open-Meteo)
      // 스코어 입력 화면 날씨 띠: 골프장 이름 → 좌표 → 오늘~내일 시간별 예보(지금·2시간 뒤·4시간 뒤는 프론트가 고른다)
      if (pathname === '/api/weather/round-now' && method === 'GET') {
        const courseName = url.searchParams.get('courseName');
        if (!courseName) return error('courseName 쿼리 파라미터가 필요합니다');
        const coords = await resolveCourseCoords(env, courseName);
        if (!coords) return json({ hours: [], coords: null });
        const today = kstTodayDateStr();
        const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
        return json({ hours: await fetchOpenMeteoHourlyRange(coords.lat, coords.lon, today, tomorrow), coords });
      }
      if (pathname === '/api/weather/course-hourly' && method === 'GET') {
        const lat = Number(url.searchParams.get('lat'));
        const lon = Number(url.searchParams.get('lon'));
        const roundDate = url.searchParams.get('roundDate');
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || !roundDate) {
          return error('lat, lon, roundDate 쿼리 파라미터가 필요합니다');
        }
        return json(await fetchOpenMeteoHourlyForRound(lat, lon, roundDate));
      }

      // ===== 스코어 =====
      if (pathname === '/api/scores' && method === 'GET') {
        return json({ scores: await listScores(env) });
      }
      if (pathname === '/api/scores/bulk' && method === 'POST') {
        const { items } = await request.json();
        if (!Array.isArray(items)) return error('items(배열)가 필요합니다');
        return json(await bulkAddScores(env, items));
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

      // ===== 골프장 코스/홀 정보(직접 입력 - 스코어 탭 "홀별 상세 입력"에서 파 정보 채우는 데 사용) =====
      if (pathname === '/api/course-info' && method === 'GET') {
        const courseName = url.searchParams.get('courseName');
        if (courseName) return json({ courseInfo: await getCourseInfoByName(env, courseName) });
        return json({ courseInfoList: await listCourseInfo(env) });
      }
      // 골프장 보기 화면: 직접 입력 코스정보(own) + 전국 코스DB(db: 소개·티별 거리)
      if (pathname === '/api/course-info/view' && method === 'GET') {
        const courseName = url.searchParams.get('courseName');
        if (!courseName) return error('courseName 쿼리 파라미터가 필요합니다');
        return json(await getCourseView(env, courseName));
      }
      // 전국 코스DB(D1 gc_*)에 코스·홀 데이터가 있는 골프장 이름 목록 - 골프장 목록의 "코스 입력 ›" 표시 판단용
      if (pathname === '/api/course-info/db-index' && method === 'GET') {
        return json({ clubs: await listCourseHoleDbIndex(env) });
      }
      if (pathname === '/api/course-info/bulk' && method === 'POST') {
        const { items } = await request.json();
        if (!Array.isArray(items)) return error('items(배열)가 필요합니다');
        return json(await bulkAddCourseInfo(env, items));
      }
      if (pathname === '/api/course-info' && method === 'POST') {
        const record = await addCourseInfo(env, await request.json());
        return json({ courseInfo: record }, 201);
      }
      const courseInfoMatch = pathname.match(/^\/api\/course-info\/([^/]+)$/);
      if (courseInfoMatch && method === 'PUT') {
        const record = await updateCourseInfo(env, courseInfoMatch[1], await request.json());
        if (!record) return error('해당 코스정보를 찾을 수 없습니다', 404);
        return json({ courseInfo: record });
      }
      if (courseInfoMatch && method === 'DELETE') {
        const ok = await deleteCourseInfo(env, courseInfoMatch[1]);
        if (!ok) return error('해당 코스정보를 찾을 수 없습니다', 404);
        return json({ deleted: true });
      }

      // ===== KGA 공식 코스레이팅(경기·강원·충북·충남 111개 골프장, 정적 데이터) =====
      if (pathname === '/api/kga-rating' && method === 'GET') {
        const courseName = url.searchParams.get('courseName');
        if (!courseName) return error('courseName 쿼리 파라미터가 필요합니다');
        return json({ rating: findKgaRating(courseName) });
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

      // ===== 라운드 리포트(D1 rounds/holes 기반) =====
      // 기존 KV 스코어 기록을 D1로 채운다(여러 번 호출해도 같은 결과).
      if (pathname === '/api/reports/backfill' && method === 'POST') {
        return json(await backfillRoundsToDb(env, await listScores(env)));
      }
      // 시즌 집계: 라운드 수/평균·베스트/퍼팅/GIR·FIR/분포/트러블/코스별/최근 추세
      if (pathname === '/api/reports/season' && method === 'GET') {
        return json(await buildSeasonReport(env, url.searchParams.get('year')));
      }
      // 한 라운드 분석(시즌 비교 포함) - 홈 요약 카드/결과 팝업이 사용
      const roundReportMatch = pathname.match(/^\/api\/reports\/round\/([^/]+)$/);
      if (roundReportMatch && method === 'GET') {
        const id = roundReportMatch[1];
        let round = await env.PRICE_DB.prepare('SELECT id, play_date, year, course_name, status FROM rounds WHERE id = ?').bind(id).first();
        if (!round) {
          // D1에 아직 없으면(반영 실패 등) KV 원본으로 한 번 채우고 다시 읽는다.
          const record = (await listScores(env)).find((s) => s.id === id);
          if (!record) return error('라운드를 찾을 수 없습니다', 404);
          await syncRoundToDb(env, record);
          round = await env.PRICE_DB.prepare('SELECT id, play_date, year, course_name, status FROM rounds WHERE id = ?').bind(id).first();
        }
        const analysis = await buildRoundAnalysis(env, round);
        return json({ round: { id: round.id, date: round.play_date, courseName: round.course_name, status: round.status }, analysis });
      }

      // 대영베이스CC 티타임 스냅샷 - 홈페이지 방화벽이 Worker IP를 막아서 NAS(basecc_collector.py)가 읽어 올린다.
      if (pathname === '/api/tee-snapshots/basecc' && method === 'POST') {
        const secret = request.headers.get('X-Ingest-Secret');
        if (!env.PRICE_INGEST_SECRET || secret !== env.PRICE_INGEST_SECRET) return error('인증 실패', 401);
        return json(await saveBaseccSnapshot(env, await request.json()));
      }
      if (pathname === '/api/basecc/search' && method === 'GET') {
        const date = url.searchParams.get('date');
        if (!date) return error('date 쿼리 파라미터가 필요합니다');
        const result = await getBaseccRounds(env, date);
        const ampm = url.searchParams.get('ampm');
        const caddy = url.searchParams.get('caddy');
        let rounds = result.rounds;
        if (ampm === 'am') rounds = rounds.filter((r) => Number(r.time.split(':')[0]) < 12);
        if (caddy) rounds = rounds.filter((r) => r.caddyType === caddy);
        return json({ open: result.open, fetchedAt: result.fetchedAt, stale: result.stale, rounds });
      }

      // 예약 탭 "이번 주말 현황" - 지정 골프장들의 다가오는 토·일 오전 티타임/그린피/날씨
      if (pathname === '/api/weekend-board' && method === 'GET') {
        return json(await fetchWeekendBoard(env, { refresh: url.searchParams.get('refresh') === '1', mode: url.searchParams.get('mode') === 'join' ? 'join' : 'booking' }));
      }

      // 골프장명 → 좌표 + 집에서의 거리/시간 (홈 "라운드 일정" 카드의 날씨·거리 표시용)
      if (pathname === '/api/places/golf-travel' && method === 'GET') {
        const courseName = url.searchParams.get('courseName');
        if (!courseName) return error('courseName 쿼리 파라미터가 필요합니다');
        // 골프장 위치(이름→좌표)는 거의 안 바뀌어서 30일 캐시하고, 거리/시간은 좌표 기준 캐시(cachedDrivingRoute)를 쓴다 -
        // 이름이 달라도 같은 장소(태광CC 회원제/대중제 등)면 같은 값이 나오게. 골프장 목록이 화면에 보이는 줄마다 이 조회를 부른다.
        const settings = await getSettings(env);
        let h = 5381;
        for (const ch of courseName) h = ((h << 5) + h + ch.charCodeAt(0)) >>> 0;
        const placeKey = `golfplace:v1:${h.toString(36)}`;
        let place = await env.GOLF_KV.get(placeKey, 'json');
        if (!place) {
          const found = await findGolfPlace(env, courseName);
          if (!found) return json({ place: null });
          place = { name: found.name, lat: found.lat, lon: found.lon };
          await env.GOLF_KV.put(placeKey, JSON.stringify(place), { expirationTtl: 30 * 24 * 3600 });
        }
        const route = await cachedDrivingRoute(env, settings.homeLat, settings.homeLon, place.lat, place.lon).catch(() => null);
        const payload = { place, distanceKm: route?.distanceKm ?? null, durationMin: route?.durationMin ?? null };
        return json(payload);
      }

      // 현재 위치(또는 집) 기준 가까운 골프장 - 스코어카드 시작 화면
      if (pathname === '/api/places/nearby-golf' && method === 'GET') {
        const lat = Number(url.searchParams.get('lat'));
        const lon = Number(url.searchParams.get('lon'));
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return error('lat, lon 쿼리 파라미터가 필요합니다');
        return json({ courses: await searchNearbyGolfCourses(env, { lat, lon }) });
      }

      // ===== 장소 검색 (골프장 등록용 카카오 자동완성) =====
      if (pathname === '/api/places/search' && method === 'GET') {
        const query = url.searchParams.get('query');
        if (!query) return error('query 쿼리 파라미터가 필요합니다');
        const places = await searchPlaces(env, query);
        // 집 주소가 설정돼 있으면 각 검색결과까지의 자동차 거리/이동시간을 함께 내려준다
        // (골프장 즐겨찾기 추가 시 후보 비교용) - 실패해도 검색 자체는 막지 않는다.
        const settings = await getSettings(env);
        if (settings.homeLat != null && settings.homeLon != null) {
          await Promise.all(
            places.map(async (p) => {
              if (p.lat == null || p.lon == null) return;
              const route = await cachedDrivingRoute(env, settings.homeLat, settings.homeLon, p.lat, p.lon);
              if (route) {
                p.driveDistanceKm = route.distanceKm;
                p.driveDurationMin = route.durationMin;
              }
            })
          );
        }
        return json({ places });
      }
      if (pathname === '/api/homepage-search' && method === 'GET') {
        const query = url.searchParams.get('query');
        if (!query) return error('query 쿼리 파라미터가 필요합니다');
        return json({ results: await searchHomepageCandidates(env, query) });
      }

      // ===== 문화체육관광부 전국 골프장 현황(공식 DB) =====
      if (pathname === '/api/golf-db/regions' && method === 'GET') {
        return json({ regions: listRegions() });
      }
      if (pathname === '/api/golf-db/search' && method === 'GET') {
        const query = url.searchParams.get('query');
        if (!query) return error('query 쿼리 파라미터가 필요합니다');
        const region = url.searchParams.get('region') || undefined;
        const type = url.searchParams.get('type') || undefined;
        return json({ courses: searchGolfCourseDB(query, { region, type }) });
      }
      if (pathname === '/api/golf-db' && method === 'GET') {
        const region = url.searchParams.get('region') || undefined;
        const type = url.searchParams.get('type') || undefined;
        return json({ courses: listGolfCourseDB({ region, type }) });
      }

      // ===== 골프장 마스터 DB(즐겨찾기) =====
      if (pathname === '/api/courses' && method === 'GET') {
        return json({ courses: await listCourses(env) });
      }
      if (pathname === '/api/courses' && method === 'POST') {
        const record = await addCourse(env, await request.json());
        return json({ course: record }, 201);
      }
      // 여러 골프장명을 한 번에 등록(레이스 컨디션 없이 KV 읽기1/쓰기1로 처리 - courses.js 참고)
      if (pathname === '/api/courses/bulk' && method === 'POST') {
        const { names } = await request.json();
        if (!Array.isArray(names) || !names.length) return error('names(배열)가 필요합니다');
        const results = await bulkAddCourses(env, names);
        return json(results);
      }
      // 전국 골프장 좌표(집에서 가까운 순 정렬용) - 조회, 그리고 아직 없는 곳을 몇 곳씩 채우기
      if (pathname === '/api/golf-geo' && method === 'GET') {
        return json(await getGolfGeo(env));
      }
      if (pathname === '/api/golf-geo/build' && method === 'POST') {
        return json(await buildGolfGeoChunk(env));
      }

      // 주말 추천(예약 탭)/주말 조인(조인 탭) 대상 지정 - 종류별 최대 6개
      const recMatch = pathname.match(/^\/api\/courses\/([^/]+)\/recommend$/);
      if (recMatch && method === 'POST') {
        const { kind, on } = await request.json();
        try {
          const record = await setCourseRecommend(env, recMatch[1], kind, on);
          if (!record) return error('해당 골프장을 찾을 수 없습니다', 404);
          return json({ course: record });
        } catch (e) {
          return error(e.message, 400);
        }
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
      // 드래그로 재정렬한 최종 순서(id 배열)를 통째로 받아 그대로 저장(MY골프장 드래그 정렬용)
      if (pathname === '/api/courses/reorder' && method === 'POST') {
        const { orderedIds } = await request.json();
        if (!Array.isArray(orderedIds)) return error('orderedIds(배열)가 필요합니다');
        const courses = await reorderCourses(env, orderedIds);
        return json({ courses });
      }
      // MY골프장 카드의 "향후 7일 요일별 최저 그린피" - 즐겨찾기 전체를 지역별로 묶어 한 번에 조회
      if (pathname === '/api/courses/week-greenfees' && method === 'GET') {
        const courses = await listCourses(env);
        const greenFees = await resolveWeekGreenFees(env, courses);
        return json({ greenFees });
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
        const radiusParam = Number(url.searchParams.get('radius'));
        const radius = Number.isFinite(radiusParam) && radiusParam > 0 ? radiusParam : undefined;
        const restaurants = await searchRestaurants(env, { lat, lon, timing, keyword, radius });
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

      // ===== 골프장 조건검색 (골팡 비로그인 조회 프록시) =====
      // 사용자가 직접 누르는 단발성 검색이라(크론 배치와 달리 서브리퀘스트 예산 여유가 넉넉함)
      // 페이지 1개(최대 100건)만 보지 않고 최대 15페이지(1,500건)까지 끝까지 훑는다 - 안 그러면
      // 매물 많은 지역/날짜에서 특정 골프장이 페이지 1 밖에 있어 검색에 아예 안 잡히는 문제가 있다.
      if (pathname === '/api/golfpang/search' && method === 'GET') {
        const date = url.searchParams.get('date');
        const ampm = url.searchParams.get('ampm') || '';
        const sector = url.searchParams.get('sector') || '';
        const mode = url.searchParams.get('mode') === 'join' ? 'join' : 'booking';
        const caddyType = url.searchParams.get('caddyType') || '';
        if (!date) return error('date 쿼리 파라미터가 필요합니다 (YYYY-MM-DD)');
        return json(await searchGolfpangRoundsAllPages(env, { date, ampm, sector, mode, caddyType }, 15));
      }

      // ===== 골프장 조건검색 (골프몬 비로그인 조회 프록시) =====
      if (pathname === '/api/golfmon/search' && method === 'GET') {
        const date = url.searchParams.get('date');
        if (!date) return error('date 쿼리 파라미터가 필요합니다 (YYYY-MM-DD)');
        const locationFk = url.searchParams.get('locationFk') || '';
        const teeOffBuckets = (url.searchParams.get('teeOffBuckets') || '').split(',').filter(Boolean);
        const caddyTypes = (url.searchParams.get('caddyTypes') || '').split(',').filter(Boolean);
        const settings = await getSettings(env);
        return json(
          await searchGolfmonRounds(env, {
            date,
            locationFk,
            teeOffBuckets,
            caddyTypes,
            homeLat: settings.homeLat,
            homeLon: settings.homeLon,
          })
        );
      }

      // ===== 골프장 조건검색 (카카오골프예약 비로그인 조회 프록시) =====
      // 카카오골프예약 연결 진단 - NAS 중계 상태(등록 시각/응답 여부)를 보여준다
      if (pathname === '/api/kakaogolf/status' && method === 'GET') {
        return json(await checkNasRelay(env));
      }
      if (pathname === '/api/kakaogolf/search' && method === 'GET') {
        const date = url.searchParams.get('date');
        if (!date) return error('date 쿼리 파라미터가 필요합니다 (YYYY-MM-DD)');
        const areas = (url.searchParams.get('areas') || '').split(',').filter(Boolean);
        const timeZones = (url.searchParams.get('timeZones') || '').split(',').filter(Boolean).map(Number);
        const visitorCnt = Number(url.searchParams.get('visitorCnt') || 0);
        const events = (url.searchParams.get('events') || '').split(',').filter(Boolean).map(Number);
        const greenFees = (url.searchParams.get('greenFees') || '').split(',').filter(Boolean).map(Number);
        const holeCnt = Number(url.searchParams.get('holeCnt') || 0);
        return json(await searchKakaoGolfRounds(env, { date, areas, timeZones, visitorCnt, events, greenFees, holeCnt }));
      }

      // ===== 카카오골프예약: 특정 골프장의 실제 예약 가능 티타임 목록 (검색 결과 클릭 시 개별 조회) =====
      if (pathname === '/api/kakaogolf/detail' && method === 'GET') {
        const golfInfoSeq = url.searchParams.get('golfInfoSeq');
        const date2 = url.searchParams.get('date');
        if (!golfInfoSeq) return error('golfInfoSeq 쿼리 파라미터가 필요합니다');
        if (!date2) return error('date 쿼리 파라미터가 필요합니다 (YYYY-MM-DD)');
        const timeZone2 = Number(url.searchParams.get('timeZone') || 0);
        const visitorCnt2 = Number(url.searchParams.get('visitorCnt') || 0);
        return json({
          teeTimes: await fetchKakaoGolfTeeTimes(env, {
            golfInfoSeq,
            date: date2,
            timeZone: timeZone2,
            visitorCnt: visitorCnt2,
          }),
        });
      }

      // ===== 골프장 조건검색 (XGOLF 비로그인 조회 프록시 - 사용자 HAR 캡처로 재현, xgolf.js 참고) =====
      if (pathname === '/api/xgolf/search' && method === 'GET') {
        const date3 = url.searchParams.get('date');
        if (!date3) return error('date 쿼리 파라미터가 필요합니다 (YYYY-MM-DD)');
        const areaCode = url.searchParams.get('areaCode') || '';
        const startHour = Number(url.searchParams.get('startHour') || 0);
        const endHour = Number(url.searchParams.get('endHour') || 24);
        const minFee = Number(url.searchParams.get('minFee') || 0);
        const maxFee = Number(url.searchParams.get('maxFee') || 1000000);
        const holes = Number(url.searchParams.get('holes') || 18);
        const page = Number(url.searchParams.get('page') || 1);
        return json(await searchXgolfRounds(env, { date: date3, areaCode, startHour, endHour, minFee, maxFee, holes, page }));
      }

      // ===== 동반예약(백업) 비교 그룹 =====
      if (pathname === '/api/booking-groups' && method === 'GET') {
        return json({ groups: await listGroups(env) });
      }
      if (pathname === '/api/booking-groups' && method === 'POST') {
        const record = await addGroup(env, await request.json());
        return json({ group: record }, 201);
      }
      const groupMatch = pathname.match(/^\/api\/booking-groups\/([^/]+)$/);
      if (groupMatch && method === 'DELETE') {
        const ok = await deleteGroup(env, groupMatch[1]);
        if (!ok) return error('해당 그룹을 찾을 수 없습니다', 404);
        return json({ deleted: true });
      }
      const groupCandidatesMatch = pathname.match(/^\/api\/booking-groups\/([^/]+)\/candidates$/);
      if (groupCandidatesMatch && method === 'POST') {
        const group = await addCandidate(env, groupCandidatesMatch[1], await request.json());
        if (!group) return error('해당 그룹을 찾을 수 없습니다', 404);
        return json({ group });
      }
      const candidateMatch = pathname.match(/^\/api\/booking-groups\/([^/]+)\/candidates\/([^/]+)$/);
      if (candidateMatch && method === 'DELETE') {
        const group = await removeCandidate(env, candidateMatch[1], candidateMatch[2]);
        if (!group) return error('해당 그룹을 찾을 수 없습니다', 404);
        return json({ group });
      }
      const compareMatch = pathname.match(/^\/api\/booking-groups\/([^/]+)\/compare$/);
      if (compareMatch && method === 'GET') {
        const group = await getGroup(env, compareMatch[1]);
        if (!group) return error('해당 그룹을 찾을 수 없습니다', 404);
        return json(await computeCandidateComponents(env, group));
      }

      // ===== 예약 기록 =====
      if (pathname === '/api/bookings' && method === 'GET') {
        return json({ bookings: await listBookings(env) });
      }
      if (pathname === '/api/bookings' && method === 'POST') {
        const record = await addBooking(env, await request.json());
        return json({ booking: record }, 201);
      }
      const bookingMatch = pathname.match(/^\/api\/bookings\/([^/]+)$/);
      if (bookingMatch && method === 'PUT') {
        const record = await updateBooking(env, bookingMatch[1], await request.json());
        if (!record) return error('해당 예약 기록을 찾을 수 없습니다', 404);
        return json({ booking: record });
      }
      if (bookingMatch && method === 'DELETE') {
        const ok = await deleteBooking(env, bookingMatch[1]);
        if (!ok) return error('해당 예약 기록을 찾을 수 없습니다', 404);
        return json({ deleted: true });
      }

      // 예약확정 메시지 붙여넣기 → AI 파싱 + 기존 가예약 기록 자동 매칭 (저장은 아직 안 함, 검토용)
      if (pathname === '/api/bookings/parse-message' && method === 'POST') {
        const { text } = await request.json();
        const parsed = await parseBookingMessage(text);
        const bookings = await listBookings(env);
        const matched = findMatchingBooking(bookings, parsed.courseName, parsed.roundDate);
        return json({ parsed, matchedBookingId: matched ? matched.id : null, matchedBooking: matched });
      }

      // 매칭된 가예약 기록을 확정 처리 + 같은 그룹 나머지 항목 자동 "취소 검토 대상" 표시
      const confirmMatch = pathname.match(/^\/api\/bookings\/([^/]+)\/confirm$/);
      if (confirmMatch && method === 'POST') {
        const result = await confirmMatchedBooking(env, confirmMatch[1], await request.json());
        if (!result) return error('해당 예약 기록을 찾을 수 없습니다', 404);
        return json(result);
      }

      // ===== 티타임 워치(핵심 MVP) - 특정 골프장+날짜(+시간대)를 지정해두면 Cron이 30분마다
      // 백그라운드에서 재검색해서 결과를 KV에 저장. /refresh는 사용자가 앱에서 "지금 새로고침"을
      // 눌렀을 때 크론을 기다리지 않고 즉시 재검색하는 용도. =====
      if (pathname === '/api/watches' && method === 'GET') {
        return json({ watches: await listWatches(env) });
      }
      if (pathname === '/api/watches' && method === 'POST') {
        const record = await addWatch(env, await request.json());
        return json({ watch: record }, 201);
      }
      // MY골프장에서 여러 개를 골라 한 번에 워치 등록(레이스 컨디션 방지 위해 배치 1건으로 처리).
      if (pathname === '/api/watches/bulk' && method === 'POST') {
        const { items } = await request.json();
        if (!Array.isArray(items) || !items.length) return error('items 배열이 필요합니다', 400);
        const added = await bulkAddWatches(env, items);
        return json({ watches: added }, 201);
      }
      // 여러 워치를 한 번에 삭제("선택 삭제"/"전체 삭제") - DELETE 메서드는 바디 지원이 애매해서 POST로.
      if (pathname === '/api/watches/bulk-delete' && method === 'POST') {
        const { ids } = await request.json();
        if (!Array.isArray(ids) || !ids.length) return error('ids 배열이 필요합니다', 400);
        const deletedCount = await bulkDeleteWatches(env, ids);
        return json({ deletedCount });
      }
      const watchMatch = pathname.match(/^\/api\/watches\/([^/]+)$/);
      if (watchMatch && method === 'PUT') {
        const record = await updateWatch(env, watchMatch[1], await request.json());
        if (!record) return error('해당 모니터링을 찾을 수 없습니다', 404);
        return json({ watch: record });
      }
      if (watchMatch && method === 'DELETE') {
        const ok = await deleteWatch(env, watchMatch[1]);
        if (!ok) return error('해당 모니터링을 찾을 수 없습니다', 404);
        return json({ deleted: true });
      }
      const watchRefreshMatch = pathname.match(/^\/api\/watches\/([^/]+)\/refresh$/);
      if (watchRefreshMatch && method === 'POST') {
        // 사용자가 직접 누른 단발성 새로고침이라(크론 배치와 달리 서브리퀘스트 예산 여유가
        // 넉넉할) 골팡 검색을 페이지 1개만 보지 않고 최대 10페이지까지 훑어서 정확한 결과를
        // 준다 - 크론 자동 갱신(refreshAllWatches)은 여전히 페이지 1만 본다.
        const record = await refreshWatch(env, watchRefreshMatch[1], { maxGolfpangPages: 10 });
        if (!record) return error('해당 모니터링을 찾을 수 없습니다', 404);
        return json({ watch: record });
      }
      if (pathname === '/api/watches/refresh-all' && method === 'POST') {
        // 홈 탭 "🔄 전체 업데이트" 버튼 - 크론이 30분마다 돌리는 것과 똑같은 refreshAllWatches를
        // 그대로 재사용한다(활성 워치 최대 15개, 페이지 1개씩). 등록된 워치를 전부 개별
        // refreshWatch(최대 10페이지)로 돌리면 워치 수에 따라 서브리퀘스트 한도(무료 플랜 기준
        // 요청당 50개)를 쉽게 넘겨서 사용자가 누른 버튼이 그 자리에서 실패해버릴 수 있다 -
        // 크론에서 이미 안전하다고 검증된 값을 그대로 쓰는 쪽이 낫다.
        const refreshedCount = await refreshAllWatches(env);
        return json({ refreshedCount });
      }

      // ===== 골프장 가격 대시보드(D1) - 수집은 NAS(nas-collector/)가 하고, 여기는 저장 + 조회만 =====
      if (pathname === '/api/price-dashboard/ingest' && method === 'POST') {
        // 이 라우트만 시크릿으로 보호한다 - 나머지 API는 이 앱 전체와 마찬가지로 무인증(개인용
        // 단일 사용자 전제)이지만, ingest는 유일하게 대량 쓰기가 가능한 경로라 아무나 URL을 알면
        // 누적 데이터 전체를 오염시킬 수 있어 별도로 막는다.
        const secret = request.headers.get('X-Ingest-Secret');
        if (!env.PRICE_INGEST_SECRET || secret !== env.PRICE_INGEST_SECRET) {
          return error('인증 실패', 401);
        }
        const result = await ingestPriceSnapshot(env, await request.json());
        return json(result);
      }

      // ===== NAS 실시간 중계 URL 등록 (kakaogolf.js 참고) =====
      // NAS의 Cloudflare Quick Tunnel은 고정 도메인이 없어 cloudflared가 (재)시작될 때마다 URL이
      // 바뀐다 - tunnel_supervisor.py가 새 URL을 잡을 때마다 여기로 등록해서 KV에 최신 값을
      // 저장해두고, kakaogolf.js가 실시간 조회 때마다 이 값을 읽어 NAS로 중계한다. 대량 쓰기가
      // 가능한 건 아니지만(KV 한 칸만 덮어씀) ingest와 같은 시크릿으로 보호한다 - NAS -> Worker
      // 방향 호출은 전부 같은 신뢰 경계라 시크릿을 따로 늘리지 않는다.
      if (pathname === '/api/nas-relay/register' && method === 'POST') {
        const secret = request.headers.get('X-Ingest-Secret');
        if (!env.PRICE_INGEST_SECRET || secret !== env.PRICE_INGEST_SECRET) {
          return error('인증 실패', 401);
        }
        const { url: relayUrl } = await request.json();
        if (!relayUrl || !/^https:\/\//.test(relayUrl)) {
          return error('url(https://...)이 필요합니다');
        }
        await env.GOLF_KV.put('nasRelayUrl', JSON.stringify({ url: relayUrl, updatedAt: new Date().toISOString() }));
        return json({ registered: true });
      }
      if (pathname === '/api/price-dashboard/courses' && method === 'GET') {
        const region = url.searchParams.get('region') || undefined;
        return json({ courses: await listTrackedCourses(env, { region }) });
      }
      const priceHistoryMatch = pathname.match(/^\/api\/price-dashboard\/course\/([^/]+)\/history$/);
      if (priceHistoryMatch && method === 'GET') {
        const days = Number(url.searchParams.get('days')) || 90;
        return json({ history: await getCourseHistory(env, { courseName: decodeURIComponent(priceHistoryMatch[1]), days }) });
      }
      const priceWeekdayMatch = pathname.match(/^\/api\/price-dashboard\/course\/([^/]+)\/weekday$/);
      if (priceWeekdayMatch && method === 'GET') {
        return json({ weekday: await getWeekdayTrend(env, { courseName: decodeURIComponent(priceWeekdayMatch[1]) }) });
      }
      const priceLeadtimeMatch = pathname.match(/^\/api\/price-dashboard\/course\/([^/]+)\/leadtime$/);
      if (priceLeadtimeMatch && method === 'GET') {
        return json({ leadtime: await getLeadTimeTrend(env, { courseName: decodeURIComponent(priceLeadtimeMatch[1]) }) });
      }
      if (pathname === '/api/price-dashboard/lowest-today' && method === 'GET') {
        const region = url.searchParams.get('region') || undefined;
        const roundDate = url.searchParams.get('date') || undefined;
        return json(await getLowestToday(env, { region, roundDate }));
      }

      return error('Not found', 404);
    } catch (err) {
      return error(err.message || String(err), 500);
    }
  },

  // Cloudflare Cron Trigger(wrangler.toml [triggers] crons) - 30분마다 활성 워치를 전부 재검색.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshAllWatches(env));
  },
};
