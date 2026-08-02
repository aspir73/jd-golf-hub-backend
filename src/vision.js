// Claude Vision API 연동 - 스코어카드/화면캡처/영수증 사진에서 구조화 데이터 추출 (기획서 4장 "공용 이미지 인식 컴포넌트").
// 클라이언트가 아닌 Worker에서만 Anthropic API를 호출한다 (기획서 8장 API 키 보안 방침과 동일하게 적용).

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL = 'claude-opus-5';

const SCORE_SCHEMA = {
  type: 'object',
  properties: {
    courseName: { type: 'string', description: '골프장명. 모르면 빈 문자열' },
    courseSubName: { type: 'string', description: '코스명(예: 레이크코스). 모르면 빈 문자열' },
    date: { type: 'string', description: '라운딩 날짜 YYYY-MM-DD 형식. 안 보이면 빈 문자열' },
    totalScore: { type: 'integer', description: '총 타수. 모르면 -1. 홀별 타수만 보이면 합산해서 계산' },
    fir: { type: 'integer', description: '페어웨이 안착률(%). 모르면 -1' },
    gir: { type: 'integer', description: '그린 적중률(%). 모르면 -1' },
    putts: { type: 'integer', description: '총 퍼트 수. 모르면 -1' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: '인식 결과에 대한 확신도' },
  },
  required: ['courseName', 'courseSubName', 'date', 'totalScore', 'fir', 'gir', 'putts', 'confidence'],
  additionalProperties: false,
};

const RECEIPT_SCHEMA = {
  type: 'object',
  properties: {
    storeName: { type: 'string', description: '가게 이름. 모르면 빈 문자열' },
    totalAmount: { type: 'integer', description: '총 결제 금액. 모르면 -1' },
    items: {
      type: 'array',
      description: '영수증에 찍힌 항목별 명칭과 금액',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          amount: { type: 'integer' },
        },
        required: ['label', 'amount'],
        additionalProperties: false,
      },
    },
  },
  required: ['storeName', 'totalAmount', 'items'],
  additionalProperties: false,
};

const PROMPTS = {
  scorecard:
    '이 사진은 골프 종이 스코어카드입니다. 골프장명, 코스명, 라운딩 날짜, 총타수, 페어웨이 안착률(FIR), 그린 적중률(GIR), 총 퍼트 수를 읽어서 추출해주세요. 홀별 타수만 적혀 있고 총타수 합계가 안 보이면 직접 더해서 계산하세요.',
  voicecaddie:
    '이 사진은 보이스캐디 앱의 라운딩 결과 화면 캡처입니다. 골프장명, 코스명, 라운딩 날짜, 총타수, FIR, GIR, 퍼트 수를 화면에서 추출해주세요.',
  smartscore:
    '이 사진은 스마트스코어 앱의 라운딩 결과 화면 캡처입니다. 골프장명, 코스명, 라운딩 날짜, 총타수, FIR, GIR, 퍼트 수를 화면에서 추출해주세요.',
  receipt:
    '이 사진은 골프 라운딩 중 결제한 영수증입니다. 가게 이름, 총 결제 금액, 영수증에 찍힌 항목별 명칭과 금액을 추출해주세요.',
};

function schemaFor(context) {
  return context === 'receipt' ? RECEIPT_SCHEMA : SCORE_SCHEMA;
}

/** 구조화 출력에서 "모름"을 표현하는 -1 sentinel을 null로 정리 (JSON Schema가 숫자 제약을 지원하지 않아 sentinel 값 사용) */
function nullifyUnknown(record) {
  const out = { ...record };
  for (const key of ['totalScore', 'fir', 'gir', 'putts']) {
    if (out[key] === -1) out[key] = null;
  }
  return out;
}

export async function recognizeImage(env, { imageBase64, mediaType, context }) {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY가 설정되지 않았습니다 (wrangler secret put ANTHROPIC_API_KEY)');
  }
  const prompt = PROMPTS[context];
  if (!prompt) throw new Error(`지원하지 않는 인식 타입입니다: ${context}`);
  if (!imageBase64 || !mediaType) throw new Error('imageBase64, mediaType이 필요합니다');

  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
            { type: 'text', text: prompt },
          ],
        },
      ],
      output_config: {
        format: { type: 'json_schema', schema: schemaFor(context) },
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Claude Vision API 호출 실패: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  const data = await res.json();

  if (data.stop_reason === 'refusal') {
    throw new Error('이미지 인식 요청이 거부되었습니다 (안전 정책)');
  }

  const textBlock = (data.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('인식 결과를 받지 못했습니다');

  let parsed;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch {
    throw new Error('인식 결과 JSON 파싱에 실패했습니다');
  }

  return context === 'receipt' ? parsed : nullifyUnknown(parsed);
}
