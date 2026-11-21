// 카카오골프예약(kakao.golf) 비로그인 조회 프록시. `/api/auth/kakao/user`가 비로그인(guest) 상태에서도
// `/api/tee-time/search`가 정상 동작하는 것을 실제 네트워크 캡처(HAR)로 확인했다 (요청에 쿠키/인증 헤더 없음).
//
// 이 엔드포인트는 개별 티타임이 아니라 "골프장 단위 요약"(golfInfoSeq, 최저그린피, 매칭건수 등)을 반환하고
// 골프장명은 포함하지 않는다 — 골프장명·홀수는 /api/golf/view로, 개별 시간대는 /api/tee-time/detail로 따로
// 조회한다(아래 함수들 참고).
//
// filter(timeZone/visitorCnt/greenFee/events) 검증 참고 (2026-08): 처음엔 이 필드들을 바꿔도 "목록 개수"가
// 그대로라 필터가 안 먹는 줄 알았는데, 이건 잘못된 검증 방법이었다 — 실제로는 골프장이 목록에서 빠지는 게
// 아니라 각 golfInfoSeq 항목의 timeCnt/minGreenFeeDC 값 자체가 그 필터 기준으로 재계산되어 내려온다(매칭이
// 없으면 timeCnt:0, minGreenFeeDC:0). 그래서 실제 사용할 땐 timeCnt===0인 항목을 걸러내야 "필터링된 결과"
// 처럼 보인다. 실제 캡처(사용자 제공)로 timeZone 비트마스크(1/2/4/8)까지 확정 검증했고, visitorCnt·greenFee·
// events도 같은 방식으로 값이 실제로 달라지는 것을 직접 확인했다.

import { findBestMatch } from './golfCourseDB.js';

const KAKAOGOLF_BASE = 'https://www.kakao.golf';
// 카카오골프예약이 최근(2026-09) User-Agent 없는 요청을 403으로 막기 시작한 것으로 보여 추가함
// (골팡은 golfpang.js에서 이미 User-Agent를 보내고 있고 계속 정상 동작 - 이쪽만 빠져있었다).
// 실제 브라우저 UA와 최대한 가깝게 흉내내서 WAF의 봇 판정을 피한다.
const KAKAOGOLF_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// User-Agent를 추가한 뒤에도 완전히는 안 고쳐졌다 - 실제로 curl로 반복 호출해보니 완전히 동일한
// 요청(같은 헤더·바디)이 절반 가까이는 200, 절반은 403이 무작위로 나왔다(같은 골프장이 방금 성공했다가
// 바로 다음 요청에 실패하기도 함). 응답이 요청 내용과 무관하게 들쭉날쭉한 건 Cloudflare Workers의
// fetch()가 매번 다른 송신 IP를 쓰는데, 그중 일부가 카카오골프예약 WAF(CloudFront)의 차단
// 목록에 걸려있는 경우의 전형적인 패턴이다 - Worker 안에서는 어떤 IP로 나갈지 고를 방법이 없어서
// 근본적으로 막을 수는 없고, 403이면 재시도하는 것으로 우회한다(관측된 성공률 약 50%가 진짜
// 무작위라면 3번 재시도 시 실패 확률이 약 12%까지 떨어진다).
async function fetchKakaoGolfWithRetry(url, options, attempts = 2) {
  let lastRes;
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(url, options);
    if (res.ok) return res;
    lastRes = res;
    if (res.status !== 403) return res; // 403이 아니면 재시도로 해결될 문제가 아닐 가능성이 높음
  }
  return lastRes;
}

