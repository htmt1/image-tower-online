'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const Matter = require('matter-js');

const {
  Engine,
  Composite,
  Bodies,
  Body,
  Sleeping
} = Matter;

const PORT = Number(process.env.PORT || 3000);
const STAGE_W = 900;
const STAGE_H = 700;
const ISLAND_Y = 605;
const ISLAND_W = 560;
const DEFAULT_SPAWN_Y = 105;
const TICK_MS = 1000 / 60;
const SNAPSHOT_MS = 1000 / 20;
const ROOM_CODE_LENGTH = 6;

const characterData = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'public', 'characters.json'), 'utf8')
);
const characters = new Map(characterData.characters.map((c) => [c.id, c]));
const characterIds = characterData.characters.map((c) => c.id);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 10000,
  pingTimeout: 10000,
  maxHttpBufferSize: 1e6
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));
app.use((_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const rooms = new Map();

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeAngle(angle) {
  let a = Number(angle) || 0;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  const step = Math.PI / 12;
  return Math.round(a / step) * step;
}

function normalizeRoomCode(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[^0-9]/g, '')
    .slice(0, ROOM_CODE_LENGTH);
}

function roomCode() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    if (!rooms.has(code)) return code;
  }
  return String(Date.now()).slice(-ROOM_CODE_LENGTH);
}

function cleanName(name) {
  const value = String(name || '').replace(/[<>\n\r]/g, '').trim().slice(0, 14);
  return value || 'プレイヤー';
}

function randomCharacter(exceptId = null) {
  let id = characterIds[Math.floor(Math.random() * characterIds.length)];
  if (characterIds.length > 1) {
    let guard = 0;
    while (id === exceptId && guard < 8) {
      id = characterIds[Math.floor(Math.random() * characterIds.length)];
      guard += 1;
    }
  }
  return id;
}

function makeEngine() {
  const engine = Engine.create({ enableSleeping: true });
  engine.gravity.x = 0;
  engine.gravity.y = 1;
  engine.gravity.scale = 0.00105;
  return engine;
}

function addIsland(room) {
  const island = Bodies.trapezoid(STAGE_W / 2, ISLAND_Y, ISLAND_W, 48, 0.30, {
    isStatic: true,
    label: 'island',
    friction: 0.96,
    frictionStatic: 1.0,
    restitution: 0.02
  });
  room.island = island;
  Composite.add(room.engine.world, island);
}

