'use strict';

const socket = io({ transports: ['websocket', 'polling'] });

const menuScreen = document.getElementById('menuScreen');
const gameScreen = document.getElementById('gameScreen');
const playerNameInput = document.getElementById('playerName');
const roomCodeInput = document.getElementById('roomCodeInput');
const createRoomBtn = document.getElementById('createRoomBtn');
const joinRoomBtn = document.getElementById('joinRoomBtn');
const menuMessage = document.getElementById('menuMessage');
const connectionMessage = document.getElementById('connectionMessage');
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const playerLeft = document.getElementById('playerLeft');
const playerRight = document.getElementById('playerRight');
const copyRoomBtn = document.getElementById('copyRoomBtn');
const waitingRoomCode = document.getElementById('waitingRoomCode');
const nextImage = document.getElementById('nextImage');
const turnBanner = document.getElementById('turnBanner');
const waitOverlay = document.getElementById('waitOverlay');
const gameOverOverlay = document.getElementById('gameOverOverlay');
const gameOverTitle = document.getElementById('gameOverTitle');
const gameOverText = document.getElementById('gameOverText');
const rematchBtn = document.getElementById('rematchBtn');
const rematchStatus = document.getElementById('rematchStatus');
const hitboxBtn = document.getElementById('hitboxBtn');
const leaveBtn = document.getElementById('leaveBtn');
const moveLeftBtn = document.getElementById('moveLeftBtn');
const moveRightBtn = document.getElementById('moveRightBtn');
const rotateLeftBtn = document.getElementById('rotateLeftBtn');
const rotateRightBtn = document.getElementById('rotateRightBtn');
const dropBtn = document.getElementById('dropBtn');
const shareUrlBtn = document.getElementById('shareUrlBtn');
const serverModeBadge = document.getElementById('serverModeBadge');
const serverModeText = document.getElementById('serverModeText');

const LOGICAL_W = 900;
const LOGICAL_H = 700;
const images = new Map();
const renderObjects = new Map();
let characters = new Map();
let state = null;
let localAim = { x: LOGICAL_W / 2, angle: 0 };
let showHitboxes = false;
let roomCode = null;
let dpr = Math.min(window.devicePixelRatio || 1, 2);
let lastAimEmit = 0;
let myDropPending = false;
let audioContext = null;

const held = { left: false, right: false };
const keys = new Set();

function resizeCanvas() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(LOGICAL_W * dpr);
  canvas.height = Math.round(LOGICAL_H * dpr);
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

function sanitizeCode(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[^0-9]/g, '')
    .slice(0, 6);
}

function updateServerMode() {
  const host = window.location.hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (isLocal) {
    serverModeBadge.textContent = 'LOCAL TEST';
    serverModeBadge.classList.add('local');
    serverModeText.textContent = 'これはローカルテストです。離れた友だちとの対戦は公開URLで開いてください。';
  } else {
    serverModeBadge.textContent = 'PUBLIC ONLINE';
    serverModeBadge.classList.add('public');
    serverModeText.textContent = 'このページのURLを友だちに送り、同じ6桁の部屋番号に入ると対戦できます。';
  }
}
updateServerMode();

roomCodeInput.addEventListener('input', () => {
  roomCodeInput.value = sanitizeCode(roomCodeInput.value);
});

async function loadCharacters() {
  const response = await fetch('/characters.json', { cache: 'no-store' });
  const data = await response.json();
  characters = new Map(data.characters.map((c) => [c.id, c]));
  for (const config of data.characters) {
    const img = new Image();
    img.decoding = 'async';
    img.src = window.CHARACTER_IMAGES?.[config.id] || config.image;
    images.set(config.id, img);
  }
}
loadCharacters().catch(() => {
  menuMessage.textContent = '画像データを読み込めませんでした。ページを再読み込みしてください。';
});

function setBusy(busy) {
  createRoomBtn.disabled = busy;
  joinRoomBtn.disabled = busy;
}

function enterGame(code) {
  roomCode = code;
  copyRoomBtn.textContent = code;
  waitingRoomCode.textContent = code;
  menuScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');
  menuMessage.textContent = '';
}