// ===== NAS 실시간 중계(근본 해결책) =====
// 재시도로도 403을 완전히 없앨 수는 없어서(Worker는 발신 IP를 못 고름), price_collector.py가
// 매일 새벽 카카오골프예약을 호출해도 12일+ 에러 0회였던 NAS(주거용 IP)를 실시간 조회에도
// 쓴다 - nas-collector/live_relay.py가 그 NAS에서 상시 구동되며 카카오골프예약 요청을 대신
// 보내준다. NAS <-> Worker는 Cloudflare Tunnel(Quick Tunnel - 고정 도메인이 없어 재시작마다
// URL이 바뀜)로 연결되고, 현재 URL은 NAS가 재시작 때마다 KV에 등록해둔다(POST
// /api/nas-relay/register, watches.js의 X-Ingest-Secret과 같은 패턴).
// NAS가 꺼져있거나 터널이 끊겨 있으면 여기서 조용히 null을 돌려주고, 호출부가 지금까지의
// 직접호출+재시도로 자동 대체한다(NAS 장애가 이 기능 전체를 막지 않도록).
const NAS_RELAY_KV_KEY = 'nasRelayUrl';

async function getNasRelayRecord(env) {
  try {
    return (await env.GOLF_KV.get(NAS_RELAY_KV_KEY, 'json')) || null;
  } catch {
    return null;
  }
}

const daysAgo = (iso) => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : null);

/** NAS 중계 상태 진단(GET /api/kakaogolf/status 와 오류 메시지에서 공통 사용). */
export async function checkNasRelay(env) {
  if (!env.NAS_RELAY_SECRET) return { state: 'no_secret', message: 'NAS_RELAY_SECRET이 설정되지 않았어요' };
  const record = await getNasRelayRecord(env);
  if (!record?.url) return { state: 'not_registered', message: 'NAS 중계 주소가 아직 등록되지 않았어요' };
  const age = daysAgo(record.updatedAt);
  const started = Date.now();
  try {
    const res = await fetch(`${record.url}/healthz`, { signal: AbortSignal.timeout(6000) });
    if (res.ok) return { state: 'ok', url: record.url, updatedAt: record.updatedAt, ageDays: age, ms: Date.now() - started };
    return { state: 'unreachable', url: record.url, updatedAt: record.updatedAt, ageDays: age, message: `NAS 중계가 응답하지 않아요 (HTTP ${res.status}) - 마지막 등록 ${age}일 전` };
  } catch {
    return { state: 'unreachable', url: record.url, updatedAt: record.updatedAt, ageDays: age, message: `NAS 중계에 연결할 수 없어요 - 마지막 등록 ${age}일 전. NAS의 중계 스택(run_live_relay_stack.py)이 꺼져 있는지 확인해주세요` };
  }
}

