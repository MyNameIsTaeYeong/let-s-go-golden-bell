const socket = connect();

let me = { token: localStorage.getItem('gb_token') || null, name: localStorage.getItem('gb_name') || '', alive: true };
let current = { question: null, phase: 'lobby', submitted: false, selected: null };
let timerHandle = null;

const joinView = $('#joinView');
const gameView = $('#gameView');
const nameInput = $('#nameInput');
if (me.name) nameInput.value = me.name;

$('#joinBtn').addEventListener('click', doJoin);
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });

function doJoin() {
  const name = nameInput.value.trim();
  if (!name) { toast('이름을 입력해주세요'); return; }
  socket.emit('join', { name, token: me.token }, (res) => {
    me.token = res.token;
    me.name = res.name;
    localStorage.setItem('gb_token', me.token);
    localStorage.setItem('gb_name', me.name);
    joinView.classList.add('hidden');
    gameView.classList.remove('hidden');
    $('#meName').textContent = '👤 ' + me.name;
  });
}

// 새로고침 후 자동 재입장
if (me.token && me.name) {
  socket.on('connect', () => {
    socket.emit('join', { name: me.name, token: me.token }, (res) => {
      me.token = res.token;
      me.name = res.name;
      joinView.classList.add('hidden');
      gameView.classList.remove('hidden');
      $('#meName').textContent = '👤 ' + me.name;
    });
  });
}

socket.on('state', (s) => {
  current.phase = s.phase;
  current.question = s.question;
  if (s.you) me.alive = s.you.alive;

  const questionCard = $('#questionCard');
  const banner = $('#bannerArea');

  if (s.phase === 'lobby') {
    questionCard.classList.add('hidden');
    banner.innerHTML = '';
    banner.appendChild(el('div', { class: 'banner wait', text: '⏳ 게임 시작을 기다리는 중...' }));
    return;
  }

  if (s.phase === 'finished') {
    questionCard.classList.add('hidden');
    banner.innerHTML = '';
    if (me.alive) {
      banner.appendChild(el('div', { class: 'banner alive pop', text: '🎉 골든벨! 끝까지 살아남았어요!' }));
    } else {
      banner.appendChild(el('div', { class: 'banner dead', text: '게임 종료! 수고하셨습니다 👏' }));
    }
    return;
  }

  // 탈락자는 문제 안 보여주고 관전 안내
  if (!me.alive) {
    questionCard.classList.add('hidden');
    banner.innerHTML = '';
    banner.appendChild(el('div', { class: 'banner dead', text: '아쉽지만 탈락했어요 😢 대형 화면으로 관전해주세요!' }));
    return;
  }

  banner.innerHTML = '';
  renderQuestion(s);
});

socket.on('results', (r) => {
  // reveal 단계: 내 정답 여부 표시
  if (current.phase !== 'reveal') return;
  if (!me.alive) return; // state에서 처리됨
  const mine = r.detail.find((d) => d.token === me.token);
  const banner = $('#bannerArea');
  banner.innerHTML = '';
  if (mine && mine.correct) {
    banner.appendChild(el('div', { class: 'banner alive pop', text: '⭕ 정답! 통과 🎉' }));
  } else {
    banner.appendChild(el('div', { class: 'banner dead', text: '❌ 오답! 정답: ' + r.answer }));
  }
  // 객관식 정답 표시
  highlightCorrect(r.answer);
});

function renderQuestion(s) {
  const q = s.question;
  const questionCard = $('#questionCard');
  if (!q) { questionCard.classList.add('hidden'); return; }

  // 새 문제로 바뀌면 선택/제출 초기화
  if (!current._lastQid || current._lastQid !== q.id) {
    current._lastQid = q.id;
    current.submitted = false;
    current.selected = null;
  }

  questionCard.classList.remove('hidden');
  $('#qProgress').textContent = `문제 ${q.index + 1} / ${q.total}`;
  $('#qText').textContent = q.text;

  // 타이머
  if (timerHandle) clearInterval(timerHandle);
  if (s.phase === 'question' && s.timerEndsAt) {
    timerHandle = startTimerBar($('#timerBar'), $('#qTimer'), s.timerEndsAt, q.timeLimitSec);
  } else {
    $('#qTimer').textContent = s.phase === 'locked' ? '마감됨' : '대기';
    if (s.phase === 'locked') $('#timerBar').style.width = '0%';
  }

  const area = $('#answerArea');
  area.innerHTML = '';
  const locked = s.phase !== 'question' || current.submitted;

  if (q.type === 'multiple') {
    const grid = el('div', { class: 'choices' });
    q.choices.forEach((c) => {
      const btn = el('button', {
        class: 'choice' + (current.selected === c ? ' selected' : ''),
        text: c,
      });
      btn.disabled = locked;
      btn.addEventListener('click', () => submit(q.id, c));
      grid.appendChild(btn);
    });
    area.appendChild(grid);
  } else {
    const input = el('input', { type: 'text', id: 'shortInput', placeholder: '정답 입력', maxlength: '200' });
    input.disabled = locked;
    if (current.selected) input.value = current.selected;
    const btn = el('button', { class: 'btn-full', text: current.submitted ? '제출 완료 ✓' : '제출하기' });
    btn.disabled = locked;
    btn.addEventListener('click', () => submit(q.id, $('#shortInput').value.trim()));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !locked) submit(q.id, input.value.trim()); });
    area.appendChild(input);
    area.appendChild(btn);
  }

  if (current.submitted) {
    area.appendChild(el('div', { class: 'muted center', text: '제출했어요! 결과를 기다려주세요.', style: 'margin-top:12px;' }));
  }
}

function submit(qid, answer) {
  if (!answer) { toast('답을 선택/입력해주세요'); return; }
  current.selected = answer;
  socket.emit('submitAnswer', { questionId: qid, answer }, (res) => {
    if (res && res.ok) {
      current.submitted = true;
      toast('제출 완료!');
      // 다시 렌더하여 잠금
      renderQuestion({ phase: current.phase, question: current.question, timerEndsAt: null });
    } else {
      toast('제출 실패: ' + (res ? res.reason : 'unknown'));
    }
  });
}

function highlightCorrect(answer) {
  $all('.choice').forEach((b) => {
    if (b.textContent === answer) b.classList.add('correct');
    else if (b.classList.contains('selected')) b.classList.add('wrong');
    b.disabled = true;
  });
}
