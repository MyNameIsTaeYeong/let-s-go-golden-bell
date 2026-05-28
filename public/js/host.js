const socket = connect();

let questions = [];
let state = { phase: 'lobby', question: null };
let lastResults = null;

// ---- 탭 전환 ----
$('#tabPlay').addEventListener('click', () => switchTab('play'));
$('#tabEdit').addEventListener('click', () => switchTab('edit'));
function switchTab(t) {
  $('#tabPlay').classList.toggle('active', t === 'play');
  $('#tabEdit').classList.toggle('active', t === 'edit');
  $('#playPanel').classList.toggle('hidden', t !== 'play');
  $('#editPanel').classList.toggle('hidden', t !== 'edit');
}

// ---- 연결 ----
socket.on('connect', () => {
  socket.emit('host:hello', {}, (res) => {
    if (res && res.questions) { questions = res.questions; renderQuestionList(); }
  });
});

socket.on('questions', (qs) => { questions = qs; renderQuestionList(); });

socket.on('state', (s) => {
  state = s;
  const phaseMap = { lobby: '대기', question: '문제 진행', locked: '마감', reveal: '정답 공개', finished: '종료' };
  $('#phaseLabel').textContent = phaseMap[s.phase] || s.phase;
  $('#progressLabel').textContent = s.phase === 'lobby' ? '-' : `${(s.currentIndex ?? -1) + 1}/${s.total}`;
  $('#aliveLabel').textContent = s.aliveCount ?? 0;

  const cur = $('#curQuestion');
  const ans = $('#curAnswer');
  if (s.question) {
    cur.textContent = s.question.text;
    cur.classList.remove('muted');
  } else {
    cur.textContent = s.phase === 'finished' ? '게임이 종료되었습니다.' : '게임을 시작하세요.';
    cur.classList.add('muted');
  }
  // 정답은 reveal 단계에서만 (results에서 채워짐)
  if (s.phase !== 'reveal') ans.classList.add('hidden');

  // 대리 참가자 추가 폼은 lobby 단계에서만 노출
  $('#proxyForm').classList.toggle('hidden', s.phase !== 'lobby');
  $('#proxyHint').classList.toggle('hidden', s.phase !== 'lobby');
});

socket.on('liveCount', (c) => {
  $('#submitLabel').textContent = `${c.submitted}/${c.alive}`;
});

socket.on('players', (players) => {
  renderPlayers(players);
});

socket.on('results', (r) => {
  lastResults = r;
  if (r.answer != null) {
    const ans = $('#curAnswer');
    ans.textContent = '정답: ' + r.answer;
    ans.classList.remove('hidden');
  }
  renderPlayersFromResults(r);
});

// ---- 게임 컨트롤 ----
$('#btnStart').addEventListener('click', () => {
  if (questions.length === 0) { toast('먼저 문제를 추가하세요'); switchTab('edit'); return; }
  socket.emit('game:start');
});
$('#btnTimer').addEventListener('click', () => socket.emit('timer:start'));
$('#btnLock').addEventListener('click', () => socket.emit('answers:lock'));
$('#btnReveal').addEventListener('click', () => socket.emit('answer:reveal'));
$('#btnNext').addEventListener('click', () => socket.emit('game:next'));
$('#btnRevive').addEventListener('click', () => { if (confirm('탈락자 전원을 부활시킬까요?')) socket.emit('game:revive'); });
$('#btnReset').addEventListener('click', () => { if (confirm('게임을 처음부터 다시 시작할까요?')) socket.emit('game:reset'); });

