// 문체부 골프장 DB(golfCourseDB.js)의 지역(시/도) 값을 검색 API가 쓰는 표준화된 지역 그룹으로
// 매핑한다. index.html의 DB_REGION_TO_NORMALIZED/NORMALIZED_REGIONS와 반드시 같은 내용으로
// 유지해야 한다 - 프론트와 별도 배포물이라 자동으로 동기화되지 않는다(normalizeCourseName과
// 같은 "양쪽에 동일하게 유지해야 하는 규칙" 목록에 추가).
// 서울/경기/인천은 DB에 더 세부적인 좌표 정보가 없어 한강이남/강북·경춘 어느 쪽인지 구분할 수
// 없으므로 둘 다 포함시켜(안전하게 넓게) 검색에서 놓치는 일이 없게 한다.
export const DB_REGION_TO_NORMALIZED = {
  '서울': ['hangang', 'gangbuk'], '경기': ['hangang', 'gangbuk'], '인천': ['hangang', 'gangbuk'],
  '강원': ['gangwon'],
  '충남': ['chungcheong'], '충북': ['chungcheong'], '대전': ['chungcheong'], '세종': ['chungcheong'],
  '경남': ['gyeongsang'], '경북': ['gyeongsang'], '대구': ['gyeongsang'], '부산': ['gyeongsang'], '울산': ['gyeongsang'],
  '전남': ['jeolla'], '전북': ['jeolla'], '광주': ['jeolla'],
  '제주': ['jeju'],
};

// 표준화 지역 그룹 -> 골팡 sector 코드 / 카카오골프예약 대권역 코드 / XGOLF 지역코드 (index.html의
// NORMALIZED_REGIONS와 동일 값). XGOLF도 카카오골프예약과 같은 이유로 경기/인천을 한강이남·
// 강북/경춘으로 안 나누므로 hangang/gangbuk 둘 다 같은 코드(762)를 쓴다.
export const NORMALIZED_REGION_CODES = {
  hangang: { golfpang: '5', kakaoMajor: '1', xgolf: '762' },
  gangbuk: { golfpang: '1', kakaoMajor: '1', xgolf: '762' },
  gangwon: { golfpang: '8', kakaoMajor: '12', xgolf: '764' },
  chungcheong: { golfpang: '4', kakaoMajor: '22', xgolf: '765' },
  gyeongsang: { golfpang: '3', kakaoMajor: '31', xgolf: '766' },
  jeolla: { golfpang: '6', kakaoMajor: '41', xgolf: '767' },
  jeju: { golfpang: '7', kakaoMajor: '46', xgolf: '768' },
};
