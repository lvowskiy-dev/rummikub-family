const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

// ── Tiles ─────────────────────────────────────────────────
function makeTiles() {
  const colors = ['red', 'blue', 'black', 'orange'];
  const tiles = [];
  let id = 0;
  for (let s = 0; s < 2; s++)
    for (const color of colors)
      for (let n = 1; n <= 13; n++)
        tiles.push({ id: id++, color, number: n, isJoker: false });
  tiles.push({ id: id++, color: 'joker', number: null, isJoker: true });
  tiles.push({ id: id++, color: 'joker', number: null, isJoker: true });
  return tiles;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 4 }, () => c[Math.floor(Math.random() * c.length)]).join('');
}

// ── Validation ────────────────────────────────────────────
function isValidGroup(tiles) {
  if (tiles.length < 3 || tiles.length > 4) return false;
  const real = tiles.filter(t => !t.isJoker);
  if (real.length === 0) return false;
  const num = real[0].number;
  if (!real.every(t => t.number === num)) return false;
  const cols = real.map(t => t.color);
  return new Set(cols).size === cols.length;
}

function isValidRun(tiles) {
  if (tiles.length < 3) return false;
  const real = tiles.filter(t => !t.isJoker);
  if (real.length === 0) return false;
  const color = real[0].color;
  if (!real.every(t => t.color === color)) return false;
  const nums = real.map(t => t.number);
  if (new Set(nums).size !== nums.length) return false;
  const sorted = [...real].sort((a, b) => a.number - b.number);
  const min = sorted[0].number;
  const max = sorted[sorted.length - 1].number;
  return max - min + 1 === tiles.length && min >= 1 && max <= 13;
}

function isValidSet(tiles) {
  return tiles && tiles.length >= 3 && (isValidGroup(tiles) || isValidRun(tiles));
}

function isValidBoard(board) {
  return board.every(set => set.length > 0 && isValidSet(set));
}

function tileValue(t) { return t.isJoker ? 30 : t.number; }

// ── Broadcast ─────────────────────────────────────────────
function publicState(room) {
  return {
    phase: room.phase,
    currentPlayerIndex: room.currentPlayerIndex,
    board: room.board,
    poolCount: room.pool.length,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      tileCount: p.rack.length,
      hasInitialMeld: p.hasInitialMeld,
    })),
    winner: room.winner,
    log: room.log,
  };
}

function broadcastState(room) {
  io.to(room.code).emit('game_state', publicState(room));
  for (const p of room.players)
    io.to(p.id).emit('your_rack', p.rack);
}

function nextTurn(room) {
  do {
    room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length;
  } while (false);
  const cur = room.players[room.currentPlayerIndex];
  room.turnBoardSnap = JSON.parse(JSON.stringify(room.board));
  broadcastState(room);
  io.to(cur.id).emit('your_turn', { snap: room.turnBoardSnap });
}

function addLog(room, msg) {
  room.log = room.log || [];
  room.log.unshift({ msg, ts: Date.now() });
  if (room.log.length > 30) room.log.pop();
}

