-- 전국 골프장 DB 스키마 (PostgreSQL 기준, MySQL은 TEXT/NUMERIC 타입만 맞추면 그대로 사용 가능)
-- CSV: UTF-8(BOM 없음), 첫 줄 헤더, 빈 칸 = NULL
CREATE TABLE golf_clubs (
  club_id VARCHAR(10) PRIMARY KEY, legacy_no INT, request_name TEXT, official_name TEXT,
  region VARCHAR(10), city VARCHAR(20), address TEXT, phone TEXT, operation_type TEXT,
  total_holes INT, total_par INT, course_layout TEXT, total_length_text TEXT, caddie_cart TEXT,
  turf TEXT, features TEXT, homepage_url TEXT, remarks TEXT, main_sources TEXT,
  scorecard_coverage_note TEXT, mcst_registered_names TEXT, mcst_total_holes INT, mcst_type TEXT,
  operator TEXT, area_m2 BIGINT, kga_match VARCHAR(10), kga_course_combos TEXT,
  data_status VARCHAR(10), data_status_note TEXT
);
CREATE TABLE mcst_registrations (
  reg_id VARCHAR(10) PRIMARY KEY, club_id VARCHAR(10) REFERENCES golf_clubs(club_id),
  region VARCHAR(10), registered_name TEXT, operator TEXT, address TEXT,
  area_m2 BIGINT, holes INT, registration_type VARCHAR(10)
);
CREATE TABLE courses (
  course_id VARCHAR(16) PRIMARY KEY, club_id VARCHAR(10) REFERENCES golf_clubs(club_id),
  course_seq INT, course_name TEXT, hole_count INT, par_total INT, length_unit VARCHAR(5),
  tee_count INT, source TEXT, data_status VARCHAR(10)
);
CREATE TABLE holes (
  hole_id VARCHAR(20) PRIMARY KEY, course_id VARCHAR(16) REFERENCES courses(course_id),
  club_id VARCHAR(10) REFERENCES golf_clubs(club_id), hole_no INT, par INT, handicap INT,
  base_tee TEXT, base_tee_length INT, unit VARCHAR(5), base_tee_length_m INT,
  white_tee_m INT, red_tee_m INT, blue_tee_m INT, black_tee_m INT, std_tee_check TEXT, data_status VARCHAR(10)
);
CREATE TABLE hole_tee_lengths (
  hole_id VARCHAR(20) REFERENCES holes(hole_id), course_id VARCHAR(16), club_id VARCHAR(10),
  hole_no INT, tee_seq INT, tee_name TEXT, tee_group VARCHAR(10), ladies CHAR(1),
  length INT, unit VARCHAR(5), length_m INT,
  PRIMARY KEY (hole_id, tee_seq)
);
CREATE TABLE course_tees (
  course_id VARCHAR(16) REFERENCES courses(course_id), club_id VARCHAR(10), tee_seq INT,
  tee_name TEXT, tee_group VARCHAR(10), ladies CHAR(1), total_length INT, unit VARCHAR(5),
  total_length_m INT, holes_with_length INT,
  PRIMARY KEY (course_id, tee_seq)
);
CREATE TABLE course_notes (
  club_id VARCHAR(10) REFERENCES golf_clubs(club_id), club_name TEXT, course_name TEXT,
  holes INT, par INT, length_text TEXT, description TEXT
);
CREATE TABLE kga_course_ratings (
  club_id VARCHAR(10) REFERENCES golf_clubs(club_id), club_name TEXT, kga_club_name TEXT,
  province TEXT, city TEXT, kga_course_combo TEXT, tee_set TEXT, gender VARCHAR(4),
  course_rating NUMERIC(4,1), slope_rating INT, length_yd INT, link_status TEXT
);
-- PostgreSQL 적재 예: \copy golf_clubs FROM 'golf_clubs.csv' CSV HEADER
-- 순서: golf_clubs → mcst_registrations → courses → holes → hole_tee_lengths → course_tees → course_notes → kga_course_ratings
