const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'questions.json');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// 문제 영속화
// ---------------------------------------------------------------------------
function loadQuestions() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function saveQuestions() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(questions, null, 2), 'utf-8');
}

let questions = loadQuestions();

// ---------------------------------------------------------------------------
// 게임 상태 (서버가 단일 진실 소스)
// ---------------------------------------------------------------------------
// phase: lobby | question | locked | reveal | finished
const game = {
  phase: 'lobby',
  currentIndex: -1,
  timerEndsAt: null,
  // players: token -> { token, name, alive, socketId, answers: {questionId: {answer, correct}} }
  players: new Map(),
};

let timerHandle = null;

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

function normalize(str) {
  return String(str == null ? '' : str)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

function gradeAnswer(question, answer) {
  if (!question) return false;
  if (answer == null || answer === '') return false;
  if (question.type === 'multiple') {
    return String(answer) === String(question.answer);
  }
  return normalize(answer) === normalize(question.answer);
}

function currentQuestion() {
  if (game.currentIndex < 0 || game.currentIndex >= questions.length) return null;
  return questions[game.currentIndex];
}

// 참가자에게 보낼 때 정답은 제거
function publicQuestion(q) {
  if (!q) return null;
  return {
    id: q.id,
    type: q.type,
    text: q.text,
    choices: q.choices || [],
    timeLimitSec: q.timeLimitSec,
    index: game.currentIndex,
    total: questions.length,
  };
}

function playerList() {
  return Array.from(game.players.values()).map((p) => ({
    token: p.token,
    name: p.name,
    alive: p.alive,
    connected: !!p.socketId,
    submitted: hasSubmittedCurrent(p),
  }));
}

function hasSubmittedCurrent(player) {
  const q = currentQuestion();
  if (!q) return false;
  return Object.prototype.hasOwnProperty.call(player.answers, q.id);
}

function aliveCount() {
  return Array.from(game.players.values()).filter((p) => p.alive).length;
}

function submittedCount() {
  const q = currentQuestion();
  if (!q) return 0;
  return Array.from(game.players.values()).filter(
    (p) => p.alive && hasSubmittedCurrent(p)
  ).length;
}

// ---------------------------------------------------------------------------
// 브로드캐스트
// ---------------------------------------------------------------------------
function broadcastState() {
  const q = currentQuestion();
  const base = {
    phase: game.phase,
    currentIndex: game.currentIndex,
    total: questions.length,
    timerEndsAt: game.timerEndsAt,
    aliveCount: aliveCount(),
    totalPlayers: game.players.size,
    question: game.phase === 'lobby' ? null : publicQuestion(q),
  };
  // 참가자 소켓에는 본인 alive/submitted 정보를 함께 실어 보낸다
  for (const [, socket] of io.sockets.sockets) {
    const token = socket.data && socket.data.token;
    const p = token ? game.players.get(token) : null;
    if (p) {
      socket.emit('state', { ...base, you: { alive: p.alive, submitted: hasSubmittedCurrent(p) } });
    } else {
      socket.emit('state', base);
    }
  }
}

function broadcastPlayers() {
  io.emit('players', playerList());
  io.emit('liveCount', { submitted: submittedCount(), alive: aliveCount() });
}

// reveal 시: 정답 + 참가자별 채점 결과 (호스트/대형화면용)
function broadcastResults() {
  const q = currentQuestion();
  const detail = Array.from(game.players.values()).map((p) => {
    const a = p.answers[q ? q.id : ''];
    return {
      token: p.token,
      name: p.name,
      alive: p.alive,
      answer: a ? a.answer : null,
      correct: a ? a.correct : false,
    };
  });
  io.emit('results', {
    questionId: q ? q.id : null,
    answer: q ? q.answer : null,
    detail,
    aliveCount: aliveCount(),
  });
}

function clearTimer() {
  if (timerHandle) {
    clearTimeout(timerHandle);
    timerHandle = null;
  }
  game.timerEndsAt = null;
}

// ---------------------------------------------------------------------------
// 게임 진행 로직
// ---------------------------------------------------------------------------
function startGame() {
  if (questions.length === 0) return;
  for (const p of game.players.values()) {
    p.alive = true;
    p.answers = {};
  }
  game.currentIndex = -1;
  game.phase = 'lobby';
  nextQuestion();
}

function gradeCurrent() {
  const q = currentQuestion();
  if (!q) return;
  for (const p of game.players.values()) {
    if (!p.alive) continue;
    const a = p.answers[q.id];
    const correct = a ? !!a.correct : false;
    if (!correct) p.alive = false;
  }
}

function nextQuestion() {
  clearTimer();
  const next = game.currentIndex + 1;
  if (next >= questions.length) {
    // 마지막 문제에서 reveal을 건너뛴 채 종료되는 경우 자동 채점
    if (game.phase === 'question' || game.phase === 'locked') {
      gradeCurrent();
    }
    game.phase = 'finished';
    broadcastState();
    broadcastPlayers();
    broadcastResults();
    return;
  }
  game.currentIndex = next;
  game.phase = 'question';
  // 새 문제이므로 현재 답안 표시 초기화는 answers에 키가 없으면 자동
  broadcastState();
  broadcastPlayers();
}

function startTimer() {
  const q = currentQuestion();
  if (!q || game.phase !== 'question') return;
  clearTimer();
  const limit = Number(q.timeLimitSec) > 0 ? Number(q.timeLimitSec) : 20;
  game.timerEndsAt = Date.now() + limit * 1000;
  timerHandle = setTimeout(() => {
    lockAnswers();
  }, limit * 1000);
  broadcastState();
}

function lockAnswers() {
  clearTimer();
  if (game.phase === 'question') {
    game.phase = 'locked';
    broadcastState();
    broadcastPlayers();
  }
}

function revealAnswer() {
  clearTimer();
  if (!currentQuestion()) return;
  gradeCurrent();
  game.phase = 'reveal';
  broadcastState();
  broadcastPlayers();
  broadcastResults();
}

// 호스트 수동 정정: 주관식 등에서 정답/오답 토글
function gradeOverride(playerToken, makeCorrect) {
  const q = currentQuestion();
  if (!q || game.phase !== 'reveal') return;
  const p = game.players.get(playerToken);
  if (!p) return;
  if (!p.answers[q.id]) {
    p.answers[q.id] = { answer: '', correct: false };
  }
  p.answers[q.id].correct = !!makeCorrect;
  // 정답 처리 시 부활, 오답 처리 시 탈락
  p.alive = !!makeCorrect;
  broadcastPlayers();
  broadcastResults();
}

function reviveAll() {
  for (const p of game.players.values()) p.alive = true;
  broadcastState();
  broadcastPlayers();
}

function resetGame() {
  clearTimer();
  game.phase = 'lobby';
  game.currentIndex = -1;
  for (const p of game.players.values()) {
    p.alive = true;
    p.answers = {};
  }
  broadcastState();
  broadcastPlayers();
}

// ---------------------------------------------------------------------------
// Socket 핸들러
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  // --- 참가자 ---
  socket.on('join', ({ name, token }, cb) => {
    let player;
    if (token && game.players.has(token)) {
      player = game.players.get(token);
      player.socketId = socket.id;
      if (name) player.name = String(name).slice(0, 20);
    } else {
      const newToken = newId();
      player = {
        token: newToken,
        name: String(name || '익명').slice(0, 20),
        alive: true,
        socketId: socket.id,
        answers: {},
      };
      game.players.set(newToken, player);
    }
    socket.data.token = player.token;
    socket.data.role = 'participant';
    if (typeof cb === 'function') {
      cb({ token: player.token, name: player.name });
    }
    // 현재 진행 중인 문제가 있으면 바로 전송
    socket.emit('state', {
      phase: game.phase,
      currentIndex: game.currentIndex,
      total: questions.length,
      timerEndsAt: game.timerEndsAt,
      aliveCount: aliveCount(),
      totalPlayers: game.players.size,
      question: game.phase === 'lobby' ? null : publicQuestion(currentQuestion()),
      you: { alive: player.alive, submitted: hasSubmittedCurrent(player) },
    });
    broadcastPlayers();
  });

  socket.on('submitAnswer', ({ questionId, answer }, cb) => {
    const token = socket.data.token;
    const player = token && game.players.get(token);
    if (!player) return;
    const q = currentQuestion();
    if (!q || q.id !== questionId) {
      if (typeof cb === 'function') cb({ ok: false, reason: 'no-question' });
      return;
    }
    if (game.phase !== 'question') {
      if (typeof cb === 'function') cb({ ok: false, reason: 'closed' });
      return;
    }
    if (!player.alive) {
      if (typeof cb === 'function') cb({ ok: false, reason: 'eliminated' });
      return;
    }
    player.answers[q.id] = {
      answer: String(answer).slice(0, 200),
      correct: gradeAnswer(q, answer),
    };
    if (typeof cb === 'function') cb({ ok: true });
    io.emit('liveCount', { submitted: submittedCount(), alive: aliveCount() });
    broadcastPlayers();
  });

  // --- 호스트 / 대형화면 ---
  socket.on('host:hello', (_data, cb) => {
    socket.data.role = 'host';
    if (typeof cb === 'function') cb({ questions });
    socket.emit('state', {
      phase: game.phase,
      currentIndex: game.currentIndex,
      total: questions.length,
      timerEndsAt: game.timerEndsAt,
      aliveCount: aliveCount(),
      totalPlayers: game.players.size,
      question: publicQuestion(currentQuestion()),
    });
    socket.emit('players', playerList());
  });

  socket.on('screen:hello', () => {
    socket.data.role = 'screen';
    broadcastState();
    broadcastPlayers();
  });

  // 문제 CRUD
  socket.on('question:create', (q, cb) => {
    const item = {
      id: newId(),
      type: q.type === 'short' ? 'short' : 'multiple',
      text: String(q.text || '').slice(0, 500),
      choices: Array.isArray(q.choices) ? q.choices.map((c) => String(c).slice(0, 200)) : [],
      answer: String(q.answer || '').slice(0, 200),
      timeLimitSec: Number(q.timeLimitSec) > 0 ? Number(q.timeLimitSec) : 20,
    };
    questions.push(item);
    saveQuestions();
    io.emit('questions', questions);
    if (typeof cb === 'function') cb({ ok: true, questions });
  });

  socket.on('question:update', (q, cb) => {
    const idx = questions.findIndex((x) => x.id === q.id);
    if (idx === -1) {
      if (typeof cb === 'function') cb({ ok: false });
      return;
    }
    questions[idx] = {
      id: q.id,
      type: q.type === 'short' ? 'short' : 'multiple',
      text: String(q.text || '').slice(0, 500),
      choices: Array.isArray(q.choices) ? q.choices.map((c) => String(c).slice(0, 200)) : [],
      answer: String(q.answer || '').slice(0, 200),
      timeLimitSec: Number(q.timeLimitSec) > 0 ? Number(q.timeLimitSec) : 20,
    };
    saveQuestions();
    io.emit('questions', questions);
    if (typeof cb === 'function') cb({ ok: true, questions });
  });

  socket.on('question:delete', ({ id }, cb) => {
    questions = questions.filter((x) => x.id !== id);
    saveQuestions();
    io.emit('questions', questions);
    if (typeof cb === 'function') cb({ ok: true, questions });
  });

  socket.on('question:reorder', ({ order }, cb) => {
    if (Array.isArray(order)) {
      const map = new Map(questions.map((q) => [q.id, q]));
      const reordered = order.map((id) => map.get(id)).filter(Boolean);
      if (reordered.length === questions.length) {
        questions = reordered;
        saveQuestions();
        io.emit('questions', questions);
      }
    }
    if (typeof cb === 'function') cb({ ok: true, questions });
  });

  // 게임 컨트롤
  socket.on('game:start', () => startGame());
  socket.on('game:next', () => nextQuestion());
  socket.on('timer:start', () => startTimer());
  socket.on('answers:lock', () => lockAnswers());
  socket.on('answer:reveal', () => revealAnswer());
  socket.on('grade:override', ({ token, correct }) => gradeOverride(token, correct));
  socket.on('game:revive', () => reviveAll());
  socket.on('game:reset', () => resetGame());

  socket.on('disconnect', () => {
    if (socket.data.role === 'participant' && socket.data.token) {
      const p = game.players.get(socket.data.token);
      if (p && p.socketId === socket.id) {
        p.socketId = null;
        broadcastPlayers();
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n🔔 골든벨 서버 실행 중!`);
  console.log(`   호스트 화면 : http://localhost:${PORT}/host.html`);
  console.log(`   대형 화면   : http://localhost:${PORT}/screen.html`);
  console.log(`   참가자 접속 : http://<이PC의_사내IP>:${PORT}/\n`);
});
