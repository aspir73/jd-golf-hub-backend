-- 라운드 리포트용 정규화 테이블(D1). 앱이 쓰는 원본은 KV('scores')이고, 스코어를 저장/수정/삭제할 때마다
-- 여기로 같이 반영(src/roundDb.js)해서 시즌/코스/추세 같은 집계 리포트를 SQL로 바로 뽑을 수 있게 한다.
-- 적용: wrangler d1 execute PRICE_DB --remote --file=migrations/0003_rounds_reports.sql
-- 기존 KV 기록 채우기: POST /api/reports/backfill (여러 번 호출해도 같은 결과 - upsert)

CREATE TABLE IF NOT EXISTS rounds (
  id TEXT PRIMARY KEY,
  play_date TEXT NOT NULL,          -- YYYY-MM-DD
  year INTEGER NOT NULL,
  course_name TEXT NOT NULL,
  sub_course TEXT,                  -- "로맨틱 → 클래식"
  out_course TEXT,                  -- 전반 코스
  in_course TEXT,                   -- 후반 코스
  tee_box TEXT,
  status TEXT NOT NULL,             -- in_progress | done
  course_rating REAL,               -- KGA 코스레이팅
  slope_rating REAL,
  course_length INTEGER,            -- m
  user_rating INTEGER,              -- 내가 준 코스 평점(1~5)

  holes_played INTEGER NOT NULL DEFAULT 0,
  par_played INTEGER,               -- 입력된 홀들의 파 합
  total_score INTEGER,
  to_par INTEGER,

  putts INTEGER,                    -- 퍼팅 입력된 홀의 합
  putts_holes INTEGER,              -- 퍼팅이 입력된 홀 수
  three_putts INTEGER,              -- 3퍼트 이상 홀 수
  three_putt_extra INTEGER,         -- 2퍼트를 넘긴 퍼팅 수 합(3퍼트로 잃은 타수)

  fir_hit INTEGER, fir_n INTEGER,   -- 티샷 결과가 입력된 파4/5 홀 기준
  gir_hit INTEGER, gir_n INTEGER,

  eagle INTEGER NOT NULL DEFAULT 0,
  birdie INTEGER NOT NULL DEFAULT 0,
  par_cnt INTEGER NOT NULL DEFAULT 0,
  bogey INTEGER NOT NULL DEFAULT 0,
  double_cnt INTEGER NOT NULL DEFAULT 0,
  triple_cnt INTEGER NOT NULL DEFAULT 0,   -- 트리플 이상

  penalty_strokes INTEGER NOT NULL DEFAULT 0,
  ob INTEGER NOT NULL DEFAULT 0,
  hazard INTEGER NOT NULL DEFAULT 0,
  bunker INTEGER NOT NULL DEFAULT 0,
  tee_miss_left INTEGER NOT NULL DEFAULT 0,
  tee_miss_right INTEGER NOT NULL DEFAULT 0,
  mulligans INTEGER NOT NULL DEFAULT 0,

  companions TEXT,                  -- JSON [{name,score}]
  memo TEXT,
  summary_json TEXT,                -- 저장 시점에 계산된 요약(roundSummary.js)
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_rounds_date ON rounds(play_date);
CREATE INDEX IF NOT EXISTS idx_rounds_year_status ON rounds(year, status);
CREATE INDEX IF NOT EXISTS idx_rounds_course ON rounds(course_name);

CREATE TABLE IF NOT EXISTS holes (
  round_id TEXT NOT NULL,
  hole_no INTEGER NOT NULL,         -- 1~18
  sub_course TEXT,                  -- 그 홀이 속한 코스(전반/후반 코스명)
  par INTEGER,
  score INTEGER,
  diff INTEGER,                     -- score - par
  result TEXT,                      -- eagle | birdie | par | bogey | double | triple
  shots INTEGER,                    -- 그린까지 친 타수(퍼팅·페널티 제외)
  putts INTEGER,
  penalty INTEGER,
  mulligan INTEGER,                 -- 0/1
  fairway_hit INTEGER,              -- 1/0, 파3·미입력은 NULL
  green_hit INTEGER,                -- 1/0, 미입력은 NULL
  tee_shot TEXT,                    -- fairway | rough | waste | bunker | hazard | ob
  miss_dir TEXT,                    -- left | right | unknown
  PRIMARY KEY (round_id, hole_no)
);
CREATE INDEX IF NOT EXISTS idx_holes_round ON holes(round_id);
CREATE INDEX IF NOT EXISTS idx_holes_result ON holes(result);