function makeRoom(code) {
  const room = {
    code,
    players: [],
    engine: makeEngine(),
    island: null,
    objects: new Map(),
    objectCounter: 1,
    status: 'waiting',
    turnIndex: 0,
    currentCharacterId: randomCharacter(),
    nextCharacterId: randomCharacter(),
    aim: { x: STAGE_W / 2, angle: 0 },
    spawnY: DEFAULT_SPAWN_Y,
    droppedObjectId: null,
    lastDropAt: 0,
    stableSince: null,
    winnerId: null,
    loserId: null,
    endReason: null,
    rematchReady: new Set(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastSnapshotAt: 0
  };
  addIsland(room);
  return room;
}

function createPart(config, part, centerX, centerY) {
  const w = config.displayWidth;
  const h = config.displayHeight;
  const px = centerX + part.x * w;
  const py = centerY + part.y * h;
  const angle = (part.angle || 0) * Math.PI / 180;
  const common = {
    friction: config.friction,
    frictionStatic: config.frictionStatic,
    restitution: config.restitution,
    frictionAir: 0.006,
    density: 0.001
  };

  let body;
  if (part.type === 'circle') {
    body = Bodies.circle(px, py, Math.max(4, part.r * Math.min(w, h)), common);
  } else if (part.type === 'poly') {
    body = Bodies.polygon(
      px,
      py,
      Math.max(3, Math.round(part.sides || 3)),
      Math.max(5, part.r * Math.min(w, h)),
      common
    );
  } else {
    const pw = Math.max(7, part.w * w);
    const ph = Math.max(7, part.h * h);
    const round = clamp(Number(part.round || 0), 0, 0.49);
    const radius = round > 0 ? Math.min(pw, ph) * round : 0;
    body = Bodies.rectangle(px, py, pw, ph, {
      ...common,
      ...(radius > 0 ? { chamfer: { radius } } : {})
    });
  }

  if (angle) Body.setAngle(body, angle);
  return body;
}

function createCharacterBody(characterId, centerX, centerY, globalAngle, ownerId, objectId) {
  const config = characters.get(characterId);
  if (!config) throw new Error(`Unknown character: ${characterId}`);

  const parts = config.parts.map((part) => createPart(config, part, centerX, centerY));
  const body = Body.create({
    parts,
    label: `character-${characterId}`,
    friction: config.friction,
    frictionStatic: config.frictionStatic,
    restitution: config.restitution,
    frictionAir: 0.006,
    sleepThreshold: 55
  });

  const spriteOffsetX = centerX - body.position.x;
  const spriteOffsetY = centerY - body.position.y;
  const targetMass = clamp((config.displayWidth * config.displayHeight) / 7200, 1.4, 6.8) * (config.massScale || 1);
  Body.setMass(body, targetMass);
  Body.setInertia(body, body.inertia * 1.12);
  Body.setAngle(body, globalAngle);

  body.plugin.game = {
    objectId,
    characterId,
    ownerId,
    spriteOffsetX,
    spriteOffsetY
  };
  return body;
}

function rotatePoint(x, y, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: x * c - y * s, y: x * s + y * c };
}

function spriteCenter(body) {
  const meta = body.plugin.game;
  const offset = rotatePoint(meta.spriteOffsetX, meta.spriteOffsetY, body.angle);
  return { x: body.position.x + offset.x, y: body.position.y + offset.y };
}

function computeNextSpawnY(room) {
  if (room.objects.size === 0) return DEFAULT_SPAWN_Y;
  let highest = Infinity;
  for (const body of room.objects.values()) {
    highest = Math.min(highest, body.bounds.min.y);
  }
  if (!Number.isFinite(highest)) return DEFAULT_SPAWN_Y;
  return Math.min(DEFAULT_SPAWN_Y, highest - 165);
}

function beginMatch(room) {
  Composite.clear(room.engine.world, false, true);
  room.engine = makeEngine();
  room.objects.clear();
  room.objectCounter = 1;
  addIsland(room);
  room.status = 'playing';
  room.turnIndex = Math.random() < 0.5 ? 0 : 1;
  room.currentCharacterId = randomCharacter();
  room.nextCharacterId = randomCharacter(room.currentCharacterId);
  room.aim = { x: STAGE_W / 2, angle: 0 };
  room.spawnY = DEFAULT_SPAWN_Y;
  room.droppedObjectId = null;
  room.lastDropAt = 0;
  room.stableSince = null;
  room.winnerId = null;
  room.loserId = null;
  room.endReason = null;
  room.rematchReady.clear();
  room.updatedAt = Date.now();
  emitState(room, true);
}

function endMatch(room, loserId, reason = 'fall') {
  if (room.status !== 'playing') return;
  room.status = 'gameover';
  room.loserId = loserId || null;
  room.winnerId = room.players.find((p) => p.id !== loserId)?.id || null;
  room.endReason = reason;
  room.droppedObjectId = null;
  room.stableSince = null;
  room.updatedAt = Date.now();
  emitState(room, true);
}

function advanceTurn(room) {
  if (room.status !== 'playing' || room.players.length < 2) return;
  room.turnIndex = room.turnIndex === 0 ? 1 : 0;
  room.currentCharacterId = room.nextCharacterId;
  room.nextCharacterId = randomCharacter(room.currentCharacterId);
  room.spawnY = computeNextSpawnY(room);
  room.aim = { x: STAGE_W / 2, angle: 0 };
  room.droppedObjectId = null;
  room.lastDropAt = 0;
  room.stableSince = null;
  room.updatedAt = Date.now();
  emitState(room, true);
}