/** 성공하면 { ok:true, data }, 실패하면 { ok:false, reason } - reason은 사용자에게 보여줄 진단 문구. */
async function callViaNasRelay(env, { path, body, referer }) {
  if (!env.NAS_RELAY_SECRET) return { ok: false, reason: 'NAS 중계가 설정되지 않았어요' };
  const record = await getNasRelayRecord(env);
  if (!record?.url) return { ok: false, reason: 'NAS 중계 주소가 등록되지 않았어요' };
  try {
    const res = await fetch(`${record.url}/kakaogolf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Relay-Secret': env.NAS_RELAY_SECRET },
      body: JSON.stringify({ path, body, referer }),
      signal: AbortSignal.timeout(12000), // 터널이 죽어있으면 무한 대기하지 않고 곧장 직접호출로 넘어감
    });
    if (res.status === 403) return { ok: false, blocked: true, reason: 'NAS 접속도 일시 차단됨' };
    if (!res.ok) return { ok: false, reason: `NAS 중계 응답 오류(HTTP ${res.status})` };
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: false, reason: `NAS 중계에 연결할 수 없어요(마지막 등록 ${daysAgo(record.updatedAt)}일 전)` };
  }
}

/** 카카오골프예약 POST 요청 공용 진입점 - NAS 중계를 먼저 시도하고, 안 되면(NAS 꺼짐/터널
 * 끊김/미설정) Worker에서 직접 호출+403 재시도로 대체한다. path는 "/api/tee-time/search" 등
 * 카카오골프예약 쪽 경로, referer는 실제 브라우저가 그 요청을 보낼 때의 페이지 URL이다. */
// 새로고침을 연달아 누르거나 워치·주말 현황이 같은 검색을 반복해도 카카오골프예약(NAS IP 차단 위험)에 같은 요청을
// 다시 보내지 않도록, 검색/상세 응답은 3분간 KV에 잠깐 보관한다(티타임은 몇 분 단위로 바뀌는 정보라 충분히 짧다).
const KAKAO_CACHE_PATHS = new Set(['/api/tee-time/search', '/api/tee-time/detail']);
const KAKAO_CACHE_TTL_SEC = 180;
const kakaoCacheKey = (path, body) => {
  const str = path + JSON.stringify(body);
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return `kakaogolf:resp:${h.toString(36)}`;
};

async function kakaoGolfRequest(env, args) {
  const cacheable = KAKAO_CACHE_PATHS.has(args.path);
  const key = cacheable ? kakaoCacheKey(args.path, args.body) : null;
  if (cacheable) {
    try {
      const hit = await env.GOLF_KV.get(key, 'json');
      if (hit) return hit;
    } catch { /* 캐시를 못 읽어도 정상 조회 */ }
  }
  const data = await kakaoGolfRequestUncached(env, args);
  if (cacheable) {
    try { await env.GOLF_KV.put(key, JSON.stringify(data), { expirationTtl: KAKAO_CACHE_TTL_SEC }); } catch { /* 무시 */ }
  }
  return data;
}

async function kakaoGolfRequestUncached(env, { path, body, referer }) {
  const relay = await callViaNasRelay(env, { path, body, referer });
  if (relay.blocked) {
    // NAS 중계는 살아있는데 카카오골프예약이 NAS 접속을 막은 경우(보통 짧은 시간에 요청이 몰렸을 때의 일시 차단).
    // Worker 직접 호출은 어차피 막혀 있어서 재시도하지 않고 바로 안내한다.
    throw new Error('카카오골프예약이 NAS 접속을 일시 차단했어요(짧은 시간에 요청이 많으면 생겨요). 몇 분 뒤 다시 시도해주세요 (HTTP 403)');
  }
  const data =
    (relay.ok ? relay.data : null) ||
    (await (async () => {
      const res = await fetchKakaoGolfWithRetry(`${KAKAOGOLF_BASE}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: KAKAOGOLF_BASE,
          Referer: referer,
          'User-Agent': KAKAOGOLF_USER_AGENT,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        // 403이면 클라우드 서버 IP가 막힌 것 - 원인(NAS 중계 상태)을 같이 알려서 바로 조치할 수 있게 한다.
        const hint = res.status === 403 ? ` (클라우드 서버 접속이 차단됨 · ${relay.reason})` : '';
        throw new Error(`카카오골프예약 조회 실패: HTTP ${res.status}${hint}`);
      }
      return res.json();
    })());
  if (data.resultCode !== 200) throw new Error(`카카오골프예약 응답 오류: ${data.resultMsg || '알 수 없는 오류'}`);
  return data;
}

// 대권역. 실제 /api/location/area 응답(POST, body {appVersion:"0"})으로 전수 확인.
export const REGIONS = [
  { code: '', label: '전체' },
  { code: '1', label: '서울/경기' },
  { code: '12', label: '강원' },
  { code: '22', label: '충청' },
  { code: '31', label: '경상' },
  { code: '41', label: '전라' },
  { code: '46', label: '제주' },
];