// ---- 대리 참가자 추가 ----
function addProxy() {
  const input = $('#proxyNameInput');
  const name = input.value.trim();
  if (!name) { toast('이름을 입력해주세요'); input.focus(); return; }
  socket.emit('host:addProxy', { name }, (res) => {
    if (res && res.ok) {
      input.value = '';
      input.focus();
      toast(`${name}님을 대리 참가자로 추가했어요`);
    } else {
      const reason = res && res.reason;
      const msg = reason === 'not-lobby' ? '게임 시작 전(lobby)에만 추가할 수 있어요'
        : reason === 'empty-name' ? '이름을 입력해주세요'
        : reason === 'forbidden' ? '권한이 없어요'
        : '추가 실패';
      toast(msg);
    }
  });
}
$('#btnAddProxy').addEventListener('click', addProxy);
$('#proxyNameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addProxy(); });

// 주관식 입력 보존용 (broadcastPlayers 재렌더로 글자가 날아가지 않도록)
const proxyDrafts = new Map();

function submitProxy(token, qid, answer) {
  if (!answer || !String(answer).trim()) { toast('답을 입력해주세요'); return; }
  socket.emit('host:proxySubmit', { token, questionId: qid, answer }, (res) => {
    if (res && res.ok) {
      proxyDrafts.delete(token);
      toast('대리 제출 완료');
    } else {
      const reason = res && res.reason;
      const msg = reason === 'already-submitted' ? '이미 제출된 답안이에요 (수정 불가)'
        : reason === 'eliminated' ? '이미 탈락한 참가자예요'
        : reason === 'closed' ? '제출 시간이 종료됐어요'
        : reason === 'no-question' ? '현재 문제와 맞지 않아요'
        : reason === 'not-proxy' ? '대리 참가자가 아니에요'
        : reason === 'forbidden' ? '권한이 없어요'
        : '제출 실패';
      toast(msg);
    }
  });
}

function proxyAnswerControls(player, question) {
  const box = el('div', { class: 'proxy-controls' });
  if (question.type === 'multiple') {
    const choicesBox = el('div', { class: 'proxy-choices' });
    (question.choices || []).forEach((choice) => {
      const btn = el('button', { class: 'proxy-choice', type: 'button', text: choice });
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        submitProxy(player.token, question.id, choice);
      });
      choicesBox.appendChild(btn);
    });
    box.appendChild(choicesBox);
  } else {
    const row = el('div', { class: 'proxy-short' });
    const input = el('input', { type: 'text', placeholder: '대리 답안', maxlength: '200' });
    const draft = proxyDrafts.get(player.token);
    if (draft) input.value = draft;
    input.addEventListener('input', () => { proxyDrafts.set(player.token, input.value); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submitProxy(player.token, question.id, input.value.trim()); }
    });
    input.addEventListener('click', (e) => e.stopPropagation());
    const btn = el('button', { class: 'proxy-choice', type: 'button', text: '제출' });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      submitProxy(player.token, question.id, input.value.trim());
    });
    row.appendChild(input);
    row.appendChild(btn);
    box.appendChild(row);
  }
  return box;
}

function proxyBadge() {
  return el('span', { class: 'proxy-badge', text: '📝', title: '대리 참가자' });
}

// ---- 참가자 렌더 ----
function kickButton(token, name) {
  const btn = el('button', { class: 'kick', type: 'button', text: '✕', title: '참가자 내보내기' });
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (confirm(`${name}님을 게임에서 내보낼까요?`)) {
      socket.emit('player:kick', { token });
    }
  });
  return btn;
}

function renderPlayers(players) {
  $('#playerCount').textContent = `(${players.filter(p => p.alive).length}명 생존 / 총 ${players.length}명)`;
  // reveal 단계면 results 기준 렌더가 우선
  if (state.phase === 'reveal' && lastResults) { renderPlayersFromResults(lastResults); return; }
  const grid = $('#playersGrid');
  grid.innerHTML = '';
  $('#overrideHint').textContent = '';
  if (players.length === 0) {
    grid.appendChild(el('div', { class: 'muted', text: '아직 참가자가 없습니다.' }));
    return;
  }
  players.forEach((p) => {
    const chip = el('div', { class: 'player-chip' + (p.alive ? '' : ' dead') + (p.proxy ? ' proxy' : '') });
    chip.appendChild(kickButton(p.token, p.name));
    if (p.proxy) chip.appendChild(proxyBadge());
    chip.appendChild(el('div', { text: p.name }));
    const tags = [];
    if (state.phase === 'question' && p.submitted) tags.push('제출✓');
    chip.appendChild(el('div', { class: 'muted', text: tags.join(' '), style: 'font-size:12px;' }));
    if (p.proxy && p.alive && state.phase === 'question' && !p.submitted && state.question) {
      chip.appendChild(proxyAnswerControls(p, state.question));
    }
    grid.appendChild(chip);
  });
}

function renderPlayersFromResults(r) {
  const grid = $('#playersGrid');
  grid.innerHTML = '';
  $('#overrideHint').textContent = '주관식은 채점이 애매할 수 있어요. 칩을 클릭하면 정답/오답을 직접 바꿀 수 있습니다.';
  r.detail.forEach((d) => {
    const chip = el('div', { class: 'player-chip ' + (d.correct ? 'correct' : 'wrong') + (d.alive ? '' : ' dead') + (d.proxy ? ' proxy' : '') });
    chip.appendChild(kickButton(d.token, d.name));
    if (d.proxy) chip.appendChild(proxyBadge());
    chip.appendChild(el('div', { text: d.name }));
    chip.appendChild(el('div', { class: 'muted', text: (d.answer ?? '(무응답)'), style: 'font-size:12px;' }));
    chip.style.cursor = 'pointer';
    chip.title = '클릭하여 정답/오답 전환';
    chip.addEventListener('click', () => {
      socket.emit('grade:override', { token: d.token, correct: !d.correct });
    });
    grid.appendChild(chip);
  });
}

// ====================== 문제 관리 ======================
const choiceInputs = $('#choiceInputs');

