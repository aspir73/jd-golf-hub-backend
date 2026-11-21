// 전국 골프장 코스·홀 DB(D1 gc_* 테이블, data/*.csv → scripts/build_golf_course_db_sql.py로 적재).
// 487개 골프장 / 1,158개 코스(9홀 루프) / 10,421홀의 파·핸디캡·티별 거리를 담고 있어서, 사용자가 직접
// 입력한 코스정보(courseInfo.js의 KV)가 없는 골프장도 라운드 시작·예약 코스 칩·코스핸디 계산에 쓸 수 있게
// courseInfo와 같은 모양({courseName, subCourses:[{name, holes:[{no, par, ...}]}]})으로 돌려준다.

import { normalizeCourseName } from './golfCourseDB.js';

const CLUB_INDEX_TTL_MS = 10 * 60 * 1000;
let clubIndexCache = null; // { at, clubs: [{ clubId, name, aliases: [정규화 이름] }] }

// 흔한 표기 흔들림(베어크릭/베어크리크)을 한쪽으로 맞춘다 - 골프장명 비교 전에 양쪽 다 적용.
const canon = (s) => normalizeCourseName(s).toLowerCase().replace(/크릭/g, '크리크');

/** 한 골프장의 검색용 이름들: 정식 명칭, 요청명, 정식 명칭 괄호 안 별칭("(구 아일랜드CC, 더헤븐 리조트)"),
 * 문체부 등록명(" / "로 여러 개 - 회원제/대중제가 따로 등록된 경우). 전부 canon으로 정규화. */
function clubAliases(row) {
  const raw = [row.official_name, row.request_name];
  for (const m of (row.official_name || '').matchAll(/\(([^)]*)\)/g)) {
    raw.push(...m[1].split(',').map((s) => s.trim().replace(/^구\s*/, '')));
  }
  raw.push(...(row.mcst_registered_names || '').split(' / '));
  const set = new Set();
  for (const r of raw) {
    const n = canon(r);
    if (n.length >= 2) set.add(n);
  }
  return [...set];
}

async function loadClubIndex(env) {
  if (clubIndexCache && Date.now() - clubIndexCache.at < CLUB_INDEX_TTL_MS) return clubIndexCache.clubs;
  const { results } = await env.PRICE_DB.prepare(
    'SELECT club_id, official_name, request_name, mcst_registered_names, city, address FROM gc_clubs'
  ).all();
  const clubs = results.map((r) => {
    const aliases = clubAliases(r);
    // 지역 힌트("춘천 베어크릭", "마이다스(이천)")를 맞춰볼 문자열: 별칭 + 시군 + 주소
    const hay = [...aliases, canon(r.city), canon(r.address)].join('|');
    return { clubId: r.club_id, name: r.official_name, aliases, hay };
  });
  clubIndexCache = { at: Date.now(), clubs };
  return clubs;
}

/** 골프장명 → club_id.
 * 1) 정규화 이름이 별칭과 정확히 같으면 그 골프장.
 * 2) 이름을 단어로 쪼개(공백·괄호 기준, "춘천 베어크릭" → 춘천/베어크리크) 3글자 이상 단어가 별칭에 들어 있는
 *    골프장들 중, 단어가 별칭·시군·주소에 가장 많이 맞는 골프장이 하나뿐이면 그 골프장.
 * 3) 한쪽 이름이 다른 쪽을 포함하는 경우 가장 길게 맞은 골프장 하나(동률이면 오매칭 위험이 있어 포기). */
export async function findClubId(env, courseName) {
  const target = canon(courseName);
  if (target.length < 2) return null;
  const clubs = await loadClubIndex(env);
  const exact = clubs.find((c) => c.aliases.includes(target));
  if (exact) return exact.clubId;

  const tokens = [...new Set((courseName || '').split(/[\s()·,/]+/).map(canon).filter((t) => t.length >= 2))];
  if (tokens.length > 1) {
    let top = [];
    let topScore = 0;
    for (const c of clubs) {
      if (!tokens.some((t) => t.length >= 3 && c.aliases.some((a) => a.includes(t)))) continue;
      const score = tokens.filter((t) => c.hay.includes(t)).length;
      if (score > topScore) { top = [c]; topScore = score; }
      else if (score === topScore) top.push(c);
    }
    if (top.length === 1 && topScore >= 2) return top[0].clubId;
  }

  let best = null;
  let bestLen = 0;
  let tie = false;
  for (const c of clubs) {
    for (const a of c.aliases) {
      if (a.length < 3 || !(target.includes(a) || a.includes(target))) continue;
      const len = Math.min(a.length, target.length);
      if (len > bestLen) { best = c; bestLen = len; tie = false; }
      else if (len === bestLen && best && best.clubId !== c.clubId) tie = true;
    }
  }
  return best && !tie && bestLen >= 3 ? best.clubId : null;
}