function returnMenu(message = '') {
  roomCode = null;
  state = null;
  renderObjects.clear();
  gameScreen.classList.add('hidden');
  menuScreen.classList.remove('hidden');
  menuMessage.textContent = message;
}

createRoomBtn.addEventListener('click', () => {
  setBusy(true);
  socket.emit('createRoom', { name: playerNameInput.value }, (result) => {
    setBusy(false);
    if (!result?.ok) return (menuMessage.textContent = result?.message || '部屋を作れませんでした。');
    enterGame(result.code);
  });
});

joinRoomBtn.addEventListener('click', () => {
  const code = sanitizeCode(roomCodeInput.value);
  if (code.length !== 6) {
    menuMessage.textContent = '6桁の部屋番号を入力してください。';
    return;
  }
  setBusy(true);
  socket.emit('joinRoom', { code, name: playerNameInput.value }, (result) => {
    setBusy(false);
    if (!result?.ok) return (menuMessage.textContent = result?.message || '参加できませんでした。');
    enterGame(result.code);
  });
});

roomCodeInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') joinRoomBtn.click();
});

leaveBtn.addEventListener('click', () => {
  socket.emit('leaveRoom');
  returnMenu();
});

shareUrlBtn.addEventListener('click', async () => {
  const url = window.location.origin;
  try {
    await navigator.clipboard.writeText(url);
    connectionMessage.textContent = '対戦URLをコピーしました';
  } catch {
    connectionMessage.textContent = `対戦URL：${url}`;
  }
});

copyRoomBtn.addEventListener('click', async () => {
  if (!roomCode) return;
  try {
    await navigator.clipboard.writeText(roomCode);
    connectionMessage.textContent = `部屋番号 ${roomCode} をコピーしました`;
  } catch {
    connectionMessage.textContent = `部屋番号：${roomCode}`;
  }
});

hitboxBtn.addEventListener('click', () => {
  showHitboxes = !showHitboxes;
  hitboxBtn.textContent = `当たり判定 ${showHitboxes ? 'ON' : 'OFF'}`;
});

rematchBtn.addEventListener('click', () => {
  rematchBtn.disabled = true;
  socket.emit('rematch', (result) => {
    if (!result?.ok) rematchBtn.disabled = false;
  });
});

function myTurn() {
  return Boolean(state && state.status === 'playing' && state.turnPlayerId === socket.id && !state.hasDropped);
}

function aimMargin() {
  const config = characters.get(state?.currentCharacterId);
  if (!config) return 70;
  return Math.max(45, Math.min(130, config.displayWidth * 0.34));
}

function emitAim(force = false) {
  if (!myTurn()) return;
  const now = performance.now();
  if (!force && now - lastAimEmit < 45) return;
  lastAimEmit = now;
  socket.emit('aim', localAim);
}

function moveAim(delta) {
  if (!myTurn()) return;
  const margin = aimMargin();
  localAim.x = Math.max(margin, Math.min(LOGICAL_W - margin, localAim.x + delta));
  emitAim();
}

function rotateAim(direction) {
  if (!myTurn()) return;
  localAim.angle += direction * Math.PI / 12;
  while (localAim.angle > Math.PI) localAim.angle -= Math.PI * 2;
  while (localAim.angle < -Math.PI) localAim.angle += Math.PI * 2;
  localAim.angle = Math.round(localAim.angle / (Math.PI / 12)) * (Math.PI / 12);
  emitAim(true);
  playTone(260 + (direction > 0 ? 40 : 0), 0.035, 0.035);
}

function dropCurrent() {
  if (!myTurn() || myDropPending) return;
  myDropPending = true;
  emitAim(true);
  socket.emit('drop', localAim, (result) => {
    if (!result?.ok) myDropPending = false;
  });
  playTone(160, 0.06, 0.05);
}

function bindHold(button, key) {
  const down = (event) => { event.preventDefault(); held[key] = true; };
  const up = (event) => { event.preventDefault(); held[key] = false; };
  button.addEventListener('pointerdown', down);
  button.addEventListener('pointerup', up);
  button.addEventListener('pointercancel', up);
  button.addEventListener('pointerleave', up);
}
bindHold(moveLeftBtn, 'left');
bindHold(moveRightBtn, 'right');
rotateLeftBtn.addEventListener('click', () => rotateAim(-1));
rotateRightBtn.addEventListener('click', () => rotateAim(1));
dropBtn.addEventListener('click', dropCurrent);

