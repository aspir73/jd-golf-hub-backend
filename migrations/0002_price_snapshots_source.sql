-- 골팡+카카오골프예약 병합 수집으로 전환하면서 추가: 어느 플랫폼 값이 최종 저장됐는지(source),
-- 시간대를 오전(~12시)/오후(12~16시)/야간(16시~) 3구간으로 묶은 값(time_bucket) - 두 플랫폼을
-- "골프장+라운드일+시간대" 단위로 비교해서 더 저렴한 쪽만 남기는 dedup 기준이 이 3개 컬럼
-- (official_course_name, round_date, time_bucket)이다.
ALTER TABLE price_snapshots ADD COLUMN source TEXT;
ALTER TABLE price_snapshots ADD COLUMN time_bucket TEXT;

CREATE INDEX idx_price_course_round_bucket ON price_snapshots(official_course_name, round_date, time_bucket);
