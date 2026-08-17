/* Short Walk - ローカル用マルチプレイサーバ
 *
 *   cd server && npm install ws && node node-server.js
 *
 * ws://localhost:8787 で待つ。プロトコルは worker.js（本番用）と同一。
 * ロジックは roomlogic.js に集約してあり、ここは配線だけ。
 */
'use strict';
const http = require('http');
const { WebSocketServer } = require('ws');
const { Room } = require('./roomlogic.js');

const PORT = 8787;

let openRoom = null;        /* 参加受付中の公開部屋 */
let roomSeq = 1;
const sockets = new Map();  /* ws -> {room, playerId} */

function roomOf() {
  if (!openRoom || openRoom.phase !== 'lobby' || openRoom.players.length >= 12) {
    openRoom = new Room('r' + roomSeq++, Date.now());
    openRoom.sockets = new Map();   /* playerId -> ws */
  }
  return openRoom;
}

function broadcast(room, msgs) {
  if (!msgs) return;
  for (const m of msgs) {
    const s = JSON.stringify(m);
    for (const ws of room.sockets.values()) {
      if (ws.readyState === 1) ws.send(s);
    }
  }
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end('short-walk room server');
});
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const name = url.searchParams.get('name') || 'ナナシ';
  const room = roomOf();
  const playerId = 'p' + Math.random().toString(36).slice(2, 9);

  const res = room.join(playerId, name);
  if (!res.ok) { ws.close(4000, res.reason); return; }
  room.sockets.set(playerId, ws);
  sockets.set(ws, { room, playerId });
  ws.send(JSON.stringify({ type: 'joined', playerId, roomId: room.id }));
  broadcast(room, res.msgsAll);

  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch (e) { return; }
    const ctx = sockets.get(ws);
    if (!ctx) return;
    const now = Date.now();
    let r = null;
    if (msg.type === 'start') r = ctx.room.start(ctx.playerId, now);
    else if (msg.type === 'result') r = ctx.room.submit(ctx.playerId, msg.round, msg.dev, now);
    if (r && r.ok) broadcast(ctx.room, r.msgsAll);
  });

  ws.on('close', () => {
    const ctx = sockets.get(ws);
    if (!ctx) return;
    sockets.delete(ws);
    ctx.room.sockets.delete(ctx.playerId);
    const r = ctx.room.leave(ctx.playerId, Date.now());
    if (r && r.ok) broadcast(ctx.room, r.msgsAll);
  });
});

/* 時間切れの判決を回す */
setInterval(() => {
  for (const room of new Set([...sockets.values()].map(c => c.room))) {
    if (room.phase === 'playing' && Date.now() >= room.deadline) {
      const r = room.maybeResolve(Date.now(), true);
      if (r && r.ok) broadcast(room, r.msgsAll);
    }
  }
}, 1000);

server.listen(PORT, () => console.log('room server on ws://localhost:' + PORT));
