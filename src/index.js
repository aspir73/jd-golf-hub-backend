import { fetchWeather, fetchMidTermWeather, fetchWeekAheadWeather } from './weather.js';
import { listScores, addScore, updateScore, deleteScore } from './scores.js';
import { computeStats } from './stats.js';
import { getSettings, updateSettings } from './settings.js';
import { listCourses, addCourse, updateCourse, deleteCourse, reorderCourses, bulkAddCourses } from './courses.js';
import { resolveWeekGreenFees } from './courseGreenFees.js';
import { listCompanions, addCompanion, updateCompanion, deleteCompanion } from './companions.js';
import { computeSettlement } from './settlement.js';
import { searchRestaurants, listFavoriteRestaurants, addFavoriteRestaurant, deleteFavoriteRestaurant } from './restaurants.js';
import { searchPlaces, kakaoMapDirectionsUrl, fetchDrivingRoute, searchHomepageCandidates } from './kakao.js';
import { searchGolfpangRoundsAllPages } from './golfpang.js';
import { searchGolfmonRounds } from './golfmon.js';
import { searchKakaoGolfRounds, fetchKakaoGolfTeeTimes } from './kakaogolf.js';
import { listGroups, addGroup, addCandidate, removeCandidate, deleteGroup, getGroup } from './comparisonGroups.js';
import { computeCandidateComponents } from './scoring.js';
import { listBookings, addBooking, updateBooking, deleteBooking, findMatchingBooking, confirmMatchedBooking } from './bookings.js';
import { parseBookingMessage } from './messageParsing.js';
import { listGolfCourseDB, listRegions, searchGolfCourseDB } from './golfCourseDB.js';
import { listWatches, addWatch, updateWatch, deleteWatch, refreshWatch, refreshAllWatches, bulkAddWatches, bulkDeleteWatches } from './watches.js';

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
        const source = url.searchParams.get('source') || undefined;
        const roundType = url.searchParams.get('roundType') || undefined;
        return json(computeStats(await listScores(env), { source, roundType }));
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
        const places = await searchPlaces(env, query);
        // 집 주소가 설정돼 있으면 각 검색결과까지의 자동차 거리/이동시간을 함께 내려준다
        // (골프장 즐겨찾기 추가 시 후보 비교용) - 실패해도 검색 자체는 막지 않는다.
        const settings = await getSettings(env);
        if (settings.homeLat != null && settings.homeLon != null) {
          await Promise.all(
            places.map(async (p) => {
              if (p.lat == null || p.lon == null) return;
              const route = await fetchDrivingRoute(env, settings.homeLat, settings.homeLon, p.lat, p.lon);
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
        // 넉넉함) 골팡 검색을 페이지 1개만 보지 않고 최대 10페이지까지 훑어서 정확한 결과를
        // 준다 - 크론 자동 갱신(refreshAllWatches)은 여전히 페이지 1만 본다.
        const record = await refreshWatch(env, watchRefreshMatch[1], { maxGolfpangPages: 10 });
        if (!record) return error('해당 모니터링을 찾을 수 없습니다', 404);
        return json({ watch: record });
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