function currentPlayer(room) {
  return room.players[room.turnIndex] || null;
}

function serializeRoom(room) {
  const objects = [];
  for (const body of room.objects.values()) {
    const meta = body.plugin.game;
    objects.push({
      id: meta.objectId,
      characterId: meta.characterId,
      ownerId: meta.ownerId,
      x: Number(body.position.x.toFixed(3)),
      y: Number(body.position.y.toFixed(3)),
      angle: Number(body.angle.toFixed(5)),
      ox: Number(meta.spriteOffsetX.toFixed(3)),
      oy: Number(meta.spriteOffsetY.toFixed(3)),
      sleeping: Boolean(body.isSleeping)
    });
  }

  return {
    code: room.code,
    status: room.status,
    stage: { width: STAGE_W, height: STAGE_H, islandY: ISLAND_Y, islandWidth: ISLAND_W },
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      rematchReady: room.rematchReady.has(p.id)
    })),
    turnPlayerId: currentPlayer(room)?.id || null,
    currentCharacterId: room.currentCharacterId,
    nextCharacterId: room.nextCharacterId,
    aim: room.aim,
    spawnY: room.spawnY,
    hasDropped: room.droppedObjectId !== null,
    objects,
    winnerId: room.winnerId,
    loserId: room.loserId,
    endReason: room.endReason
  };
}

function emitState(room, force = false) {
  const now = Date.now();
  if (!force && now - room.lastSnapshotAt < SNAPSHOT_MS) return;
  room.lastSnapshotAt = now;
  io.to(room.code).emit('state', serializeRoom(room));
}

function tickRoom(room, now) {
  if (room.status !== 'playing') return;
  Engine.update(room.engine, TICK_MS);

  if (room.droppedObjectId !== null) {
    let fallen = false;
    for (const body of room.objects.values()) {
      const center = spriteCenter(body);
      if (
        body.position.y > ISLAND_Y + 205 ||
        center.y > ISLAND_Y + 220 ||
        body.position.x < -190 ||
        body.position.x > STAGE_W + 190
      ) {
        fallen = true;
        break;
      }
    }

    if (fallen) {
      endMatch(room, currentPlayer(room)?.id || null, 'fall');
      return;
    }

    const elapsed = now - room.lastDropAt;
    if (elapsed > 550) {
      let stable = true;
      for (const body of room.objects.values()) {
        if (body.isSleeping) continue;
        if (body.speed > 0.16 || Math.abs(body.angularSpeed) > 0.025) {
          stable = false;
          break;
        }
      }

      if (stable) {
        if (!room.stableSince) room.stableSince = now;
        if (now - room.stableSince > 720) advanceTurn(room);
      } else {
        room.stableSince = null;
      }

      if (elapsed > 9000 && room.status === 'playing' && room.droppedObjectId !== null) {
        for (const body of room.objects.values()) {
          Body.setVelocity(body, { x: 0, y: 0 });
          Body.setAngularVelocity(body, 0);
          Sleeping.set(body, true);
        }
        advanceTurn(room);
      }
    }
  }

  emitState(room, false);
}

function leaveCurrentRoom(socket, disconnected = false) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  socket.data.roomCode = null;
  if (!room) return;

  const leavingId = socket.id;
  const wasPlaying = room.status === 'playing';
  room.players = room.players.filter((p) => p.id !== leavingId);
  room.rematchReady.delete(leavingId);
  room.updatedAt = Date.now();

  if (wasPlaying && room.players.length === 1) {
    room.status = 'gameover';
    room.winnerId = room.players[0].id;
    room.loserId = leavingId;
    room.endReason = 'disconnect';
    room.droppedObjectId = null;
  } else if (room.players.length < 2 && room.status !== 'gameover') {
    room.status = 'waiting';
  }

  if (!disconnected) socket.leave(code);
  if (room.players.length === 0) {
    rooms.delete(code);
  } else {
    emitState(room, true);
  }
}

