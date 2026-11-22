-- holes.csv v2의 표준 4개 티 거리(m) 열과 환산 기록(std_tee_check)을 gc_holes에 추가.
-- 적용 후 scripts/build_golf_course_db_sql.py로 seed를 다시 만들어 적재한다.
-- 적용: wrangler d1 execute PRICE_DB --remote --file=migrations/0005_gc_holes_std_tees.sql
ALTER TABLE gc_holes ADD COLUMN white_tee_m INTEGER;
ALTER TABLE gc_holes ADD COLUMN red_tee_m INTEGER;
ALTER TABLE gc_holes ADD COLUMN blue_tee_m INTEGER;
ALTER TABLE gc_holes ADD COLUMN black_tee_m INTEGER;
ALTER TABLE gc_holes ADD COLUMN std_tee_check TEXT;
