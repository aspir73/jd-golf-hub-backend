// 골프장 홈페이지 티타임 스냅샷. 대영베이스처럼 홈페이지 방화벽(WAF)이 Cloudflare Worker의 IP를 차단하는
// 곳은 Worker가 직접 읽지 못해서, NAS(nas-collector/basecc_collector.py)가 읽은 결과를 이 경로로 올려두고
// 주말 현황/모니터링은 이 스냅샷을 읽는다. 스냅샷은 항상 "가장 최근 수집 결과 전체"로 덮어쓴다.

const BASECC_KEY = 'teesnap:basecc';
const STALE_MS = 60 * 60 * 1000; // 이 시간보다 오래된 스냅샷은 화면에서 "갱신 지연"으로 알린다

const clean = (s, n = 40) => String(s ?? '').slice(0, n);
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

export async function saveBaseccSnapshot(env, payload) {
  const dates = payload?.dates;
  if (!dates || typeof dates !== 'object') throw new Error('dates 객체가 필요합니다');
  const out = {};
  for (const [date, v] of Object.entries(dates).slice(0, 45)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const rounds = (Array.isArray(v?.rounds) ? v.rounds : []).slice(0, 500).map((r) => ({
      time: clean(r.time, 5),
      courseSubName: clean(r.courseSubName, 10),
      caddy: clean(r.caddy, 40),
      caddyType: clean(r.caddyType, 10) || 'general',
      holes: num(r.holes) ?? 18,
      listPrice: num(r.listPrice),
      greenFee: num(r.greenFee),
      event: clean(r.event, 30),
    })).filter((r) => /^\d{1,2}:\d{2}$/.test(r.time));
    out[date] = { open: v?.open !== false, rounds };
  }
  const record = { fetchedAt: new Date().toISOString(), dates: out };
  await env.GOLF_KV.put(BASECC_KEY, JSON.stringify(record));
  return { dates: Object.keys(out).length, rounds: Object.values(out).reduce((s, d) => s + d.rounds.length, 0), fetchedAt: record.fetchedAt };
}

/** 해당 날짜의 대영베이스 티타임(스냅샷). 스냅샷이 없거나 그 날짜가 안 들어 있으면 rounds는 빈 배열. */
export async function getBaseccRounds(env, date) {
  const snap = await env.GOLF_KV.get(BASECC_KEY, 'json');
  if (!snap) return { rounds: [], open: false, fetchedAt: null, stale: true, missing: true };
  const day = snap.dates?.[date];
  const stale = Date.now() - new Date(snap.fetchedAt).getTime() > STALE_MS;
  const rounds = (day?.rounds || []).map((r) => ({
    ...r,
    source: '대영베이스', courseName: '대영베이스CC', officialName: '대영베이스cc', date,
  }));
  return { rounds, open: Boolean(day?.open), fetchedAt: snap.fetchedAt, stale, missing: false };
}
