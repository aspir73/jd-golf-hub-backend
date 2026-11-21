-- 전국 골프장 코스·홀 DB (data/*.csv, 2026-11-18 정규화본). 라운드 기록용 holes 테이블(0003)과 이름이
-- 겹치지 않도록 gc_ 접두사를 쓴다. 데이터 적재는 scripts/build_golf_course_db_sql.py가 만든
-- data/golf_course_db_seed.sql로 한다(테이블 내용을 지우고 다시 넣는 방식이라 재실행해도 안전).
-- 적용: wrangler d1 execute PRICE_DB --remote --file=migrations/0004_golf_course_db.sql
CREATE TABLE IF NOT EXISTS gc_clubs (
  club_id TEXT PRIMARY KEY,
  official_name TEXT,
  request_name TEXT,
  mcst_registered_names TEXT,
  region TEXT,
  city TEXT,
  address TEXT,
  operation_type TEXT,
  total_holes INTEGER,
  homepage_url TEXT,
  data_status TEXT
);

CREATE TABLE IF NOT EXISTS gc_courses (
  course_id TEXT PRIMARY KEY,
  club_id TEXT NOT NULL,
  course_seq INTEGER,
  course_name TEXT,
  hole_count INTEGER,
  par_total INTEGER,
  data_status TEXT
);
CREATE INDEX IF NOT EXISTS idx_gc_courses_club ON gc_courses(club_id, course_seq);

CREATE TABLE IF NOT EXISTS gc_holes (
  hole_id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL,
  club_id TEXT NOT NULL,
  hole_no INTEGER,
  par INTEGER,
  handicap INTEGER,
  base_tee TEXT,
  base_tee_length_m INTEGER,
  data_status TEXT
);
CREATE INDEX IF NOT EXISTS idx_gc_holes_club ON gc_holes(club_id, course_id, hole_no);

CREATE TABLE IF NOT EXISTS gc_hole_tees (
  hole_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  club_id TEXT NOT NULL,
  hole_no INTEGER,
  tee_seq INTEGER NOT NULL,
  tee_name TEXT,
  tee_group TEXT,
  ladies TEXT,
  length_m INTEGER,
  PRIMARY KEY (hole_id, tee_seq)
);
CREATE INDEX IF NOT EXISTS idx_gc_hole_tees_club ON gc_hole_tees(club_id);

CREATE TABLE IF NOT EXISTS gc_course_tees (
  course_id TEXT NOT NULL,
  club_id TEXT NOT NULL,
  tee_seq INTEGER NOT NULL,
  tee_name TEXT,
  tee_group TEXT,
  ladies TEXT,
  total_length_m INTEGER,
  holes_with_length INTEGER,
  PRIMARY KEY (course_id, tee_seq)
);
CREATE INDEX IF NOT EXISTS idx_gc_course_tees_club ON gc_course_tees(club_id);
