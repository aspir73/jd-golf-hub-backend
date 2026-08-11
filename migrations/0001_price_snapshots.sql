-- 골프장 조인/부킹 가격 스냅샷. NAS 수집 스크립트가 매일 새벽 1시에 넣는 원자료(raw) 그대로
-- 저장 - 사전 집계하지 않는다(나중에 어떤 분석을 할지 지금 다 예측할 수 없어서, SQL로 자유롭게
-- 다시 집계할 수 있게 원자료를 최대한 보존하는 쪽을 택함).
CREATE TABLE price_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collected_date TEXT NOT NULL,       -- 수집(관측) 실행일, YYYY-MM-DD
  round_date TEXT NOT NULL,           -- 라운드 예정일, YYYY-MM-DD
  lead_days INTEGER NOT NULL,         -- round_date - collected_date (리드타임 분석용: 며칠 전에 봤을 때 가격인지)
  weekday INTEGER NOT NULL,           -- round_date의 요일(0=일 ~ 6=토)
  region_group TEXT NOT NULL,         -- hangang | gangbuk | gangwon | chungcheong (regionMap.js와 동일 값)
  mode TEXT NOT NULL,                 -- booking | join
  course_name_raw TEXT NOT NULL,      -- 골팡에 표기된 원문 골프장명
  official_course_name TEXT,          -- golfCourseDB findBestMatch 매칭 결과(매칭 실패 시 NULL)
  time TEXT,                          -- 티타임 HH:MM
  holes TEXT,
  green_fee INTEGER,
  caddy_type TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_price_course_round ON price_snapshots(official_course_name, round_date);
CREATE INDEX idx_price_course_collected ON price_snapshots(official_course_name, collected_date);
CREATE INDEX idx_price_region_round ON price_snapshots(region_group, round_date);