window.addEventListener('keydown', (event) => {
  if (['ArrowLeft','ArrowRight','KeyA','KeyD','KeyQ','KeyE','Space'].includes(event.code)) event.preventDefault();
  if (event.repeat && ['KeyQ','KeyE','Space'].includes(event.code)) return;
  keys.add(event.code);
  if (event.code === 'KeyQ') rotateAim(-1);
  if (event.code === 'KeyE') rotateAim(1);
  if (event.code === 'Space') dropCurrent();
});
window.addEventListener('keyup', (event) => keys.delete(event.code));
window.addEventListener('blur', () => { keys.clear(); held.left = held.right = false; });

function canvasLogicalX(event) {
  const rect = canvas.getBoundingClientRect();
  return (event.clientX - rect.left) * LOGICAL_W / rect.width;
}
canvas.addEventListener('pointermove', (event) => {
  if (!myTurn()) return;
  if (event.pointerType === 'mouse' || event.buttons) {
    const margin = aimMargin();
    localAim.x = Math.max(margin, Math.min(LOGICAL_W - margin, canvasLogicalX(event)));
    emitAim();
  }
});
canvas.addEventListener('click', (event) => {
  if (event.pointerType === 'touch') return;
  if (myTurn()) dropCurrent();
});

socket.on('connect', () => { connectionMessage.textContent = 'サーバー接続済み'; });
socket.on('disconnect', () => { connectionMessage.textContent = 'サーバーとの接続が切れました。再接続しています…'; });
socket.on('connect_error', () => { connectionMessage.textContent = 'サーバーに接続できません。'; });

socket.on('state', (nextState) => {
  const previousTurn = state?.turnPlayerId;
  const previousStatus = state?.status;
  state = nextState;
  roomCode = nextState.code;
  copyRoomBtn.textContent = nextState.code;
  waitingRoomCode.textContent = nextState.code;

  if (previousTurn !== nextState.turnPlayerId || previousStatus !== nextState.status) {
    localAim = { x: nextState.aim.x, angle: nextState.aim.angle };
    myDropPending = false;
  } else if (!myTurn()) {
    localAim = { x: nextState.aim.x, angle: nextState.aim.angle };
  }

  syncRenderObjects(nextState.objects);
  updateUI();
});

function syncRenderObjects(objects) {
  const live = new Set();
  for (const item of objects) {
    live.add(item.id);
    let render = renderObjects.get(item.id);
    if (!render) {
      render = { ...item, tx: item.x, ty: item.y, ta: item.angle };
      renderObjects.set(item.id, render);
    }
    render.tx = item.x;
    render.ty = item.y;
    render.ta = item.angle;
    render.characterId = item.characterId;
    render.ox = item.ox;
    render.oy = item.oy;
  }
  for (const id of renderObjects.keys()) {
    if (!live.has(id)) renderObjects.delete(id);
  }
}

function setPlayerPill(el, player, active) {
  el.querySelector('.player-name').textContent = player?.name || '---';
  el.classList.toggle('active', Boolean(active));
}

