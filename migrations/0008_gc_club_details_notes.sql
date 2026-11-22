-- 골프장 보기 화면(소개 + 홀별 정보)용: gc_clubs에 소개·운영 정보 열 추가, 코스별 설명(data/course_notes.csv) 테이블.
-- 적용 후 scripts/build_golf_course_db_sql.py --apply 로 새 열과 설명을 채운다(바뀐 행만 반영).
-- 적용: wrangler d1 execute PRICE_DB --remote --file=migrations/0008_gc_club_details_notes.sql
ALTER TABLE gc_clubs ADD COLUMN phone TEXT;
ALTER TABLE gc_clubs ADD COLUMN total_par INTEGER;
ALTER TABLE gc_clubs ADD COLUMN course_layout TEXT;
ALTER TABLE gc_clubs ADD COLUMN total_length_text TEXT;
ALTER TABLE gc_clubs ADD COLUMN caddie_cart TEXT;
ALTER TABLE gc_clubs ADD COLUMN features TEXT;
ALTER TABLE gc_clubs ADD COLUMN remarks TEXT;
ALTER TABLE gc_clubs ADD COLUMN main_sources TEXT;
ALTER TABLE gc_clubs ADD COLUMN operator TEXT;

CREATE TABLE IF NOT EXISTS gc_course_notes (
  club_id TEXT NOT NULL,
  course_name TEXT NOT NULL,
  holes INTEGER,
  par INTEGER,
  length_text TEXT,
  description TEXT,
  PRIMARY KEY (club_id, course_name)
);
