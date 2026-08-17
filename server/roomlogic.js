/* Short Walk - 部屋の状態機械（純ロジック・I/O なし）
 *
 * Node のローカルサーバと Cloudflare Worker の両方から使う。
 * ここには通信コードを書かない。イベントを食い、送るべきメッセージ列を返すだけ。
 *
 * 方式: ラウンド単位のロックステップ。
 *   - 各クライアントはラウンドを自分の時計で完走し、最終ズレ(dev)だけを提出する
 *   - 全員ぶん揃った時点(または時間切れ)で順位を確定し、判決を配る
 *   - リアルタイム同期はしない。待ちのズレは「歩き続ける非判定区間」が吸収する
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SWRoom = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FIELD = 12;                      /* 定員（NPC込みの隊列の人数） */
  var TARGETS = [8, 5, 3, 2, 1];       /* 各ラウンド終了時の生存数 */
  var ROUNDS = TARGETS.length;
  var RESULT_TIMEOUT = 90000;          /* 結果待ちの上限(ms)。最長ラウンドを覆う */
  var STRAGGLER_GRACE = 15000;         /* 誰かが提出した後、残りを待つ猶予(ms) */

  /* 再現可能な乱数。シードはサーバが配り、NPCの挙動を全員で一致させる */
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function gauss(rng) {
    var u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /* NPCのラウンド別ズレ計画。
   * クライアントはこの値に「到着するように」歩かせ、サーバはこの値で順位を切る。
   * 見た目と判定が絶対に食い違わない。 */
  function buildNpcPlan(seed, npcCount) {
    var rng = mulberry32(seed);
    var npcs = [];
    for (var i = 0; i < npcCount; i++) {
      /* 個性: 締まった者、走る者、落ちる者、迷子 */
      var archetype = rng();
      var bias, spread;
      if (i === 0) { bias = 0.002; spread = 0.05; }          /* 精鋭。最後まで残る */
      else if (i === 1) { bias = 0.004; spread = 0.08; }     /* 次点 */
      else if (archetype < 0.30) { bias = 0.006; spread = 0.12; }
      else if (archetype < 0.60) { bias = 0.020; spread = 0.25; }
      else if (archetype < 0.85) { bias = 0.035; spread = 0.40; }
      else { bias = 0.070; spread = 0.7; }
      var sign = rng() < 0.5 ? -1 : 1;
      var devs = [];
      for (var r = 0; r < ROUNDS; r++) {
        /* ラウンドが進むほど無音が長く速度も上がる ≒ ズレの絶対量が育つ */
        var scale = 8 + r * 5;
        devs.push(+(sign * bias * scale + gauss(rng) * spread * (1 + r * 0.3)).toFixed(3));
      }
      npcs.push({ id: 'npc' + i, devs: devs });
    }
    return npcs;
  }

  /* ---- 部屋 ---- */

  function Room(id, now) {
    this.id = id;
    this.phase = 'lobby';        /* lobby → playing → done */
    this.players = [];           /* {id, name, alive, connected} */
    this.seed = (now || Date.now()) % 2147483647;
    this.npcs = [];
    this.round = 0;
    this.results = {};           /* playerId -> dev（現ラウンド） */
    this.deadline = 0;
  }

  Room.prototype.aliveEntries = function () {
    var out = [];
    for (var i = 0; i < this.players.length; i++) {
      if (this.players[i].alive) out.push(this.players[i]);
    }
    return out;
  };

  /* 参加。戻り値: {ok, msgsAll, msgsSelf} */
  Room.prototype.join = function (playerId, name) {
    if (this.phase !== 'lobby') return { ok: false, reason: 'started' };
    if (this.players.length >= FIELD) return { ok: false, reason: 'full' };
    this.players.push({ id: playerId, name: String(name || 'ナナシ').slice(0, 8), alive: true, connected: true });
    return {
      ok: true,
      msgsAll: [{ type: 'lobby', players: this.lobbyView(), hostId: this.players[0].id }]
    };
  };

  Room.prototype.lobbyView = function () {
    return this.players.map(function (p) { return { id: p.id, name: p.name }; });
  };

  /* ホストが開始。1人でも開始できる（残りはNPCで埋まる） */
  Room.prototype.start = function (playerId, now) {
    if (this.phase !== 'lobby') return { ok: false };
    if (!this.players.length || this.players[0].id !== playerId) return { ok: false, reason: 'not-host' };
    this.phase = 'playing';
    this.round = 0;
    this.npcs = buildNpcPlan(this.seed, FIELD - this.players.length);
    this.results = {};
    this.deadline = now + RESULT_TIMEOUT;
    return {
      ok: true,
      msgsAll: [{
        type: 'start',
        players: this.lobbyView(),
        npcPlan: this.npcs,
        targets: TARGETS
      }]
    };
  };

  /* ラウンド結果の提出 */
  Room.prototype.submit = function (playerId, round, dev, now) {
    if (this.phase !== 'playing' || round !== this.round) return { ok: false };
    var p = this.byId(playerId);
    if (!p || !p.alive) return { ok: false };
    this.results[playerId] = +dev;
    /* 先頭の提出が来たら、残りの猶予を縮める（遅延者を延々待たない） */
    this.deadline = Math.min(this.deadline, now + STRAGGLER_GRACE);
    return this.maybeResolve(now, false);
  };

  /* 全員揃ったか時間切れなら判決 */
  Room.prototype.maybeResolve = function (now, force) {
    var alive = this.aliveEntries();
    var missing = alive.filter(function (p) { return !(p.id in this.results); }, this);
    if (missing.length && !force && now < this.deadline) return { ok: true, msgsAll: [] };

    /* 未提出（回線落ち等）は大きく遅れた扱い */
    for (var i = 0; i < missing.length; i++) this.results[missing[i].id] = -9.9;

    var entries = [];
    for (i = 0; i < alive.length; i++) {
      entries.push({ id: alive[i].id, dev: this.results[alive[i].id], human: true });
    }
    for (i = 0; i < this.npcs.length; i++) {
      if (this.npcs[i].dead) continue;
      entries.push({ id: this.npcs[i].id, dev: this.npcs[i].devs[this.round], human: false });
    }

    /* ズレの大きい順に、規定の生存数まで削る */
    entries.sort(function (a, b) { return Math.abs(b.dev) - Math.abs(a.dev); });
    var target = TARGETS[Math.min(this.round, TARGETS.length - 1)];
    var cut = Math.max(0, entries.length - target);
    var eliminated = entries.slice(0, cut).map(function (e) { return e.id; });

    for (i = 0; i < eliminated.length; i++) {
      var p = this.byId(eliminated[i]);
      if (p) p.alive = false;
      for (var k = 0; k < this.npcs.length; k++) {
        if (this.npcs[k].id === eliminated[i]) this.npcs[k].dead = true;
      }
    }

    var devsOut = {};
    for (i = 0; i < entries.length; i++) devsOut[entries[i].id] = entries[i].dev;

    var msgs = [{
      type: 'verdict',
      round: this.round,
      devs: devsOut,
      eliminated: eliminated
    }];

    var aliveAfter = this.aliveEntries().length +
      this.npcs.filter(function (n) { return !n.dead; }).length;

    this.round++;
    this.results = {};
    this.deadline = now + RESULT_TIMEOUT;

    if (this.round >= ROUNDS || aliveAfter <= 1 || this.aliveEntries().length === 0) {
      this.phase = 'done';
      msgs.push({ type: 'gameend' });
    }
    return { ok: true, msgsAll: msgs, resolved: true };
  };

  Room.prototype.leave = function (playerId, now) {
    var p = this.byId(playerId);
    if (!p) return { ok: false };
    p.connected = false;
    if (this.phase === 'lobby') {
      this.players = this.players.filter(function (q) { return q.id !== playerId; });
      return {
        ok: true,
        msgsAll: this.players.length
          ? [{ type: 'lobby', players: this.lobbyView(), hostId: this.players[0].id }]
          : []
      };
    }
    /* プレイ中の離脱: 生きていれば未提出のまま時間切れ処理に任せる */
    return this.maybeResolve(now, false);
  };

  Room.prototype.byId = function (id) {
    for (var i = 0; i < this.players.length; i++) {
      if (this.players[i].id === id) return this.players[i];
    }
    return null;
  };

  return {
    Room: Room,
    FIELD: FIELD,
    TARGETS: TARGETS,
    RESULT_TIMEOUT: RESULT_TIMEOUT,
    buildNpcPlan: buildNpcPlan,
    mulberry32: mulberry32
  };
});