// 세부권역. /api/location/area 응답에서 status:"0"(활성)인 항목만 추림 — status:"1"인 비활성 항목
// (강원 강릉권·양양권, 충청 서산권, 경상 상주권 등)은 제외했고, 사용자가 실제 사이트에서 확인한 목록과
// 정확히 일치한다.
export const SUB_REGIONS = [
  { code: 3, majorCode: 1, label: '가평권' },
  { code: 6, majorCode: 1, label: '남양주권' },
  { code: 10, majorCode: 1, label: '수원권' },
  { code: 9, majorCode: 1, label: '안성권' },
  { code: 11, majorCode: 1, label: '여주권' },
  { code: 8, majorCode: 1, label: '용인권' },
  { code: 7, majorCode: 1, label: '인천권' },
  { code: 4, majorCode: 1, label: '파주권' },
  { code: 5, majorCode: 1, label: '포천권' },
  { code: 19, majorCode: 12, label: '동해권' },
  { code: 18, majorCode: 12, label: '속초권' },
  { code: 15, majorCode: 12, label: '원주권' },
  { code: 14, majorCode: 12, label: '춘천권' },
  { code: 20, majorCode: 12, label: '평창권' },
  { code: 28, majorCode: 22, label: '대전권' },
  { code: 27, majorCode: 22, label: '부여권' },
  { code: 29, majorCode: 22, label: '진천권' },
  { code: 26, majorCode: 22, label: '천안권' },
  { code: 30, majorCode: 22, label: '충주권' },
  { code: 24, majorCode: 22, label: '태안권' },
  { code: 35, majorCode: 31, label: '경주권' },
  { code: 39, majorCode: 31, label: '남해권' },
  { code: 33, majorCode: 31, label: '대구권' },
  { code: 36, majorCode: 31, label: '부산권' },
  { code: 38, majorCode: 31, label: '안동권' },
  { code: 37, majorCode: 31, label: '양산권' },
  { code: 45, majorCode: 41, label: '광주권' },
  { code: 43, majorCode: 41, label: '순천권' },
  { code: 44, majorCode: 41, label: '전주권' },
  { code: 48, majorCode: 46, label: '제주권' },
];

// 티타임대. 프론트엔드 번들(CugUv3Fp.js)에 하드코딩된 값 그대로 — 비트마스크(복수선택 시 합산).
export const TIME_ZONES = [
  { value: 1, label: '새벽(5~7시)' },
  { value: 2, label: '오전(7~12시)' },
  { value: 4, label: '오후(12~4시)' },
  { value: 8, label: '야간(4~9시)' },
];

// 내장인원수(최소 인원 조건). 단일 선택.
export const VISITOR_COUNTS = [
  { value: 2, label: '2인 이상' },
  { value: 3, label: '3인 이상' },
  { value: 4, label: '4인 필수' },
];

// 이벤트. 복수선택 가능(값 합산). value:5(노캐디)는 캐디유무 배지에도 재사용한다.
export const EVENTS = [
  { value: 1, label: '식음료지원' },
  { value: 2, label: '특가' },
  { value: 3, label: '특별이벤트' },
  { value: 4, label: '인터넷회원가입' },
  { value: 5, label: '노캐디' },
  { value: 6, label: '1인 그린피 면제' },
];

// 그린피 구간. 비트마스크(복수선택 시 합산).
export const GREEN_FEE_RANGES = [
  { value: 1, label: '~9만원' },
  { value: 2, label: '9~15만원' },
  { value: 4, label: '15~20만원' },
  { value: 8, label: '20만원~' },
  { value: 16, label: '홈페이지참조' },
];

function areaLabel(code) {
  const major = REGIONS.find((r) => r.code === String(code));
  if (major) return major.label;
  const sub = SUB_REGIONS.find((r) => r.code === Number(code));
  return sub?.label || '';
}

// 검색 요청은 세부지역 코드(가평권 등)로 좁혀도, 결과 카드의 "지역"은 세부지역이 아니라 대권역(서울/경기 등)
// 으로 보여준다 — 세부지역 코드는 SUB_REGIONS의 majorCode로 대권역을 역참조한다.
function majorAreaLabel(code) {
  const major = REGIONS.find((r) => r.code === String(code));
  if (major) return major.label;
  const sub = SUB_REGIONS.find((r) => r.code === Number(code));
  if (!sub) return '';
  return REGIONS.find((r) => r.code === String(sub.majorCode))?.label || '';
}