/** "OUT (1~9번)" → "OUT", "아웃(OUT, 1~9번)" → "아웃", "레이크(LAKE)" → "레이크"(별칭 LAKE). */
function cleanSubCourseName(raw, seq) {
  const s = (raw || '').trim();
  const aliases = [];
  for (const m of s.matchAll(/\(([^)]*)\)/g)) {
    for (const part of m[1].split(',').map((p) => p.trim())) {
      if (part && !/\d/.test(part)) aliases.push(part);
    }
  }
  const name = s.replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  return { name: name || aliases.shift() || `코스${seq}`, aliases };
}

const isWhite = (t) => t.tee_group === '화이트' && t.ladies !== 'Y';

/** club_id 하나의 코스·홀·티 데이터를 courseInfo 모양으로 조립한다. */
export async function getCourseHoleDbByClubId(env, clubId) {
  const [club, courses, holes, tees, courseTees, notes] = await env.PRICE_DB.batch([
    env.PRICE_DB.prepare('SELECT * FROM gc_clubs WHERE club_id = ?').bind(clubId),
    env.PRICE_DB.prepare('SELECT * FROM gc_courses WHERE club_id = ? ORDER BY course_seq').bind(clubId),
    env.PRICE_DB.prepare('SELECT * FROM gc_holes WHERE club_id = ? ORDER BY course_id, hole_no').bind(clubId),
    env.PRICE_DB.prepare('SELECT course_id, hole_no, tee_seq, tee_name, tee_group, ladies, length_m FROM gc_hole_tees WHERE club_id = ? ORDER BY tee_seq').bind(clubId),
    env.PRICE_DB.prepare('SELECT * FROM gc_course_tees WHERE club_id = ? ORDER BY tee_seq').bind(clubId),
    env.PRICE_DB.prepare('SELECT * FROM gc_course_notes WHERE club_id = ?').bind(clubId),
  ]);
  const c = club.results[0];
  if (!c) return null;
  // 코스별 설명은 표기가 조금씩 달라서("OUT (1~9번)" vs "OUT(1~9번)", "동코스" vs "동") 공백·'코스'를 무시하고 맞춘다.
  const noteKey = (s) => (s || '').replace(/\s+/g, '').replace(/코스/g, '').toLowerCase();
  const noteKeyBare = (s) => noteKey((s || '').replace(/\(.*?\)/g, ''));
  const noteFor = (rawName) => notes.results.find((n) => noteKey(n.course_name) === noteKey(rawName))
    || notes.results.find((n) => noteKeyBare(n.course_name) && noteKeyBare(n.course_name) === noteKeyBare(rawName)) || null;

  const teeLen = new Map(); // `${course_id}|${hole_no}` → [{seq, name, m, white}]
  for (const t of tees.results) {
    const k = `${t.course_id}|${t.hole_no}`;
    if (!teeLen.has(k)) teeLen.set(k, []);
    teeLen.get(k).push(t);
  }

  const subCourses = courses.results.map((co) => {
    const { name, aliases } = cleanSubCourseName(co.course_name, co.course_seq);
    const coTees = courseTees.results.filter((t) => t.course_id === co.course_id).map((t) => ({
      seq: t.tee_seq,
      name: t.tee_name,
      group: t.tee_group,
      ladies: t.ladies === 'Y',
      totalM: t.total_length_m,
    }));
    const coHoles = holes.results.filter((h) => h.course_id === co.course_id).map((h) => {
      const hTees = teeLen.get(`${co.course_id}|${h.hole_no}`) || [];
      const white = hTees.find(isWhite);
      const lengths = {};
      for (const t of hTees) if (t.length_m != null) lengths[t.tee_seq] = t.length_m;
      return {
        no: h.hole_no,
        par: [3, 4, 5, 6].includes(h.par) ? h.par : 4,
        parKnown: h.par != null,
        handicap: h.handicap,
        // 스코어카드 티 표의 화이트 → 홀별 표준 화이트 열(white_tee_m) → 기준 티가 화이트면 그 거리 순.
        whiteM: white?.length_m ?? h.white_tee_m ?? (/^화이트/.test(h.base_tee || '') ? h.base_tee_length_m : null),
        // 홀별 표준 4개 티 거리(m) - 스코어카드 티 표에 해당 색 티가 없을 때 프론트가 대신 쓴다.
        stdM: { white: h.white_tee_m, red: h.red_tee_m, blue: h.blue_tee_m, black: h.black_tee_m },
        // 화이트가 없는 골프장(블루만 있는 경우 등)도 거리를 보여줄 수 있게 원본의 기준 티와 그 거리.
        baseTee: h.base_tee ? h.base_tee.replace(/\(.*\)/, '').trim() : null,
        baseM: h.base_tee_length_m,
        lengths,
      };
    });
    const note = noteFor(co.course_name);
    return {
      id: co.course_id, name, aliases, rawName: co.course_name, holes: coHoles, tees: coTees, dataStatus: co.data_status,
      note: note ? { description: note.description || '', lengthText: note.length_text || '' } : null,
    };
  }).filter((sc) => sc.holes.length);

  // 괄호를 떼면 이름이 겹치는 경우(베어크리크 "베어(좌그린) OUT" / "베어(우그린) OUT")엔 괄호 내용을 뒤에 붙여 구분한다.
  const counts = subCourses.reduce((m, sc) => m.set(sc.name, (m.get(sc.name) || 0) + 1), new Map());
  for (const sc of subCourses) {
    if (counts.get(sc.name) > 1 && sc.aliases.length) sc.name = `${sc.name} (${sc.aliases.join(', ')})`;
  }

  return {
    id: `db:${c.club_id}`,
    source: 'db',
    clubId: c.club_id,
    courseName: c.official_name,
    region: c.region,
    city: c.city,
    address: c.address,
    homepageUrl: c.homepage_url,
    dataStatus: c.data_status,
    // 골프장 보기 화면(소개 카드)용 - migrations/0008 이후 채워짐
    club: {
      requestName: c.request_name || '',
      officialName: c.official_name || '',
      region: c.region || '',
      city: c.city || '',
      address: c.address || '',
      phone: c.phone || '',
      operationType: c.operation_type || '',
      totalHoles: c.total_holes ?? null,
      totalPar: c.total_par ?? null,
      courseLayout: c.course_layout || '',
      totalLengthText: c.total_length_text || '',
      caddieCart: c.caddie_cart || '',
      features: c.features || '',
      remarks: c.remarks || '',
      mainSources: c.main_sources || '',
      operator: c.operator || '',
      homepageUrl: c.homepage_url || '',
    },
    subCourses,
    ratings: [],
  };
}

