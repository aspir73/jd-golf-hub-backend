// 예약확정 카카오톡/문자 메시지 붙여넣기 → Claude API(텍스트, 구조화 출력)로 예약 기록 추출 (기획서 3-1).
// vision.js와 같은 이유로 클라이언트가 아닌 Worker에서만 Anthropic API를 호출한다.

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL = 'claude-opus-5';

const BOOKING_MESSAGE_SCHEMA = {
  type: 'object',
  properties: {
    reservationType: { type: 'string', enum: ['본인', '조인'], description: '본인이 직접 예약한 건인지, 조인(합류) 모집에 참여하는 건인지' },
    courseName: { type: 'string', description: '골프장명. 모르면 빈 문자열' },
    courseSubName: { type: 'string', description: '코스명. 모르면 빈 문자열' },
    roundDate: { type: 'string', description: '라운딩 날짜 YYYY-MM-DD. 안 보이면 빈 문자열' },
    roundTime: { type: 'string', description: '티타임 HH:MM. 안 보이면 빈 문자열' },
    reservationName: { type: 'string', description: '예약자명. 모르면 빈 문자열' },
    companions: {
      type: 'array',
      description: '조인인 경우 함께하는 동반인원 목록(예약자 본인 제외). 정보 없으면 빈 배열',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          phone: { type: 'string' },
          gender: { type: 'string', description: '남/여/모름' },
        },
        required: ['name', 'phone', 'gender'],
        additionalProperties: false,
      },
    },
    greenFeeAmount: { type: 'integer', description: '그린피 금액(원). 모르면 -1' },
    paymentMethod: { type: 'string', description: '결제방식 원문 그대로(예: 현장결제, 사전결제, 계좌이체 등). 모르면 빈 문자열' },
    cancelable: { type: 'string', enum: ['가능', '불가', '알수없음'], description: '취소 가능 여부' },
    cancelDeadline: { type: 'string', description: '취소 가능 마감 일시(원문 표현 그대로). 모르면 빈 문자열' },
    contactPhone: { type: 'string', description: '문의 연락처. 모르면 빈 문자열' },
    homepageUrl: { type: 'string', description: '골프장/예약 홈페이지 링크. 모르면 빈 문자열' },
    bookingNumber: { type: 'string', description: '예약번호. 모르면 빈 문자열' },
  },
  required: [
    'reservationType', 'courseName', 'courseSubName', 'roundDate', 'roundTime', 'reservationName',
    'companions', 'greenFeeAmount', 'paymentMethod', 'cancelable', 'cancelDeadline',
    'contactPhone', 'homepageUrl', 'bookingNumber',
  ],
  additionalProperties: false,
};

const PROMPT = `아래는 골프장 또는 예약 플랫폼(골팡 등)에서 받은 예약확정 카카오톡/문자 메시지입니다.
골프장마다 표기 형식이 크게 달라도 최대한 정확히 읽어서 정보를 추출해주세요.
- "조인" 모집 관련 메시지인 경우 예약자(모집자)와 별개로 동반인원 정보가 있으면 companions에 넣어주세요.
- 조인 메시지는 대부분 "취소 불가 + 예약금 송금" 정책이니, 명시적으로 취소 가능하다는 언급이 없으면 cancelable은 "불가" 또는 "알수없음"으로 판단하세요.
- 날짜는 반드시 YYYY-MM-DD 형식으로 정규화하세요 (연도가 없으면 가장 가까운 미래 날짜로 추정).

메시지:
"""
{{MESSAGE}}
"""`;

export async function parseBookingMessage(env, text) {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY가 설정되지 않았습니다 (wrangler secret put ANTHROPIC_API_KEY)');
  }
  if (!text || !text.trim()) {
    throw new Error('분석할 메시지 내용이 필요합니다');
  }

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
          content: PROMPT.replace('{{MESSAGE}}', text.slice(0, 4000)),
        },
      ],
      output_config: {
        format: { type: 'json_schema', schema: BOOKING_MESSAGE_SCHEMA },
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`메시지 분석 API 호출 실패: HTTP ${res.status} ${errText.slice(0, 300)}`);
  }
  const data = await res.json();

  if (data.stop_reason === 'refusal') {
    throw new Error('메시지 분석 요청이 거부되었습니다 (안전 정책)');
  }

  const textBlock = (data.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('분석 결과를 받지 못했습니다');

  let parsed;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch {
    throw new Error('분석 결과 JSON 파싱에 실패했습니다');
  }

  if (parsed.greenFeeAmount === -1) parsed.greenFeeAmount = null;
  return parsed;
}
