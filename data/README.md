# 전국 골프장 DB용 CSV (2026-11-18 업데이트 v2)

원본: 골프장_코스정보_스코어카드포함_2026-11-18-6 (엑셀 7개 시트, 홀별 티거리 보강본) → 테이블 8개로 정규화

## 파일과 키
| 파일 | 행 수 | 키 | 원본 시트 |
|---|---|---|---|
| golf_clubs.csv | 487 | club_id (GC0001) | 골프장_요약 |
| mcst_registrations.csv | 541 | reg_id (R0001) → club_id | 문체부_등록현황 |
| courses.csv | 1,158 | course_id (GC0001-C01) → club_id | 홀별_상세에서 추출 |
| holes.csv | 10,421 | hole_id (GC0001-C01-H01) → course_id | 홀별_상세 |
| hole_tee_lengths.csv | 42,205 | hole_id + tee_seq | 스코어카드(1~9홀) + 홀별_상세 '티별 상세 전장'(10~18홀) |
| course_tees.csv | 4,704 | course_id + tee_seq | hole_tee_lengths 합산 |
| course_notes.csv | 70 | club_id | 코스별_상세 |
| kga_course_ratings.csv | 920 | club_id (미연결 행은 빈칸) | KGA_코스레이팅 |

테이블 구조와 적재 순서는 schema.sql 참고.

| 보조 파일 | 내용 |
|---|---|
| homepage_url_notes.csv | 예전 경기강원충북충남_골프장_스크래핑목록.csv의 홈페이지 URL 중 golf_clubs.csv와 다르거나(현재 값 유지) 매칭되는 골프장이 없는 것 |

## 공통 규칙
- 인코딩 UTF-8(BOM 없음), 구분자 쉼표, 쉼표·줄바꿈이 들어간 칸은 큰따옴표로 감쌈
- 빈 칸 = NULL. 원본의 '미확인', '-'도 NULL로 처리
- 거리: `length`/`unit`은 원본 값과 단위 그대로, `*_m` 열은 yd를 m로 환산(×0.9144, 소수점 첫째 자리 반올림)한 값. 원래 m인 값은 그대로

## 열 설명 (주요)
- **holes**: par(파), handicap(핸디캡), base_tee(기준 티), base_tee_length(기준 티 거리), white_tee_m·red_tee_m·blue_tee_m·black_tee_m(원본 '화이트티(m)·레드티(m)·블루티(m)·블랙티(m)' 열 그대로), std_tee_check(아래 참고), data_status(확보/부분확보/미확보)
- **hole_tee_lengths**: 홀별·티별 거리를 세로(1행 = 1홀 × 1티)로 펼친 표. tee_name은 원본 표기 그대로, tee_group은 색·성격으로 묶은 보조값(화이트·블루·블랙·레드·골드·옐로·레귤러·챔피언·백·프론트·레이디 등, 분류가 안 되면 '기타'), ladies는 이름에 레이디스·여자가 들어가면 Y
- **course_tees**: 코스별 티 합계 거리. 모든 홀에 거리가 있을 때만 total_length를 채우고, 일부만 있으면 빈칸(holes_with_length로 확인)
- **courses**: par_total은 모든 홀의 Par가 있을 때만 합산. source는 원본 홀별_상세의 출처 문구
- **golf_clubs**: 한글 열 이름 대응 — request_name 요청명, official_name 정식 명칭, operation_type 운영형태, course_layout 코스 구성, total_length_text 총 전장(기준 티), caddie_cart 캐디·카트 운영, turf 잔디, features 코스 지형·특징, remarks 비고, main_sources 주요 출처, scorecard_coverage_note 홀별 스코어카드 확보, mcst_* 문체부 등록 정보, operator 사업자, area_m2 면적(㎡)

## 정리하면서 바꾼 점
- data_status(골프장·코스)는 소속 홀의 상태로 다시 계산함(전부 확보 → 확보, 전부 미확보 → 미확보, 그 외 부분확보). 원래 요약 시트의 상태 문구는 golf_clubs.data_status_note에 그대로 둠
- KGA_코스레이팅 시트는 'KGA 골프장명·도·시군' 머리글이 값과 한 칸씩 어긋나 있어서, CSV에서는 kga_club_name·province·city에 맞는 값이 들어가도록 바로잡음
- 스코어카드 시트는 1~9홀 칸만 있어서 18홀 단위로 입력된 무안CC(GC0359) 4개 코스의 10~18홀 티 거리는 홀별_상세의 '티별 상세 전장' 문구에서 읽어 옴

## v2 업데이트 (2026-11-18 22시)
- holes에 표준 4개 티 거리 열(white/red/blue/black_tee_m) 추가 - D1 gc_holes에도 같은 열(migrations/0005)
- 스코어카드 티 행이 401행 늘어난 것을 반영해 hole_tee_lengths(38,602 → 42,205행), course_tees(4,303 → 4,704행) 다시 생성. 길이 단위는 스코어카드 행마다 적힌 단위를 따르고, length_m은 그 단위로 환산
- **std_tee_check**: 표준 4개 티 열의 값이 같은 홀 스코어카드의 야드(yd) 원값과 똑같고, 미터 행에는 그 값이 없으면 해당 티 이름(white 등)을 적음. 즉 '(m)' 열에 야드 값이 환산 없이 들어갔던 칸. **v2.1(2026-11-18)에서 이 칸들(268홀·331칸)을 야드로 보고 m로 환산함**(×0.9144, 정수 반올림). 환산값은 전부 같은 홀 hole_tee_lengths의 length_m과 일치. std_tee_check는 어떤 칸을 환산했는지 기록용으로 남겨 둠. 가평베네스트(GC0190)의 white_tee_m은 원본에 골드 티 야드가 들어가 있던 것이라, 환산 대신 같은 홀 hole_tee_lengths의 화이트 티 length_m으로 바꿈(27홀)
- golf_clubs.homepage_url 중 카카오맵 장소·티픽골프·골프패스·클럽롱게·코브스윙 등 외부 페이지였던 13곳은 스크래핑목록의 공식 홈페이지로 교체함(2026-11-18)

## 앱에서 쓰는 곳
- gc_* D1 테이블: CSV 수정 후 `python scripts/build_golf_course_db_sql.py --apply` → D1과 비교해 바뀐 행만 반영(golf_course_db_diff.sql). `--apply` 없이 돌리면 바뀐 행 수만 확인. 전체 재적재(`--full`, 행 쓰기 16만 건 이상)는 테이블을 새로 만들 때만(migrations/0004·0005 참고)
- src/data/kgaCourseRatings.json: `python scripts/build_kga_ratings.py`가 kga_course_ratings.csv에서 생성
- src/data/golfCourseDB.json: 문체부 등록 현황(mcst_registrations.csv와 같은 원본)
