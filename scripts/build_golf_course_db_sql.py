"""data/*.csv(전국 골프장 DB) → D1 gc_* 테이블 반영용 SQL.

기본(차분) 모드: D1의 현재 gc_* 내용을 읽어 CSV와 비교하고, 바뀐 행만 SQL로 만든다
(data/golf_course_db_diff.sql). 새 행은 INSERT, 값이 바뀐 행은 바뀐 열만 UPDATE, CSV에서 빠진 행은 DELETE.
전체 재적재(DELETE 후 전부 INSERT)는 행 쓰기가 16만~23만 건 나와서 D1 무료 한도(하루 10만 행 쓰기)를
넘는다(2026-11-18 실제로 트래픽 폭증의 원인이었음). 차분 모드는 D1을 약 6만 행 읽는다(무료 한도 하루 500만 행).

사용:
  python scripts/build_golf_course_db_sql.py            # 차분 SQL 생성 + 바뀐 행 수 요약만 출력(D1 쓰기 없음)
  python scripts/build_golf_course_db_sql.py --apply    # 차분 SQL 생성 후 D1에 바로 반영
  python scripts/build_golf_course_db_sql.py --full     # 전체 재적재 SQL(data/golf_course_db_seed.sql) - 테이블을 새로 만들 때만

최초 1회(테이블 생성):
  wrangler d1 execute PRICE_DB --remote --file=migrations/0004_golf_course_db.sql
  wrangler d1 execute PRICE_DB --remote --file=migrations/0005_gc_holes_std_tees.sql
"""
import csv
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')
OUT_FULL = os.path.join(DATA, 'golf_course_db_seed.sql')
OUT_DIFF = os.path.join(DATA, 'golf_course_db_diff.sql')
DB = 'PRICE_DB'
BATCH = 200  # D1 문장 하나당 크기 제한(100KB)을 넉넉히 피하는 행 수

TABLES = [
    # (테이블, CSV, 기본키 열, [(D1 열, CSV 열, 타입)])
    ('gc_clubs', 'golf_clubs.csv', ['club_id'], [
        ('club_id', 'club_id', 's'), ('official_name', 'official_name', 's'), ('request_name', 'request_name', 's'),
        ('mcst_registered_names', 'mcst_registered_names', 's'), ('region', 'region', 's'), ('city', 'city', 's'),
        ('address', 'address', 's'), ('operation_type', 'operation_type', 's'), ('total_holes', 'total_holes', 'i'),
        ('homepage_url', 'homepage_url', 's'), ('data_status', 'data_status', 's'),
    ]),
    ('gc_courses', 'courses.csv', ['course_id'], [
        ('course_id', 'course_id', 's'), ('club_id', 'club_id', 's'), ('course_seq', 'course_seq', 'i'),
        ('course_name', 'course_name', 's'), ('hole_count', 'hole_count', 'i'), ('par_total', 'par_total', 'i'),
        ('data_status', 'data_status', 's'),
    ]),
    ('gc_holes', 'holes.csv', ['hole_id'], [
        ('hole_id', 'hole_id', 's'), ('course_id', 'course_id', 's'), ('club_id', 'club_id', 's'),
        ('hole_no', 'hole_no', 'i'), ('par', 'par', 'i'), ('handicap', 'handicap', 'i'), ('base_tee', 'base_tee', 's'),
        ('base_tee_length_m', 'base_tee_length_m', 'i'), ('white_tee_m', 'white_tee_m', 'i'),
        ('red_tee_m', 'red_tee_m', 'i'), ('blue_tee_m', 'blue_tee_m', 'i'), ('black_tee_m', 'black_tee_m', 'i'),
        ('std_tee_check', 'std_tee_check', 's'), ('data_status', 'data_status', 's'),
    ]),
    ('gc_hole_tees', 'hole_tee_lengths.csv', ['hole_id', 'tee_seq'], [
        ('hole_id', 'hole_id', 's'), ('course_id', 'course_id', 's'), ('club_id', 'club_id', 's'),
        ('hole_no', 'hole_no', 'i'), ('tee_seq', 'tee_seq', 'i'), ('tee_name', 'tee_name', 's'),
        ('tee_group', 'tee_group', 's'), ('ladies', 'ladies', 's'), ('length_m', 'length_m', 'i'),
    ]),
    ('gc_course_tees', 'course_tees.csv', ['course_id', 'tee_seq'], [
        ('course_id', 'course_id', 's'), ('club_id', 'club_id', 's'), ('tee_seq', 'tee_seq', 'i'),
        ('tee_name', 'tee_name', 's'), ('tee_group', 'tee_group', 's'), ('ladies', 'ladies', 's'),
        ('total_length_m', 'total_length_m', 'i'), ('holes_with_length', 'holes_with_length', 'i'),
    ]),
]