// 골프장 상세(이름/주소/홀수 등) 조회. 실제 캡처로 확인: POST /api/golf/view, body {golfInfoSeq}.
// 이름은 사실상 바뀌지 않으므로 KV에 영구 캐싱해 같은 골프장은 검색할 때마다 다시 부르지 않는다.
function golfInfoKey(golfInfoSeq) {
  return `kakaogolf:golfinfo:${golfInfoSeq}`;
}

async function fetchGolfInfo(env, golfInfoSeq) {
  const data = await kakaoGolfRequest(env, {
    path: '/api/golf/view',
    body: { golfInfoSeq },
    referer: `${KAKAOGOLF_BASE}/golf/${golfInfoSeq}`,
  });
  return {
    name: data.fullName || '',
    holeCount: data.holeCount || '',
    address: data.addressGibun || '',
  };
}

/** 여러 golfInfoSeq의 골프장 이름을 해석한다. KV 캐시를 먼저 보고, 없는 것만 /api/golf/view로 조회해서 캐싱한다.
 * 검색 한 번에 수십 개를 한꺼번에 쏘면 카카오골프예약이 NAS 접속을 일시 차단(403)하는 게 확인돼서,
 * 동시 3개로 제한하고 한 번에 새로 조회하는 개수도 상한을 둔다(남은 건 다음 검색 때 이어서 채워짐 -
 * 이름은 영구 캐시라 몇 번 검색하면 전부 채워진다). 차단 신호가 오면 남은 조회는 바로 멈춘다.
 * 개별 실패는 무시(플레이스홀더 유지). */
const MAX_NEW_GOLFINFO_PER_SEARCH = 16;
const GOLFINFO_CONCURRENCY = 3;

async function resolveGolfInfoMap(env, golfInfoSeqs) {
  const uniqueSeqs = [...new Set(golfInfoSeqs)];
  const map = {};
  const missing = [];
  await Promise.all(
    uniqueSeqs.map(async (seq) => {
      try {
        const cached = await env.GOLF_KV.get(golfInfoKey(seq), 'json');
        if (cached) map[seq] = cached;
        else missing.push(seq);
      } catch {
        missing.push(seq);
      }
    })
  );

  const queue = missing.slice(0, MAX_NEW_GOLFINFO_PER_SEARCH);
  let stop = false;
  async function worker() {
    while (queue.length && !stop) {
      const seq = queue.shift();
      try {
        const info = await fetchGolfInfo(env, seq);
        map[seq] = info;
        await env.GOLF_KV.put(golfInfoKey(seq), JSON.stringify(info));
      } catch (e) {
        if (/일시 차단|HTTP 403/.test(e.message || '')) stop = true; // 차단 중이면 더 두드리지 않는다
      }
    }
  }
  await Promise.all(Array.from({ length: GOLFINFO_CONCURRENCY }, worker));
  return map;
}

/** 골프장 하나의 실제 예약 가능 티타임 목록 조회. 실제 캡처로 확인: POST /api/tee-time/detail,
 * body {golfSeq, date, sigunguSeq, weekType, reservFlag, filter}. 검색 결과에는 골프장 단위 요약만 오고
 * 개별 시간대(bookTime)·인원(visitorCnt/maxVisitorCnt)은 이 엔드포인트에서만 나온다.
 * 검색 결과(최대 100여 건) 전체에 대해 자동으로 호출하면 Cloudflare Worker 서브리퀘스트 한도(무료 플랜
 * 기준 요청당 50개)를 넘길 수 있어, 사용자가 특정 골프장을 선택했을 때만 개별 호출하는 용도로 둔다. */