function updateUI() {
  if (!state) return;
  const p0 = state.players[0];
  const p1 = state.players[1];
  setPlayerPill(playerLeft, p0, p0?.id === state.turnPlayerId);
  setPlayerPill(playerRight, p1, p1?.id === state.turnPlayerId);
  waitOverlay.classList.toggle('hidden', state.status !== 'waiting');
  gameOverOverlay.classList.toggle('hidden', state.status !== 'gameover');

  const nextConfig = characters.get(state.nextCharacterId);
  if (nextConfig) nextImage.src = window.CHARACTER_IMAGES?.[nextConfig.id] || nextConfig.image;

  const mine = state.turnPlayerId === socket.id;
  turnBanner.classList.toggle('mine', mine && state.status === 'playing');
  if (state.status === 'waiting') turnBanner.textContent = '相手を待っています';
  else if (state.status === 'gameover') turnBanner.textContent = 'GAME SET';
  else if (state.hasDropped) turnBanner.textContent = mine ? '止まるまで待ってね' : '相手のキャラが落下中';
  else turnBanner.textContent = mine ? 'あなたのターン！' : '相手のターン';

  const enabled = myTurn();
  for (const button of [moveLeftBtn, moveRightBtn, rotateLeftBtn, rotateRightBtn, dropBtn]) button.disabled = !enabled;

  if (state.status === 'gameover') {
    const won = state.winnerId === socket.id;
    gameOverTitle.textContent = won ? '勝ち！' : '負け…';
    gameOverText.textContent = state.endReason === 'disconnect'
      ? (won ? '相手が退出しました。' : '接続が切れました。')
      : (won ? '相手のターンでキャラが落ちました。' : 'キャラが島から落ちました。');
    const me = state.players.find((p) => p.id === socket.id);
    const opponent = state.players.find((p) => p.id !== socket.id);
    rematchBtn.disabled = Boolean(me?.rematchReady) || state.players.length < 2;
    if (state.players.length < 2) rematchStatus.textContent = '相手が戻るのを待っています';
    else if (me?.rematchReady && !opponent?.rematchReady) rematchStatus.textContent = '相手の「もう一回」を待っています';
    else if (opponent?.rematchReady && !me?.rematchReady) rematchStatus.textContent = '相手は再戦OKです';
    else rematchStatus.textContent = '';
  }
}

function angleLerp(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function rotate(x, y, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return { x: x * c - y * s, y: x * s + y * c };
}

function getSpriteCenter(obj) {
  const off = rotate(obj.ox || 0, obj.oy || 0, obj.angle || 0);
  return { x: obj.x + off.x, y: obj.y + off.y };
}

function drawBackground(cameraY, islandY, islandWidth = 560) {
  const gradient = ctx.createLinearGradient(0, 0, 0, LOGICAL_H);
  gradient.addColorStop(0, '#70c8ee');
  gradient.addColorStop(.62, '#dff6ff');
  gradient.addColorStop(1, '#fff4c8');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
  ctx.globalAlpha = .9;
  drawCloud(130, 135, 1.1); drawCloud(730, 200, .8); drawCloud(505, 72, .55);
  ctx.globalAlpha = 1;
  const sy = islandY - cameraY;
  drawIsland(LOGICAL_W / 2, sy, islandWidth);
  if (sy < LOGICAL_H + 150) {
    ctx.fillStyle = 'rgba(74,174,214,.20)';
    ctx.fillRect(0, Math.max(sy + 95, LOGICAL_H - 80), LOGICAL_W, 120);
  }
}

function drawCloud(x, y, scale) {
  ctx.save(); ctx.translate(x, y); ctx.scale(scale, scale); ctx.fillStyle = 'rgba(255,255,255,.78)';
  ctx.beginPath(); ctx.arc(-45, 10, 28, 0, Math.PI * 2); ctx.arc(-15, -3, 38, 0, Math.PI * 2); ctx.arc(25, 8, 30, 0, Math.PI * 2); ctx.arc(52, 15, 22, 0, Math.PI * 2); ctx.fill(); ctx.restore();
}

function drawIsland(x, y, width = 560) {
  ctx.save(); ctx.translate(x, y); ctx.fillStyle = '#77b85e'; ctx.strokeStyle = '#497f43'; ctx.lineWidth = 4;
  const half = width / 2, lower = half * 0.78, tip = half * 0.50;
  ctx.beginPath(); ctx.moveTo(-half, -22); ctx.quadraticCurveTo(-half * 0.62, -42, 0, -28); ctx.quadraticCurveTo(half * 0.60, -42, half, -22); ctx.lineTo(lower, 20); ctx.quadraticCurveTo(0, 49, -lower, 20); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#8c6a45'; ctx.beginPath(); ctx.moveTo(-lower, 18); ctx.quadraticCurveTo(0, 48, lower, 18); ctx.lineTo(tip, 71); ctx.quadraticCurveTo(0, 101, -tip, 71); ctx.closePath(); ctx.fill(); ctx.restore();
}

function drawCharacter(config, centerX, centerY, angle, alpha = 1) {
  if (!config) return;
  const img = images.get(config.id);
  ctx.save(); ctx.globalAlpha = alpha; ctx.translate(centerX, centerY); ctx.rotate(angle);
  if (img?.complete && img.naturalWidth) ctx.drawImage(img, -config.displayWidth / 2, -config.displayHeight / 2, config.displayWidth, config.displayHeight);
  else { ctx.fillStyle = '#ffcc63'; ctx.fillRect(-config.displayWidth / 2, -config.displayHeight / 2, config.displayWidth, config.displayHeight); }
  ctx.restore();
  if (showHitboxes) drawHitbox(config, centerX, centerY, angle, alpha);
}

function drawHitbox(config, centerX, centerY, globalAngle, alpha = 1) {
  ctx.save(); ctx.strokeStyle = `rgba(255, 40, 40, ${0.82 * alpha})`; ctx.fillStyle = `rgba(255, 50, 50, ${0.08 * alpha})`; ctx.lineWidth = 2;
  for (const part of config.parts) {
    const local = rotate(part.x * config.displayWidth, part.y * config.displayHeight, globalAngle);
    const x = centerX + local.x, y = centerY + local.y, pa = globalAngle + (part.angle || 0) * Math.PI / 180;
    ctx.save(); ctx.translate(x, y); ctx.rotate(pa); ctx.beginPath();
    if (part.type === 'circle') {
      const r = part.r * Math.min(config.displayWidth, config.displayHeight); ctx.arc(0, 0, r, 0, Math.PI * 2);
    } else if (part.type === 'poly') {
      const sides = Math.max(3, Math.round(part.sides || 3)); const r = part.r * Math.min(config.displayWidth, config.displayHeight);
      for (let i = 0; i < sides; i += 1) { const a = -Math.PI / 2 + i * Math.PI * 2 / sides; const px = Math.cos(a) * r, py = Math.sin(a) * r; if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); }
      ctx.closePath();
    } else {
      const w = part.w * config.displayWidth, h = part.h * config.displayHeight; ctx.rect(-w / 2, -h / 2, w, h);
    }
    ctx.fill(); ctx.stroke(); ctx.restore();
  }
  ctx.restore();
}