// ── Sockets ───────────────────────────────────────────────
io.on('connection', socket => {

  socket.on('create_room', ({ name }) => {
    name = String(name).trim().slice(0, 16) || 'Player';
    let code;
    do { code = genCode(); } while (rooms.has(code));

    const room = {
      code, phase: 'lobby',
      players: [{ id: socket.id, name, rack: [], hasInitialMeld: false }],
      pool: [], board: [], currentPlayerIndex: 0,
      turnBoardSnap: [], winner: null, log: [],
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data = { roomCode: code, name };
    socket.emit('room_created', { code });
    io.to(code).emit('lobby_update', { players: room.players.map(p => p.name), host: room.players[0].name });
  });

  socket.on('join_room', ({ code, name }) => {
    code = String(code).trim().toUpperCase();
    name = String(name).trim().slice(0, 16) || 'Player';
    const room = rooms.get(code);
    if (!room) return socket.emit('error_msg', 'Комната не найдена');
    if (room.phase !== 'lobby') return socket.emit('error_msg', 'Игра уже идёт');
    if (room.players.length >= 4) return socket.emit('error_msg', 'Максимум 4 игрока');
    if (room.players.some(p => p.id === socket.id)) return;

    room.players.push({ id: socket.id, name, rack: [], hasInitialMeld: false });
    socket.join(code);
    socket.data = { roomCode: code, name };
    socket.emit('room_joined', { code });
    io.to(code).emit('lobby_update', { players: room.players.map(p => p.name), host: room.players[0].name });
  });

  socket.on('start_game', () => {
    const room = rooms.get(socket.data?.roomCode);
    if (!room || room.players[0].id !== socket.id) return;
    if (room.players.length < 2) return socket.emit('error_msg', 'Нужно минимум 2 игрока');

    const tiles = shuffle(makeTiles());
    for (const p of room.players) p.rack = tiles.splice(0, 14);
    room.pool = tiles;
    room.board = [];
    room.phase = 'playing';
    room.currentPlayerIndex = 0;
    room.winner = null;
    room.log = [];
    room.turnBoardSnap = [];

    addLog(room, `Игра началась! Ходит ${room.players[0].name}`);
    io.to(room.code).emit('game_started');
    setTimeout(() => {
      broadcastState(room);
      io.to(room.players[0].id).emit('your_turn', { snap: [] });
    }, 200);
  });

  socket.on('draw_tile', () => {
    const room = rooms.get(socket.data?.roomCode);
    if (!room || room.phase !== 'playing') return;
    const player = room.players[room.currentPlayerIndex];
    if (player.id !== socket.id) return socket.emit('error_msg', 'Не ваш ход');
    if (room.pool.length === 0) return socket.emit('error_msg', 'Мешок пуст!');

    const tile = room.pool.pop();
    player.rack.push(tile);
    addLog(room, `${player.name} берёт фишку из мешка`);
    socket.emit('drew_tile', tile);
    nextTurn(room);
  });

  socket.on('end_turn', ({ board }) => {
    const room = rooms.get(socket.data?.roomCode);
    if (!room || room.phase !== 'playing') return;
    const player = room.players[room.currentPlayerIndex];
    if (player.id !== socket.id) return socket.emit('error_msg', 'Не ваш ход');

    // Remove empty sets
    const cleanBoard = board.filter(set => set.length > 0);

    if (!isValidBoard(cleanBoard)) {
      return socket.emit('invalid_move', 'Доска невалидна — исправь ряды (группы или серии по 3+)');
    }

    // Collect all tile IDs on board
    const boardTileIds = new Set(cleanBoard.flat().map(t => t.id));
    const origBoardIds = new Set(room.turnBoardSnap.flat().map(t => t.id));
    const rackIds = new Set(player.rack.map(t => t.id));

    // All new tiles on board must come from this player's rack
    const addedIds = [...boardTileIds].filter(id => !origBoardIds.has(id));
    for (const id of addedIds) {
      if (!rackIds.has(id)) return socket.emit('invalid_move', 'Нельзя играть чужие фишки');
    }

    // All original board tiles must still be on board
    for (const id of origBoardIds) {
      if (!boardTileIds.has(id)) return socket.emit('invalid_move', 'Нельзя убирать чужие фишки с доски');
    }

    if (addedIds.length === 0) {
      return socket.emit('invalid_move', 'Сыграй хотя бы одну фишку или возьми из мешка');
    }

    // Initial meld check
    if (!player.hasInitialMeld) {
      // Can only place tiles in NEW sets (not extend existing ones)
      // Check all original sets are untouched
      const origSets = room.turnBoardSnap;
      for (let i = 0; i < origSets.length; i++) {
        const origSetIds = new Set(origSets[i].map(t => t.id));
        // Find this set in new board
        const found = cleanBoard.find(set => set.some(t => origSetIds.has(t.id)));
        if (!found) return socket.emit('invalid_move', 'До первого хода нельзя трогать чужие фишки');
        const foundIds = new Set(found.map(t => t.id));
        for (const id of origSetIds) {
          if (!foundIds.has(id)) return socket.emit('invalid_move', 'До первого хода нельзя трогать чужие фишки');
        }
        // No added tiles to existing sets
        for (const id of foundIds) {
          if (!origSetIds.has(id)) return socket.emit('invalid_move', 'До первого хода нельзя добавлять к чужим сетам');
        }
      }
      // Sum of played tiles must be ≥ 30
      const played = addedIds.map(id => player.rack.find(t => t.id === id));
      const val = played.reduce((s, t) => s + tileValue(t), 0);
      if (val < 30) return socket.emit('invalid_move', `Первый выход: нужно ≥30 очков. У тебя ${val}`);
      player.hasInitialMeld = true;
    }

    // Apply move
    room.board = cleanBoard;
    player.rack = player.rack.filter(t => !addedIds.includes(t.id));

    addLog(room, `${player.name} сыграл ${addedIds.length} фишк${addedIds.length === 1 ? 'у' : 'и'}`);

    if (player.rack.length === 0) {
      room.phase = 'ended';
      room.winner = { name: player.name, id: player.id };
      addLog(room, `🏆 ${player.name} ПОБЕДИЛ!`);
      broadcastState(room);
      io.to(room.code).emit('game_over', { winner: player.name });
      return;
    }

    nextTurn(room);
  });

  socket.on('restart_game', () => {
    const room = rooms.get(socket.data?.roomCode);
    if (!room || room.players[0].id !== socket.id) return;
    room.phase = 'lobby';
    for (const p of room.players) {
      p.rack = [];
      p.hasInitialMeld = false;
    }
    room.board = [];
    room.pool = [];
    room.winner = null;
    room.log = [];
    io.to(room.code).emit('lobby_update', { players: room.players.map(p => p.name), host: room.players[0].name });
  });

  socket.on('chat', ({ msg }) => {
    const room = rooms.get(socket.data?.roomCode);
    if (!room) return;
    const name = socket.data.name || '?';
    io.to(room.code).emit('chat_msg', { name, msg: String(msg).slice(0, 100) });
  });

  socket.on('disconnect', () => {
    const code = socket.data?.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    if (room.phase === 'lobby') {
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.players.length === 0) { rooms.delete(code); return; }
      io.to(code).emit('lobby_update', { players: room.players.map(p => p.name), host: room.players[0].name });
    } else {
      io.to(code).emit('player_left', { name: socket.data.name });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎲 Rummikub → http://localhost:${PORT}`));