io.on('connection', (socket) => {
  socket.on('createRoom', (payload, ack = () => {}) => {
    try {
      leaveCurrentRoom(socket);
      const code = roomCode();
      const room = makeRoom(code);
      room.players.push({ id: socket.id, name: cleanName(payload?.name) });
      rooms.set(code, room);
      socket.join(code);
      socket.data.roomCode = code;
      ack({ ok: true, code });
      emitState(room, true);
    } catch (error) {
      ack({ ok: false, message: '部屋を作成できませんでした。' });
    }
  });

  socket.on('joinRoom', (payload, ack = () => {}) => {
    const code = normalizeRoomCode(payload?.code);
    if (code.length !== ROOM_CODE_LENGTH) return ack({ ok: false, message: '6桁の部屋番号を入力してください。' });
    const room = rooms.get(code);
    if (!room) return ack({ ok: false, message: 'その部屋は見つかりません。' });
    if (room.players.some((p) => p.id === socket.id)) return ack({ ok: true, code });
    if (room.players.length >= 2) return ack({ ok: false, message: 'その部屋は満員です。' });

    leaveCurrentRoom(socket);
    room.players.push({ id: socket.id, name: cleanName(payload?.name) });
    room.updatedAt = Date.now();
    socket.join(code);
    socket.data.roomCode = code;
    ack({ ok: true, code });

    if (room.players.length === 2) beginMatch(room);
    else emitState(room, true);
  });

  socket.on('leaveRoom', () => leaveCurrentRoom(socket));

  socket.on('aim', (payload) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'playing' || room.droppedObjectId !== null) return;
    if (currentPlayer(room)?.id !== socket.id) return;

    const config = characters.get(room.currentCharacterId);
    const margin = clamp(config.displayWidth * 0.34, 45, 130);
    room.aim = {
      x: clamp(Number(payload?.x) || STAGE_W / 2, margin, STAGE_W - margin),
      angle: normalizeAngle(payload?.angle)
    };
    room.updatedAt = Date.now();
  });

  socket.on('drop', (payload, ack = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'playing') return ack({ ok: false });
    if (currentPlayer(room)?.id !== socket.id) return ack({ ok: false });
    if (room.droppedObjectId !== null) return ack({ ok: false });

    const config = characters.get(room.currentCharacterId);
    const margin = clamp(config.displayWidth * 0.34, 45, 130);
    const x = clamp(Number(payload?.x) || room.aim.x, margin, STAGE_W - margin);
    const angle = normalizeAngle(payload?.angle ?? room.aim.angle);
    const objectId = room.objectCounter++;
    const body = createCharacterBody(
      room.currentCharacterId,
      x,
      room.spawnY,
      angle,
      socket.id,
      objectId
    );

    room.aim = { x, angle };
    room.objects.set(objectId, body);
    room.droppedObjectId = objectId;
    room.lastDropAt = Date.now();
    room.stableSince = null;
    room.updatedAt = Date.now();
    Composite.add(room.engine.world, body);
    ack({ ok: true, objectId });
    emitState(room, true);
  });

  socket.on('rematch', (ack = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'gameover' || room.players.length !== 2) {
      return ack({ ok: false });
    }
    room.rematchReady.add(socket.id);
    room.updatedAt = Date.now();
    ack({ ok: true });
    if (room.rematchReady.size >= 2) beginMatch(room);
    else emitState(room, true);
  });

  socket.on('disconnect', () => leaveCurrentRoom(socket, true));
});

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) tickRoom(room, now);
}, TICK_MS);

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (room.players.length === 0 || now - room.updatedAt > 1000 * 60 * 45) {
      rooms.delete(code);
    }
  }
}, 60000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Image Tower Online server listening on 0.0.0.0:${PORT}`);
  console.log(`Local test: http://localhost:${PORT}`);
});
