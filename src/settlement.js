// 라운딩 정산 계산 (기획서 3-1 동반자 정산 로직).
// splitType: 'individual'(그린피/카트비 등 각자 결제 - 정산 대상 제외) |
//            'all'(식사/간식/뒤풀이 등 전원 1/N) | 'selected'(캐디피처럼 탄 사람만 선택 정산)

function won(n) {
  return Math.round(n).toLocaleString('ko-KR') + '원';
}

/** 각 항목의 부담 인원에게 배분해 1인당 owed(부담액)를 누적하고, paidBy가 있으면 paid(선결제액)를 누적 */
function accumulate(items, participants) {
  const owed = Object.fromEntries(participants.map((p) => [p, 0]));
  const paid = Object.fromEntries(participants.map((p) => [p, 0]));
  const breakdown = [];

  for (const item of items) {
    const amount = Number(item.amount) || 0;
    if (item.splitType === 'individual') {
      breakdown.push({ label: item.label, amount, splitType: 'individual', perPerson: null, targets: [] });
      continue;
    }
    const targets = item.splitType === 'all' ? participants : (item.selectedNames || []).filter((n) => participants.includes(n));
    if (!targets.length) continue;
    const perPerson = amount / targets.length;
    for (const name of targets) owed[name] = (owed[name] || 0) + perPerson;
    if (item.paidBy && participants.includes(item.paidBy)) {
      paid[item.paidBy] = (paid[item.paidBy] || 0) + amount;
    }
    breakdown.push({ label: item.label, amount, splitType: item.splitType, perPerson, targets, paidBy: item.paidBy || null });
  }

  return { owed, paid, breakdown };
}

/** 순잔액(net = paid - owed)을 최소 송금 횟수로 정산하는 그리디 매칭 */
function settleBalances(net) {
  const creditors = Object.entries(net)
    .filter(([, v]) => v > 0.5)
    .map(([name, amount]) => ({ name, amount }))
    .sort((a, b) => b.amount - a.amount);
  const debtors = Object.entries(net)
    .filter(([, v]) => v < -0.5)
    .map(([name, amount]) => ({ name, amount: -amount }))
    .sort((a, b) => b.amount - a.amount);

  const transfers = [];
  let ci = 0;
  let di = 0;
  while (ci < creditors.length && di < debtors.length) {
    const c = creditors[ci];
    const d = debtors[di];
    const amount = Math.min(c.amount, d.amount);
    if (amount > 0.5) {
      transfers.push({ from: d.name, to: c.name, amount: Math.round(amount) });
    }
    c.amount -= amount;
    d.amount -= amount;
    if (c.amount <= 0.5) ci++;
    if (d.amount <= 0.5) di++;
  }
  return transfers;
}

export function computeSettlement(input) {
  const participants = Array.isArray(input.participants) ? input.participants : [];
  const items = Array.isArray(input.items) ? input.items : [];
  if (!participants.length) throw new Error('participants(정산 인원)가 필요합니다');

  const { owed, paid, breakdown } = accumulate(items, participants);
  const net = Object.fromEntries(participants.map((p) => [p, (paid[p] || 0) - (owed[p] || 0)]));
  const transfers = settleBalances(net);

  const perPerson = participants.map((name) => ({
    name,
    owed: Math.round(owed[name] || 0),
    paid: Math.round(paid[name] || 0),
    net: Math.round(net[name] || 0), // 양수: 받을 돈, 음수: 보낼 돈
  }));

  const kakaoMessage = buildKakaoMessage(input, breakdown, transfers);

  return { breakdown, perPerson, transfers, kakaoMessage };
}

function buildKakaoMessage(input, breakdown, transfers) {
  const lines = [];
  lines.push(`⛳ ${input.courseName || '라운딩'} 정산 결과${input.date ? ` (${input.date})` : ''}`);
  lines.push('─────────────');
  for (const b of breakdown) {
    if (b.splitType === 'individual') {
      lines.push(`- ${b.label} ${won(b.amount)}: 각자 결제`);
    } else {
      const who = b.paidBy ? ` - ${b.paidBy} 결제` : '';
      lines.push(`- ${b.label} ${won(b.amount)} (${b.targets.length}인 분할, 1인 ${won(b.perPerson)})${who}`);
    }
  }
  lines.push('─────────────');
  if (!transfers.length) {
    lines.push('정산할 금액이 없습니다 (완전히 맞음)');
  } else {
    for (const t of transfers) {
      lines.push(`- ${t.from} → ${t.to} ${won(t.amount)}`);
    }
  }
  return lines.join('\n');
}