function choiceRow(value = '') {
  const wrap = el('div', { class: 'row', style: 'margin-bottom:8px;align-items:center;' });
  const input = el('input', { type: 'text', value, placeholder: '보기 내용', maxlength: '200' });
  input.classList.add('choice-input');
  const del = el('button', { class: 'danger', type: 'button', text: '삭제', style: 'flex:0 0 70px;' });
  del.addEventListener('click', () => wrap.remove());
  wrap.appendChild(input);
  wrap.appendChild(del);
  return wrap;
}

$('#addChoice').addEventListener('click', () => choiceInputs.appendChild(choiceRow()));

$('#qType').addEventListener('change', () => {
  $('#choicesBlock').classList.toggle('hidden', $('#qType').value !== 'multiple');
});

$('#clearForm').addEventListener('click', clearForm);
function clearForm() {
  $('#qId').value = '';
  $('#qTextInput').value = '';
  $('#qAnswerInput').value = '';
  $('#qTimeInput').value = '20';
  $('#qType').value = 'multiple';
  choiceInputs.innerHTML = '';
  choiceInputs.appendChild(choiceRow());
  choiceInputs.appendChild(choiceRow());
  $('#choicesBlock').classList.remove('hidden');
  $('#formTitle').textContent = '새 문제 추가';
}

$('#saveQuestion').addEventListener('click', () => {
  const type = $('#qType').value;
  const text = $('#qTextInput').value.trim();
  const answer = $('#qAnswerInput').value.trim();
  const timeLimitSec = Number($('#qTimeInput').value) || 20;
  if (!text) { toast('문제 내용을 입력하세요'); return; }
  if (!answer) { toast('정답을 입력하세요'); return; }

  let choices = [];
  if (type === 'multiple') {
    choices = $all('.choice-input').map((i) => i.value.trim()).filter(Boolean);
    if (choices.length < 2) { toast('보기를 2개 이상 입력하세요'); return; }
    if (!choices.includes(answer)) { toast('정답이 보기 중에 없습니다. 보기와 동일하게 입력하세요'); return; }
  }

  const payload = { type, text, answer, timeLimitSec, choices };
  const id = $('#qId').value;
  if (id) {
    payload.id = id;
    socket.emit('question:update', payload, () => { toast('수정되었습니다'); clearForm(); });
  } else {
    socket.emit('question:create', payload, () => { toast('추가되었습니다'); clearForm(); });
  }
});

function renderQuestionList() {
  const list = $('#questionList');
  $('#qCount').textContent = `(${questions.length}개)`;
  list.innerHTML = '';
  if (questions.length === 0) {
    list.appendChild(el('div', { class: 'muted', text: '문제가 없습니다. 위에서 추가하세요.' }));
    return;
  }
  questions.forEach((q, i) => {
    const item = el('div', { class: 'list-item' });
    item.appendChild(el('span', { class: 'tag ' + (q.type === 'multiple' ? 'sub' : 'alive'), text: q.type === 'multiple' ? '객관식' : '주관식' }));
    item.appendChild(el('span', { class: 'name', text: `${i + 1}. ${q.text}` }));
    item.appendChild(el('span', { class: 'muted', text: q.answer, style: 'font-size:13px;' }));
    const up = el('button', { class: 'ghost', text: '↑', style: 'flex:0 0 44px;' });
    const down = el('button', { class: 'ghost', text: '↓', style: 'flex:0 0 44px;' });
    const edit = el('button', { class: 'secondary', text: '수정', style: 'flex:0 0 64px;' });
    const del = el('button', { class: 'danger', text: '삭제', style: 'flex:0 0 64px;' });
    up.addEventListener('click', () => move(i, -1));
    down.addEventListener('click', () => move(i, 1));
    edit.addEventListener('click', () => loadForm(q));
    del.addEventListener('click', () => { if (confirm('삭제할까요?')) socket.emit('question:delete', { id: q.id }); });
    [up, down, edit, del].forEach((b) => item.appendChild(b));
    list.appendChild(item);
  });
}

function move(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= questions.length) return;
  const order = questions.map((q) => q.id);
  [order[i], order[j]] = [order[j], order[i]];
  socket.emit('question:reorder', { order });
}

function loadForm(q) {
  switchTab('edit');
  $('#qId').value = q.id;
  $('#qType').value = q.type;
  $('#qTextInput').value = q.text;
  $('#qAnswerInput').value = q.answer;
  $('#qTimeInput').value = q.timeLimitSec;
  choiceInputs.innerHTML = '';
  (q.choices && q.choices.length ? q.choices : ['', '']).forEach((c) => choiceInputs.appendChild(choiceRow(c)));
  $('#choicesBlock').classList.toggle('hidden', q.type !== 'multiple');
  $('#formTitle').textContent = '문제 수정';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

clearForm();