function playTone(freq, duration, volume) {
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioContext.createOscillator(); const gain = audioContext.createGain();
    osc.type = 'sine'; osc.frequency.value = freq; gain.gain.setValueAtTime(volume, audioContext.currentTime); gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + duration); osc.connect(gain).connect(audioContext.destination); osc.start(); osc.stop(audioContext.currentTime + duration);
  } catch {}
}

let lastFrame = performance.now();
function render(now) {
  const dt = Math.min(40, now - lastFrame); lastFrame = now; const speed = dt / 16.67;
  if (myTurn()) {
    if (held.left || keys.has('ArrowLeft') || keys.has('KeyA')) moveAim(-5.2 * speed);
    if (held.right || keys.has('ArrowRight') || keys.has('KeyD')) moveAim(5.2 * speed);
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cameraY = state ? state.spawnY - 105 : 0;
  drawBackground(cameraY, state?.stage?.islandY ?? 605, state?.stage?.islandWidth ?? 560);

  for (const obj of renderObjects.values()) {
    obj.x += (obj.tx - obj.x) * 0.36; obj.y += (obj.ty - obj.y) * 0.36; obj.angle = angleLerp(obj.angle, obj.ta, 0.36);
    const center = getSpriteCenter(obj); const config = characters.get(obj.characterId); drawCharacter(config, center.x, center.y - cameraY, obj.angle, 1);
  }

  if (state?.status === 'playing' && !state.hasDropped) {
    const aim = myTurn() ? localAim : state.aim; const config = characters.get(state.currentCharacterId);
    if (config) {
      const y = state.spawnY - cameraY;
      ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.setLineDash([8, 9]); ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(aim.x, 25); ctx.lineTo(aim.x, Math.max(30, y - config.displayHeight * .55)); ctx.stroke(); ctx.restore();
      drawCharacter(config, aim.x, y, aim.angle, myTurn() ? .98 : .76);
    }
  }
  requestAnimationFrame(render);
}
requestAnimationFrame(render);
