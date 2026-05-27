const socket = connect();

let state = { phase: 'lobby' };
let players = [];
let timerHandle = null;

$('#joinUrl').textContent = location.host + '  (참가자 페이지)';

socket.on('connect', () => socket.emit('screen:hello'));

socket.on('players', (p) => {
  players = p;
  $('#lobbyCount').textContent = p.length;
  if (state.phase === 'finished') renderWinners();
});

socket.on('liveCount', (c) => {
  $('#sSubmitCount').textContent = c.submitted;
});

socket.on('state', (s) => {
  state = s;
  show(s.phase);

  if (s.phase === 'question' || s.phase === 'locked' || s.phase === 'reveal') {
    renderQuestion(s);
  }
  if (s.phase === 'finished') renderWinners();
});

socket.on('results', (r) => {
  if (state.phase !== 'reveal') return;
  // 객관식 정답 강조
  $all('.screen-choice').forEach((c) => {
    if (c.dataset.value === String(r.answer)) c.classList.add('correct');
  });
});

function show(phase) {
  $('#lobbyView').classList.toggle('hidden', phase !== 'lobby');
  $('#questionView').classList.toggle('hidden', !(phase === 'question' || phase === 'locked' || phase === 'reveal'));
  $('#finishView').classList.toggle('hidden', phase !== 'finished');
}

function renderQuestion(s) {
  const q = s.question;
  if (!q) return;
  $('#sProgress').textContent = `문제 ${q.index + 1} / ${q.total}`;
  $('#sAlive').textContent = `생존 ${s.aliveCount}명`;
  $('#sQuestion').textContent = q.text;

  if (timerHandle) clearInterval(timerHandle);
  if (s.phase === 'question' && s.timerEndsAt) {
    timerHandle = startTimerBar($('#sTimerBar'), $('#sTimer'), s.timerEndsAt, q.timeLimitSec);
  } else {
    $('#sTimer').textContent = s.phase === 'locked' ? '마감' : (s.phase === 'reveal' ? '정답 공개' : '대기');
    if (s.phase !== 'question') $('#sTimerBar').style.width = '0%';
  }

  const box = $('#sChoices');
  box.innerHTML = '';
  if (q.type === 'multiple') {
    q.choices.forEach((c, i) => {
      const node = el('div', { class: 'screen-choice', text: `${'①②③④⑤⑥'[i] || (i + 1)} ${c}` });
      node.dataset.value = c;
      box.appendChild(node);
    });
  } else {
    box.appendChild(el('div', { class: 'muted center', text: '✍️ 주관식 — 휴대폰에 정답을 입력하세요', style: 'grid-column:1/-1;font-size:24px;' }));
  }
}

function renderWinners() {
  const box = $('#winners');
  box.innerHTML = '';
  const alive = players.filter((p) => p.alive);
  if (alive.length === 0) {
    box.appendChild(el('div', { class: 'muted', text: '최후의 생존자가 없습니다 😅', style: 'grid-column:1/-1;font-size:22px;' }));
    return;
  }
  alive.forEach((p) => {
    box.appendChild(el('div', { class: 'player-chip correct pop', text: '🏅 ' + p.name }));
  });
}