export async function fetchKakaoGolfTeeTimes(env, { golfInfoSeq, date, timeZone = 0, visitorCnt = 0 }) {
  if (!golfInfoSeq) throw new Error('golfInfoSeq가 필요합니다');
  if (!date) throw new Error('date(YYYY-MM-DD)가 필요합니다');
  const compactDate = date.replace(/-/g, '');

  const body = {
    golfSeq: Number(golfInfoSeq),
    date: compactDate,
    // 검색과 동일하게 형식적 게이트일 뿐 실제 지역 필터로 작동하지 않는 것을 확인함(sigunguSeq 값과
    // 무관하게 동일 결과) — 고정 placeholder 사용.
    sigunguSeq: 1,
    weekType: 0,
    reservFlag: 'N',
    filter: {
      greenFee: 0,
      greenFeeList: [0],
      timeZone,
      timeZoneList: timeZone ? [0, timeZone] : [0],
      orderForGolfClubListMode: 0,
      orderForTeeTimeListMode: 0,
      timeZoneDisable: 0,
      greenFeeDisable: 0,
      paymentMethodDisable: 0,
      visitorCntDisable: 0,
      eventEnable: false,
      paymentMethodFlag: 0,
      paymentMethodList: [],
      visitorCntFlag: visitorCnt ? 3 : 0,
      visitorCnts: visitorCnt ? [visitorCnt] : [],
      holeCnt: 0,
      holeCntFlag: 0,
      holeCntList: [],
      event: 0,
      events: [],
      isOnlyAvailableTeeTime: false,
      isOnlyCashBackTeeTime: false,
      isOnlyLowGuarantee: false,
      paymentMethod: '',
      visitorCnt,
    },
  };

  const data = await kakaoGolfRequest(env, {
    path: '/api/tee-time/detail',
    body,
    referer: `${KAKAOGOLF_BASE}/tee-time?date=${compactDate}&area=1&timeZone=${timeZone}`,
  });

  return (data.list || []).map((item) => ({
    time: item.bookTime ? `${item.bookTime.slice(0, 2)}:${item.bookTime.slice(2)}` : '',
    courseSubName: item.CourseName || '',
    holes: item.holeCntName || (item.holeCnt ? `${item.holeCnt}홀` : ''),
    greenFee: item.greenFeeDC ?? null,
    visitorCnt: item.visitorCnt ?? null,
    maxVisitorCnt: item.maxVisitorCnt ?? null,
    cashback: item.cashbackYN === 'Y',
  }));
}

