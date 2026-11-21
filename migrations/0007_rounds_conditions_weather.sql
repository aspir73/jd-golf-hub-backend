-- 라운드 결과 인사이트용: 라운드 조건(그린 스피드·컨디션·라운드 성격·카트·캐디·연습)과 플레이 시간대 날씨 스냅샷, 홀별 입력 시각.
-- 적용: wrangler d1 execute PRICE_DB --remote --file=migrations/0007_rounds_conditions_weather.sql
ALTER TABLE rounds ADD COLUMN conditions_json TEXT;
ALTER TABLE rounds ADD COLUMN weather_json TEXT;
ALTER TABLE holes ADD COLUMN entered_at TEXT;
