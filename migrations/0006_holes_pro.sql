-- 스코어 입력 "프로" 모드의 샷 단위 기록(티샷/페어웨이공략/그린공략/스크램블링/퍼팅)을 홀 행에 JSON으로 같이 저장한다.
-- 적용: wrangler d1 execute PRICE_DB --remote --file=migrations/0006_holes_pro.sql
ALTER TABLE holes ADD COLUMN pro_json TEXT;