export async function searchKakaoGolfRounds(
  env,
  { date, areas = [], timeZones = [], visitorCnt = 0, events = [], greenFees = [], holeCnt = 0 }
) {
  if (!date) throw new Error('date(YYYY-MM-DD)가 필요합니다');
  const compactDate = date.replace(/-/g, '');
  const areas1s = areas.length ? areas.map(Number) : [1];
  const title = areas1s.map(areaLabel).filter(Boolean).join(', ') || '전체';
  // 카드에 표시할 지역은 세부지역이 아니라 대권역으로 (예: "가평권"으로 좁혀 검색해도 "서울/경기"로 표시)
  const regionDisplay = [...new Set(areas1s.map(majorAreaLabel).filter(Boolean))].join(', ') || '전체';

  function buildBody(eventsForRequest) {
    return {
      date: compactDate,
      qfSeq: '0',
      searchType: 2,
      lowGuarantee: 'N',
      selectedDates: null,
      flagCashBack: 'N',
      quickFilterTypeHistory: null,
      weekType: '1',
      areas1s,
      enterType: 'MAIN_AREA',
      searchSeq: '1',
      reservFlag: 'N',
      title,
      listType: '0',
      detailAreaText: '',
      filter: {
        greenFee: greenFees.reduce((a, b) => a + b, 0),
        greenFeeList: greenFees.length ? [0, ...greenFees] : [0],
        timeZone: timeZones.reduce((a, b) => a + b, 0),
        timeZoneList: timeZones.length ? [0, ...timeZones] : [0],
        orderForGolfClubListMode: 0,
        orderForTeeTimeListMode: 0,
        timeZoneDisable: 0,
        greenFeeDisable: 0,
        paymentMethodDisable: 0,
        visitorCntDisable: 0,
        eventEnable: eventsForRequest.length > 0,
        paymentMethodFlag: 0,
        paymentMethodList: [],
        visitorCntFlag: visitorCnt ? 3 : 0,
        visitorCnts: visitorCnt ? [visitorCnt] : [],
        holeCnt,
        holeCntFlag: 0,
        holeCntList: [],
        event: eventsForRequest.reduce((a, b) => a + b, 0),
        events: eventsForRequest,
        isOnlyAvailableTeeTime: false,
        isOnlyCashBackTeeTime: false,
        isOnlyLowGuarantee: false,
        paymentMethod: '',
        visitorCnt,
      },
      isOnlyCashBackCondition: 'false',
      golfinfos: [],
      searchName: title,
      areas2: [0],
      // 실제 캡처로 확인: sigunguSeq는 특정 시/군/구를 걸러내는 필터가 아니라 "0이 아닌 값이 있는지"만 보는
      // 형식적 게이트다 (빈 문자열/"0"이면 list가 항상 비어서 옴, "459"든 "1"이든 같은 결과 개수가 나옴).
      // 실제 시/군/구 코드를 모르므로 결과에 영향 없는 placeholder를 고정으로 보낸다.
      sigunguSeq: '1',
    };
  }

  async function runSearch(eventsForRequest) {
    const data = await kakaoGolfRequest(env, {
      path: '/api/tee-time/search',
      body: buildBody(eventsForRequest),
      referer: `${KAKAOGOLF_BASE}/tee-time?area=${areas1s.join(',')}&date=${compactDate}`,
    });
    // 필터에 안 맞는 골프장도 목록엔 그대로 남고 timeCnt(매칭건수)만 0으로 내려온다 — 걸러낸다.
    return (data.list || []).filter((item) => (item.timeCnt || 0) > 0);
  }

  // 캐디유무 배지: 사용자가 이미 "노캐디" 이벤트를 필터로 선택했으면 결과 전체가 노캐디이므로 별도 조회가
  // 필요 없다. 아니라면 같은 조건 + 노캐디(5)만 추가한 조회를 한 번 더 해서 교차한다.
  const alreadyNoCaddieOnly = events.includes(5);
  const [list, noCaddieList] = await Promise.all([
    runSearch(events),
    alreadyNoCaddieOnly ? Promise.resolve(null) : runSearch([...events, 5]),
  ]);
  const noCaddieSeqs = alreadyNoCaddieOnly
    ? new Set(list.map((item) => item.golfInfoSeq))
    : new Set(noCaddieList.map((item) => item.golfInfoSeq));

  const golfInfoMap = await resolveGolfInfoMap(
    env,
    list.map((item) => item.golfInfoSeq)
  );

  const rounds = list.map((item) => {
    const info = golfInfoMap[item.golfInfoSeq];
    return {
      idx: String(item.golfInfoSeq),
      region: regionDisplay,
      officialName: (info?.name && findBestMatch(info.name)?.name) || null,
      date,
      time: '',
      courseName: info?.name || `골프장 #${item.golfInfoSeq}`,
      holes: info?.holeCount ? `${info.holeCount}홀` : '',
      greenFee: item.minGreenFeeDC ?? item.minGreenFeeNO ?? null,
      nickname: '',
      caddyType: noCaddieSeqs.has(item.golfInfoSeq) ? '노캐디 가능' : '',
      category: `매칭 ${item.timeCnt ?? 0}건 · 평점 ${item.avgStarScore ?? '-'}`,
      matchCount: item.timeCnt ?? 0,
      contactPhone: '',
      distanceKm: item.totalDistance != null ? Math.round(item.totalDistance / 100) / 10 : null,
      views: null,
    };
  });

  return { mode: 'join', totalCount: rounds.length, rounds };
}