export async function getCourseHoleDbByName(env, courseName) {
  if (!env.PRICE_DB) return null;
  try {
    const clubId = await findClubId(env, courseName);
    return clubId ? await getCourseHoleDbByClubId(env, clubId) : null;
  } catch (err) {
    console.error('courseHoleDb 조회 실패', err);
    return null;
  }
}

const SUB_EN_KO = { lake: '레이크', valley: '밸리', mountain: '마운틴', hill: '힐', pine: '파인', east: '동', west: '서', south: '남', north: '북', out: '아웃', in: '인' };
function subKey(s) {
  const t = (s || '').replace(/\([^)]*\)/g, '').trim().replace(/코스$/, '').toLowerCase();
  const ko = SUB_EN_KO[t] || t;
  return ({ 이스트: '동', 웨스트: '서', 사우스: '남', 노스: '북' })[ko] || ko;
}

/** 사용자가 직접 입력한 KV 코스정보에 DB의 홀별 화이트 거리·핸디캡을 채워 넣는다(값이 이미 있으면 유지).
 * 서브코스 이름이 맞는 것끼리만(LAKE = 레이크 = Lake), 홀 번호 기준으로 붙인다. 파는 사용자 입력을 그대로 둔다. */
export function enrichWithHoleDb(info, dbInfo) {
  if (!info || !dbInfo) return info;
  const subCourses = info.subCourses.map((sc) => {
    const key = subKey(sc.name);
    const match = dbInfo.subCourses.find((d) => subKey(d.name) === key || d.aliases.some((a) => subKey(a) === key));
    if (!match) return sc;
    return {
      ...sc,
      tees: sc.tees || match.tees,
      holes: sc.holes.map((h) => {
        const d = match.holes.find((x) => x.no === h.no);
        if (!d) return h;
        return {
          ...h,
          whiteM: h.whiteM ?? d.whiteM,
          handicap: h.handicap ?? d.handicap,
          baseTee: h.baseTee ?? d.baseTee,
          baseM: h.baseM ?? d.baseM,
          stdM: h.stdM || d.stdM,
          lengths: h.lengths || d.lengths,
        };
      }),
    };
  });
  return { ...info, subCourses, holeDbClubId: dbInfo.clubId };
}

/** 골프장 목록 화면용 - 전국 코스DB에 코스·홀 데이터가 있는 골프장의 이름들(정식 명칭·요청명·문체부 등록명).
 * 프론트가 문체부 목록(/api/golf-db)의 이름과 대조해서 "코스 입력 ›" 대신 DB 코스정보를 보여주는 데 쓴다.
 * 문체부 등록명은 "라데나골프클럽(27홀·회원제)"처럼 뒤에 붙은 (홀수·구분)만 떼고 원래 표기 그대로 돌려준다. */
export async function listCourseHoleDbIndex(env) {
  const { results } = await env.PRICE_DB.prepare(
    `SELECT c.club_id, c.official_name, c.request_name, c.mcst_registered_names
       FROM gc_clubs c
      WHERE EXISTS (SELECT 1 FROM gc_holes h WHERE h.club_id = c.club_id AND h.par IS NOT NULL)`
  ).all();
  return results.map((r) => {
    const names = new Set([r.official_name, r.request_name].filter(Boolean));
    for (const m of (r.mcst_registered_names || '').split(' / ')) {
      const n = m.replace(/\(\d+홀[^)]*\)\s*$/, '').trim();
      if (n) names.add(n);
    }
    return { clubId: r.club_id, courseName: r.official_name, names: [...names] };
  });
}
