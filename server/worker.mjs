/* Short Walk - 本番用マルチプレイサーバ (Cloudflare Workers + Durable Objects)
 *
 * 配備:
 *   cd server
 *   npx wrangler login
 *   npx wrangler deploy
 * 出てきた URL を js/net.js の SERVER (wss://…workers.dev) に書き込むこと。
 *
 * プロトコルは node-server.js（ローカル用）と同一。ロジックは roomlogic.js に集約。
 */
import RoomLogic from './roomlogic.js';
const { Room } = RoomLogic;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('short-walk room server', {
        headers: { 'Access-Control-Allow-Origin': '*' }
      });
    }
    /* 公開マッチング: 常に "public" という名の部屋DOへ。
     * 部屋が満員/開始済みなら DO 側が世代番号を進めて新しい部屋を作る */
    const id = env.ROOMS.idFromName('public');
    return env.ROOMS.get(id).fetch(request);
  }
};

export class RoomDO {
  constructor(state) {
    this.state = state;
    this.room = null;          /* 現行世代の部屋 */
    this.sockets = new Map();  /* playerId -> WebSocket */
  }

  freshRoom() {
    if (!this.room || this.room.phase !== 'lobby' || this.room.players.length >= 12) {
      this.room = new Room('r' + Date.now().toString(36), Date.now());
      this.sockets = new Map();
    }
    return this.room;
  }

  broadcast(msgs) {
    if (!msgs) return;
    for (const m of msgs) {
      const s = JSON.stringify(m);
      for (const ws of this.sockets.values()) {
        try { ws.send(s); } catch (e) { /* 切断済み */ }
      }
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const name = url.searchParams.get('name') || 'ナナシ';
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const room = this.freshRoom();
    const playerId = 'p' + Math.random().toString(36).slice(2, 9);
    const res = room.join(playerId, name);
    if (!res.ok) {
      server.close(4000, res.reason);
      return new Response(null, { status: 101, webSocket: client });
    }
    this.sockets.set(playerId, server);
    server.send(JSON.stringify({ type: 'joined', playerId, roomId: room.id }));
    this.broadcast(res.msgsAll);

    const myRoom = room;
    server.addEventListener('message', (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      const now = Date.now();
      let r = null;
      if (msg.type === 'start') r = myRoom.start(playerId, now);
      else if (msg.type === 'result') r = myRoom.submit(playerId, msg.round, msg.dev, now);
      if (r && r.ok) this.broadcast(r.msgsAll);
      /* 締切の見張り */
      if (myRoom.phase === 'playing') {
        this.state.storage.setAlarm(Math.min(myRoom.deadline, Date.now() + 30000));
      }
    });

    server.addEventListener('close', () => {
      this.sockets.delete(playerId);
      const r = myRoom.leave(playerId, Date.now());
      if (r && r.ok) this.broadcast(r.msgsAll);
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  async alarm() {
    if (this.room && this.room.phase === 'playing' && Date.now() >= this.room.deadline) {
      const r = this.room.maybeResolve(Date.now(), true);
      if (r && r.ok) this.broadcast(r.msgsAll);
    }
    if (this.room && this.room.phase === 'playing') {
      await this.state.storage.setAlarm(Math.min(this.room.deadline, Date.now() + 30000));
    }
  }
}
