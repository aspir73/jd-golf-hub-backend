# -*- coding: utf-8 -*-
"""
data/KGA_코스레이팅_매칭데이터.xlsx의 '상세데이터' 시트를 파싱해서
Worker가 그대로 import하는 정적 JSON(src/data/kgaCourseRatings.json)을 만든다.
xlsx가 갱신되면(예: KGA가 새 코스레이팅을 발행하고 다시 매칭한 새 버전을 받으면)
이 스크립트를 다시 돌려서 JSON을 재생성하면 된다. 저장소 루트에서 실행:
    python scripts/build_kga_ratings.py

핵심 과제: 'KGA 코스조합' 필드(예: "코리아 레이크+챌린지")에는 골프장명에서 파생된
접두어 + 실제 코스(9홀 루프) 조합이 섞여 있다. 접두어는 같은 골프장의 여러 코스조합
사이에서 공통으로 반복되므로(예: 코리아CC의 3개 조합이 전부 "코리아 "로 시작), 그
공통 접두어를 뽑아서 제거하면 순수한 "A+B" 형태가 남는 경우가 많다. 코스조합이 1개뿐인
골프장은 비교 대상이 없어 접두어를 뽑을 수 없지만, 그 경우는 애초에 OUT/IN 두 개로
나눠 고를 필요 자체가 없다(코스가 이미 1개=18홀).

접두어를 뗀 나머지가:
  - "레이크+챌린지"처럼 괄호 없이 A+B 하나뿐이면 -> loopNames = [A, B]
  - "신(아웃+인)"처럼 괄호로 감싸져 있으면 -> 괄호 앞부분을 그룹명(신/구/동/서 등)으로 보고
    그룹명 + 괄호 안 A/B를 합쳐 "신 아웃"/"신 인"처럼 고유하게 만든다(그래야 서울한양처럼
    같은 클럽에 신/구 두 개의 완전히 다른 18홀 코스가 있을 때 이름이 안 겹친다).
  - 그 외(예: "동 * 2", "Yellow" 접미사 등 불규칙한 표기)는 loopNames = None으로 남겨두고,
    그 골프장 전체를 "loop 기반 아님"으로 표시해서 프론트에서 OUT/IN 두 드롭다운 대신
    코스조합 목록을 그대로 하나의 선택지로 보여주는 폴백 UI를 쓰게 한다(데이터를 억지로
    잘못 쪼개느니 원본 표기를 그대로 보여주는 게 안전하다).

필요 패키지: openpyxl (pip install openpyxl)
"""
import json
import os
import re
from collections import defaultdict
import openpyxl

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "data", "KGA_코스레이팅_매칭데이터.xlsx")
DST = os.path.join(ROOT, "src", "data", "kgaCourseRatings.json")


def common_prefix_words(labels):
    word_lists = [s.split() for s in labels]
    min_len = min(len(w) for w in word_lists)
    n = 0
    for i in range(min_len):
        w = word_lists[0][i]
        if all(wl[i] == w for wl in word_lists):
            n += 1
        else:
            break
    return " ".join(word_lists[0][:n])


def parse_loop_names(suffix):
    """접두어를 뗀 나머지 문자열에서 (그룹명, [A, B]) 형태를 최대한 뽑아본다. 실패하면 None."""
    suffix = suffix.strip()
    group_label = ""
    pair_part = suffix
    m = re.match(r"^(.*?)\(([^()]+)\)$", suffix)
    if m:
        group_label = m.group(1).strip()
        pair_part = m.group(2).strip()
    m2 = re.match(r"^([^+()]+)\+([^+()]+)$", pair_part)
    if not m2:
        return None
    a, b = m2.group(1).strip(), m2.group(2).strip()
    if group_label:
        return [f"{group_label} {a}", f"{group_label} {b}"]
    return [a, b]


def main():
    wb = openpyxl.load_workbook(SRC, data_only=True)
    ws = wb["상세데이터"]
    rows = list(ws.iter_rows(min_row=2, values_only=True))

    # 골프장명 -> {region, combos: {comboLabel: [teeSet rows]}} (콤보 등장 순서 보존을 위해 dict+list 병용)
    courses = {}
    combo_order = defaultdict(list)  # courseName -> [comboLabel, ...] (처음 등장 순서)

    for r in rows:
        region, city, course_name, combo_label, tee_set, gender, cr, sr, length_yd = r
        if not course_name or not combo_label:
            continue
        if course_name not in courses:
            courses[course_name] = {"region": region, "combos": {}}
        combos = courses[course_name]["combos"]
        if combo_label not in combos:
            combos[combo_label] = []
            combo_order[course_name].append(combo_label)
        combos[combo_label].append({
            "teeSet": tee_set,
            "gender": gender,
            "courseRating": cr,
            "slopeRating": sr,
            "courseLengthYards": length_yd,
        })

    result = []
    for course_name, data in courses.items():
        labels = combo_order[course_name]
        if len(labels) > 1:
            prefix = common_prefix_words(labels)
        else:
            prefix = ""  # 콤보 1개뿐이면 접두어를 뗄 필요도, 비교 대상도 없음

        combos_out = []
        all_parsed = True
        for label in labels:
            suffix = label
            if prefix and label.startswith(prefix):
                suffix = label[len(prefix):].strip()
            loop_names = parse_loop_names(suffix) if len(labels) > 1 else None
            if len(labels) > 1 and loop_names is None:
                all_parsed = False
            combos_out.append({
                "comboLabel": suffix if suffix else label,
                "loopNames": loop_names,
                "teeSets": data["combos"][label],
            })

        result.append({
            "courseName": course_name,
            "region": data["region"],
            "loopBased": len(labels) > 1 and all_parsed,
            "combos": combos_out,
        })

    with open(DST, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    total_combos = sum(len(c["combos"]) for c in result)
    total_teesets = sum(len(cc["teeSets"]) for c in result for cc in c["combos"])
    loop_based_courses = sum(1 for c in result if c["loopBased"])
    multi_combo_courses = sum(1 for c in result if len(c["combos"]) > 1)
    print(f"courses={len(result)} combos={total_combos} teeSetRecords={total_teesets}")
    print(f"multi-combo courses={multi_combo_courses}, loop-based(2-dropdown 가능)={loop_based_courses}")
    print(f"multi-combo but NOT loop-based(폴백 필요)={multi_combo_courses - loop_based_courses}")


if __name__ == "__main__":
    main()