def lit(v, t):
    """CSV 값 또는 D1 값 → SQL 리터럴. 양쪽을 같은 함수로 바꿔서 비교하므로 표기 차이(공백, 1.0 vs 1)가 변경으로 잡히지 않는다."""
    if v is None:
        return 'NULL'
    v = str(v).strip()
    if v == '':
        return 'NULL'
    if t == 'i':
        return str(int(round(float(v.replace(',', '')))))
    return "'" + v.replace("'", "''") + "'"


def read_csv(fname, cols):
    with open(os.path.join(DATA, fname), encoding='utf-8-sig', newline='') as f:
        return [{d1: lit(r.get(src), t) for d1, src, t in cols} for r in csv.DictReader(f)]


def wrangler(args):
    # Windows에서는 npx가 .cmd라 shell=True가 필요하다. 출력은 UTF-8로 읽는다(한글 깨짐 방지).
    cmd = 'npx wrangler d1 execute ' + DB + ' --remote ' + args
    p = subprocess.run(cmd, cwd=ROOT, shell=True, capture_output=True, encoding='utf-8', errors='replace')
    if p.returncode != 0:
        sys.exit(f'wrangler 실패:\n{p.stdout[-2000:]}\n{p.stderr[-2000:]}')
    return p.stdout


def read_d1(table, cols):
    out = wrangler(f'--json --command "SELECT {", ".join(c[0] for c in cols)} FROM {table}"')
    data = json.loads(out[out.index('['):])
    return [{d1: lit(r.get(d1), t) for d1, _, t in cols} for r in data[0]['results']]


def insert_sql(table, cols, rows):
    col_list = ', '.join(c[0] for c in cols)
    for i in range(0, len(rows), BATCH):
        values = ',\n'.join('(' + ', '.join(r[c[0]] for c in cols) + ')' for r in rows[i:i + BATCH])
        yield f'INSERT INTO {table} ({col_list}) VALUES\n{values};'


def where(pk, r):
    return ' AND '.join(f'{k} = {r[k]}' for k in pk)


def build_full():
    out = []
    for table, fname, _, cols in TABLES:
        rows = read_csv(fname, cols)
        out.append(f'DELETE FROM {table};')
        out.extend(insert_sql(table, cols, rows))
        print(f'{table}: {len(rows)}')
    with open(OUT_FULL, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(out) + '\n')
    print(f'-> {OUT_FULL} ({os.path.getsize(OUT_FULL):,} bytes) - 전체 재적재: 행 쓰기 16만 건 이상 발생')


def build_diff():
    out = []
    total = 0
    for table, fname, pk, cols in TABLES:
        new = {tuple(r[k] for k in pk): r for r in read_csv(fname, cols)}
        old = {tuple(r[k] for k in pk): r for r in read_d1(table, cols)}
        added = [new[k] for k in new if k not in old]
        removed = [old[k] for k in old if k not in new]
        changed = 0
        for k in new.keys() & old.keys():
            diff = [c[0] for c in cols if c[0] not in pk and new[k][c[0]] != old[k][c[0]]]
            if diff:
                changed += 1
                sets = ', '.join(f'{c} = {new[k][c]}' for c in diff)
                out.append(f'UPDATE {table} SET {sets} WHERE {where(pk, new[k])};')
        out.extend(f'DELETE FROM {table} WHERE {where(pk, r)};' for r in removed)
        out.extend(insert_sql(table, cols, added))
        total += len(added) + changed + len(removed)
        print(f'{table}: CSV {len(new)} / D1 {len(old)} -> 추가 {len(added)}, 변경 {changed}, 삭제 {len(removed)}')
    if not out:
        if os.path.exists(OUT_DIFF):
            os.remove(OUT_DIFF)
        print('바뀐 행 없음 - D1이 CSV와 같습니다.')
        return None
    with open(OUT_DIFF, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(out) + '\n')
    print(f'-> {OUT_DIFF} (바뀐 행 {total}건, {os.path.getsize(OUT_DIFF):,} bytes)')
    return OUT_DIFF


def main():
    if '--full' in sys.argv:
        build_full()
        return
    path = build_diff()
    if path and '--apply' in sys.argv:
        out = wrangler(f'--file="{os.path.relpath(path, ROOT)}" -y')
        written = [l.strip() for l in out.splitlines() if 'rows_written' in l]
        print('D1 반영 완료', written[-1] if written else '')


if __name__ == '__main__':
    main()
