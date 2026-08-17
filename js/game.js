/* Short Walk - ゲーム進行
 *
 * 1ラウンド = 提示（全員自動で歩く）→ 号令 3,2,1,START → 無音（自分で刻む）
 * 判定に使う時刻はすべて SW.audio.now() (= AudioContext.currentTime)
 *
 * 行進は最初から最後まで一度も止まらない。
 * ジャッジタイムは無い。無音の間、規定位置から離れすぎた者が
 * その場で1人ずつ処理されていく。それだけ。
 */
(function (global) {
  'use strict';
  var SW = global.SW || (global.SW = {});
  var U = SW.util, A = SW.audio, R2 = SW.render, W = SW.world;

  var G = SW.game = {};

  var state = 'boot';
  var lastFrame = 0;
  var R = null;              /* 現在のラウンド */
  var roundIdx = 0;
  var presses = [];
  var calOffset = 0;
  var flash = 0;
  var shake = 0;
  var pacerAlpha = 1;
  var camX = 0;
  var cueIdx = 0;            /* 号令 3,2,1,START の進行 */
  var playerDeadAt = -1;
  var roundEndAt = -1;
  var lasers = [];           /* 執行中のレーザー: {w, at} */
  var debris = [];           /* 衝撃で散る破片: {x,y,vx,vy,life} 画面座標 */
  var verdictDone = -1;
  var zoomCur = 1;
  var visMode = false;       /* 視認モード: 先導者が無音中も薄く見える */
  var bubbles = [];          /* {w, text, until} */
  var nextBubbleAt = 0;

  /* オンライン。null ならソロ。
   * {humans, npcPlan, verdictQueue:[], ended:false} */
  var online = null;
  var syncSince = -1;

  /* 優勝エンディング（逃走）
   * 画面が引き、追いすがる白い群れから連打で逃げる。
   * 捕まれば End、右端まで逃げ切れば Life continues... */
  var chase = null;   /* {t0, camFix, speed, done} */

  var TOTAL_ROUNDS = SW.rounds.length;
  var GRACE = 0.35;

  /* デバッグ用クエリ
   *   ?auto=30   … σ30ms の仮想プレイヤーが自動で歩く
   *   ?bias=1.2  … 自動プレイヤーの系統的テンポ誤差(%)
   *   ?round=6   … 第6課題から開始
   */
  var DBG = (function () {
    var q = {}, parts = global.location.search.slice(1).split('&'), i, kv;
    for (i = 0; i < parts.length; i++) { kv = parts[i].split('='); if (kv[0]) q[kv[0]] = kv[1]; }
    return {
      auto: q.auto != null ? parseFloat(q.auto) / 1000 : 0,
      bias: q.bias != null ? parseFloat(q.bias) / 100 : 0.008,
      round: q.round != null ? Math.max(1, parseInt(q.round, 10)) : 1,
      god: q.god === '1'      /* 無敵。テストとラスト確認用 */
    };
  })();
  var autoPresses = [], autoIdx = 0;

  /* ---- DOM ---- */
  function $(id) { return document.getElementById(id); }
  function show(id) { $(id).classList.remove('hidden'); }
  function hide(id) { $(id).classList.add('hidden'); }
  function html(id, s) { $(id).innerHTML = s; }

  function toast(s, ms) {
    var t = $('toast');
    t.textContent = s;
    t.classList.add('on');
    clearTimeout(t._tm);
    t._tm = setTimeout(function () { t.classList.remove('on'); }, ms || 1800);
  }

  /* 号令。一瞬で出て一瞬で消える */
  function cue(s, long) {
    var c = $('cue');
    c.textContent = s;
    c.classList.remove('on'); c.classList.remove('long');
    void c.offsetWidth;      /* アニメーションを打ち直す */
    if (long) c.classList.add('long');
    c.classList.add('on');
  }

  /* ---- ラウンド構築 ---- */

  function buildRound(idx) {
    var cfg = SW.rounds[idx];
    var beatDur = 60 / cfg.bpm;
    var phraseDur = beatDur * cfg.beats;
    var t0 = A.now() + 1.2;

    var r = {
      idx: idx, cfg: cfg, bpm: cfg.bpm,
      beatDur: beatDur, phraseDur: phraseDur,
      pattern: cfg.pattern,
      t0: t0,
      /* 提示 → 号令1フレーズ（全員自動のまま）→ 無音 */
      tCount: t0 + cfg.demo * phraseDur,
      tGo: t0 + (cfg.demo + 1) * phraseDur,
      tEnd: t0 + (cfg.demo + 1 + cfg.black) * phraseDur,
      slotsDemo: [], slotsCount: [], slotsBlack: [], slotsCool: []
    };
    r.tEcho = r.tGo;         /* world.js の互換名: ここから自分の歩数が位置になる */
    r.tHold = r.tEnd + GRACE;

    function fill(arr, fromPhrase, count) {
      for (var n = 0; n < count; n++) {
        for (var i = 0; i < cfg.slots.length; i++) {
          arr.push({
            t: t0 + (fromPhrase + n) * phraseDur + cfg.slots[i].b * beatDur,
            g: cfg.slots[i].g
          });
        }
      }
    }
    fill(r.slotsDemo, 0, cfg.demo);
    fill(r.slotsCount, cfg.demo, 1);
    fill(r.slotsBlack, cfg.demo + 1, cfg.black);
    fill(r.slotsCool, cfg.demo + 1 + cfg.black, 12);   /* 判決待ちの間も歩き続ける */

    /* 号令。頭に入れたリズムそのもので数える。
     * お題の打鍵が5つなら 5,4,3,2,1 ── 号令フレーズの各打鍵に1つずつ。
     * 一定拍で数えると、覚えたリズムと違う拍子が最後に流れて邪魔になる。 */
    r.cues = [];
    var n = r.slotsCount.length;
    for (var ci = 0; ci < n; ci++) {
      r.cues.push({ t: r.slotsCount[ci].t, s: String(n - ci) });
    }
    r.cues.push({ t: r.tGo, s: 'GO!', long: true });
    return r;
  }

  function scheduleRoundAudio(r) {
    /* 鳴らすのは提示フェーズの先導者の足音だけ。
     * 拍子が2つあるお題では、拍子ごとに足音を変えて節の変わり目を示す */
    for (var i = 0; i < r.slotsDemo.length; i++) {
      var k = r.cfg.groups.length > 1 ? (r.slotsDemo[i].g === 0 ? 'R' : 'L') : 'R';
      A.step(r.slotsDemo[i].t, k, 0.75);
    }
    /* 数値カウントの間も先導者の足音は続く。姿は薄れても刻みは聞かせる */
    for (i = 0; i < r.slotsCount.length; i++) {
      A.step(r.slotsCount[i].t, 'R', 0.6);
    }
    /* 号令の数字は表示のみ。別の音を被せると覚えたリズムの邪魔になる */
    A.bedStart(r.t0);
  }

  function buildAuto(r) {
    autoPresses = []; autoIdx = 0;
    if (!DBG.auto) return;
    var all = r.slotsBlack, i, s, e;
    for (i = 0; i < all.length; i++) {
      s = all[i];
      e = U.gauss(0, DBG.auto) + DBG.bias * (s.t - r.tGo);
      autoPresses.push({ t: s.t + e });
    }
    autoPresses.sort(function (a, b) { return a.t - b.t; });
  }

  /* ---- 状態遷移 ---- */

  G.startRun = function () {
    A.init();
    A.panic();
    A.windStart();
    A.ambLevel(0.16, 0.8);
    A.musicLevel(0.55, 0.2);
    online = null;
    roundIdx = Math.min(DBG.round, TOTAL_ROUNDS) - 1;
    W.create(SW.START_COUNT, A.now());
    camX = 0;
    R2.setCam(0);
    playerDeadAt = -1;
    hide('panelTitle'); hide('panelCalib'); hide('panelEnd'); hide('panelLobby');
    show('hud');
    startRound();
  };

  /* サーバの start を受けて開始。隊列は 自分+他の人間+計画表つきNPC */
  function startRunOnline(msg) {
    A.init();
    A.panic();
    A.windStart();
    A.ambLevel(0.16, 0.8);
    A.musicLevel(0.55, 0.2);
    online = { humans: msg.players, npcPlan: msg.npcPlan, verdictQueue: [], ended: false };
    roundIdx = 0;
    W.createOnline(SW.net.playerId, msg.players, msg.npcPlan, A.now());
    camX = 0;
    R2.setCam(0);
    playerDeadAt = -1;
    hide('panelTitle'); hide('panelCalib'); hide('panelEnd'); hide('panelLobby');
    show('hud');
    startRound();
  }

  function startRound() {
    /* 残り2人: 相手はもう限界。残り3人: 1人が先に壊れはじめる */
    var aliveN = W.aliveCount();
    if (aliveN === 2 || aliveN === 3) {
      var cands = [];
      for (var fi = 0; fi < W.walkers.length; fi++) {
        var fw = W.walkers[fi];
        if (fw.alive && !fw.isPlayer) cands.push(fw);
      }
      if (aliveN === 2) {
        for (fi = 0; fi < cands.length; fi++) {
          cands[fi].duelLevel = 1;
          if (cands[fi].homeLane == null) cands[fi].homeLane = cands[fi].laneT;
        }
      } else if (cands.length && !cands.some(function (c) { return c.duelLevel; })) {
        var pick = cands[Math.floor(Math.random() * cands.length)];
        pick.duelLevel = 0.7;
        pick.homeLane = pick.laneT;
      }
    }
    R = buildRound(roundIdx);
    /* ラウンドが進むほど行進は速くなる。歩幅も背景の流れも一緒に上がり、
     * 終盤はわずかなズレが大きな距離になって見える */
    W.setSpeed(SW.WALK_SPEED * (1 + roundIdx * 0.13), A.now());
    presses = [];
    cueIdx = 0;
    roundEndAt = -1;
    pacerAlpha = 1;
    W.beginRound(R);
    /* 予約を200ms遅らせる。開始直後は実音源のデコードが終わっておらず、
     * 最初のラウンドだけ足音が合成音に落ちてしまうため（最初の拍は1秒以上先にある） */
    (function (r2) { setTimeout(function () { scheduleRoundAudio(r2); }, 200); })(R);
    buildAuto(R);
    A.musicLevel(0.55, 0.3);
    A.ambLevel(0.16, 0.5);
    state = 'demo';
    updateHud();
  }

  function updateHud() {
    html('count', 'ノコリ <b>' + W.aliveCount() + '</b> メイ');
    html('round', (roundIdx + 1) + ' / ' + TOTAL_ROUNDS);
  }

  /* ---- 入力 ---- */

  function isLive(t) {
    if (!R) return false;
    return state === 'black' ||
      (state === 'count' && t >= R.countFrom) ||
      (state === 'verdict' && t < R.tHold);
  }

  function pressAt(t) {
    if (state === 'chase') {
      if (chase && !chase.done) {
        W.player.x += CHASE_STEP;
        W.registerStep(W.player, t, 'R');
        A.step(A.now(), 'R', 0.6);
      }
      return;
    }
    if (!isLive(t)) return;
    presses.push({ t: t });
    W.registerStep(W.player, t, 'R');
    A.step(A.now(), 'R', state === 'black' ? 0.66 : 0.52);
  }

  /* 入力時刻の補正。
   * ハンドラが呼ばれた時点ではなく、OSがタッチ/キーを検知した時刻(e.timeStamp)まで
   * 遡って記録する。スマホはイベント配送だけで30〜70ms遅れることがあり、
   * これを補正しないとタッチ端末のプレイヤーだけ一律に遅く判定される。 */
  function pressKey(e) {
    if (!A.ok()) return;
    var lag = 0;
    if (e && typeof e.timeStamp === 'number') {
      lag = (performance.now() - e.timeStamp) / 1000;
      if (!(lag >= 0 && lag < 0.25)) lag = 0;   /* 異常値は無視 */
    }
    pressAt(A.now() - lag - calOffset);
  }

  function isStepKey(code) {
    return code === 'Space' || code === 'Enter' ||
      code.indexOf('Key') === 0 || code.indexOf('Arrow') === 0 ||
      code.indexOf('Digit') === 0 || code === 'ShiftLeft' || code === 'ShiftRight';
  }

  function onKeyDown(e) {
    if (e.repeat) return;
    var typing = document.activeElement &&
      (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA');
    if (e.code === 'Space' && !typing) e.preventDefault();
    if (typing) return;

    /* ESC でいつでもタイトルへ */
    if (e.code === 'Escape' && state !== 'title') {
      G.toTitle();
      return;
    }

    if (state === 'title') {
      if (e.code === 'KeyC' && e.shiftKey) { G.startCalib(); return; }   /* 隠し: 遅延測定 */
      if (e.code === 'Enter' || e.code === 'Space') G.startRun();
      return;
    }
    if (state === 'calib') { calibTap(); return; }
    if (state === 'end') {
      if (e.code === 'Enter' || e.code === 'Space') G.startRun();
      return;
    }
    if (isStepKey(e.code)) pressKey(e);
  }

  function onPointer(e) {
    if (state === 'title') { G.startRun(); return; }
    if (state === 'calib') { calibTap(); return; }
    if (state === 'end') { G.startRun(); return; }
    pressKey(e);
  }

  /* ---- キャリブレーション ---- */

  var calClicks = [], calTaps = [], calTimer = null;

  G.startCalib = function () {
    A.init();
    A.panic();
    calClicks = []; calTaps = [];
    var t0 = A.now() + 1.0;
    for (var i = 0; i < 16; i++) {
      var t = t0 + i * 0.5;
      calClicks.push(t);
      A.step(t, 'R', 0.7);
    }
    state = 'calib';
    hide('panelTitle'); show('panelCalib');
    html('calibMsg', '足音に合わせて、どのキーでもいいので叩いてください（16回）');
    html('calibVal', '—');
    clearTimeout(calTimer);
    calTimer = setTimeout(finishCalib, (1.0 + 16 * 0.5 + 1.2) * 1000);
  };

  function calibTap() {
    var t = A.now();
    var best = null;
    for (var i = 0; i < calClicks.length; i++) {
      var d = t - calClicks[i];
      if (best === null || Math.abs(d) < Math.abs(best)) best = d;
    }
    if (best !== null && Math.abs(best) < 0.25) {
      calTaps.push(best);
      html('calibVal', calTaps.length + ' / 16　　' + Math.round(U.median(calTaps) * 1000) + ' ms');
    }
    A.step(A.now(), 'L', 0.35);
  }

  function finishCalib() {
    if (calTaps.length >= 5) {
      calOffset = U.median(calTaps);
      U.storage.set('sw_cal', calOffset);
      html('calibVal', Math.round(calOffset * 1000) + ' ms に設定');
    } else {
      html('calibVal', '回数が足りません。0 ms のままにします');
    }
    setTimeout(G.toTitle, 1200);
  }

  G.toTitle = function () {
    SW.net.close();
    online = null;
    A.panic();
    A.musicLevel(0.0, 0.3);
    A.ambLevel(0.10, 0.6);
    state = 'title';
    R = null;
    var nt2 = $('nameTitle');
    if (nt2) nt2.value = U.storage.get('sw_name', '') || '';
    hide('hud'); hide('panelCalib'); hide('panelEnd');
    show('panelTitle');
  };

  /* ---- 吹き出し ----
   *
   * NPCは時折ひとりごとを言う。人数が減るほど頻繁になる。
   * 動きとは無関係。ただの、人間の声。 */
  function playerName() {
    return U.storage.get('sw_name', '') || '';
  }

  function fillName(tpl) {
    var n = playerName();
    if (n) return tpl.replace(/\{name\}/g, n);
    /* 空白なら名前の場所ごと畳む。「おい{name}、そら…」→「おい、そら…」 */
    return tpl.replace(/\{name\}、?/g, '').replace(/^、/, '').replace(/、、/g, '、');
  }

  /* 表示中の吹き出しが使っていない高さの段を選ぶ。重なりを減らす */
  function pickBubbleTier() {
    var used = [0, 0, 0];
    for (var i = 0; i < bubbles.length; i++) {
      var tier = Math.round((bubbles[i].oy || 0) * 2);
      used[Math.max(0, Math.min(2, tier))]++;
    }
    var best = 0;
    if (used[1] < used[best]) best = 1;
    if (used[2] < used[best]) best = 2;
    return best / 2;
  }

  function bubbleTick(t) {
    for (var i = bubbles.length - 1; i >= 0; i--) {
      if (t > bubbles[i].until || (!bubbles[i].w.alive && !bubbles[i].keepDead)) bubbles.splice(i, 1);
    }
    /* 壊れかけの相手: 走る・止まるの変わり目に何かを漏らし、
     * 走るときはプレイヤーのすぐ隣まで寄ってくる */
    for (i = 0; i < W.walkers.length; i++) {
      var dw = W.walkers[i];
      if (dw.duelLevel && dw.alive && dw.duelSegs && dw.duelSegs.length &&
          t >= dw.duelSegs[0].t) {
        var seg = dw.duelSegs.shift();
        bubbles.push({ w: dw, text: U.pick(SW.PANIC), until: t + 2.8, ox: Math.random() * 2 - 1, oy: pickBubbleTier() });
        if (seg.mode === 'run' && Math.random() < 0.6) {
          dw.laneT = W.LANE_NEAR - W.LANE_GAP * 0.5;   /* すぐ隣 */
        } else if (seg.mode === 'walk' && dw.homeLane != null) {
          dw.laneT = dw.homeLane;
        }
      }
    }
    if (t < nextBubbleAt) return;
    var pool = [];
    for (i = 0; i < W.walkers.length; i++) {
      var w = W.walkers[i];
      if (w.alive && !w.isPlayer && !w.isRemote) pool.push(w);
    }
    if (!pool.length) return;
    var n = W.aliveCount();
    /* 残りが少ないほど間隔が詰まる */
    var lo = n <= 3 ? 1.6 : (n <= 5 ? 2.4 : 4.5);
    var hi = n <= 3 ? 3.6 : (n <= 5 ? 5.5 : 9.0);
    nextBubbleAt = t + U.rand(lo, hi);
    var w2 = pool[Math.floor(Math.random() * pool.length)];
    /* 3回に1回は、名前を呼んでプレイヤーに話しかけてくる */
    var text;
    if (Math.random() < 0.34) {
      text = fillName(U.pick(SW.CALLOUTS));
    } else {
      text = U.pick(SW.MUTTERS);
    }
    bubbles.push({ w: w2, text: text, until: t + 3.6, ox: Math.random() * 2 - 1, oy: pickBubbleTier() });
  }

  /* ---- 判決・終了 ----
   *
   * 無音が終わるとペースメーカーが現れ、少し間を置いてから、
   * 枠の外にいた者へ上からレーザーが落ちる。生き残りは次の提示の間に
   * 自然と列へ戻っていく。
   */

  var LASER_FALL = 0.30;     /* 降下時間 */
  var LASER_GAP = 0.14;      /* 1本ごとの間隔 */

  /* サーバが決めた処刑リストで判決を演出する */
  function beginServerVerdict(t, V) {
    lasers = [];
    window.__syncToast = 0;
    var victims = [];
    for (var i = 0; i < V.eliminated.length; i++) {
      var w = W.byNetId(V.eliminated[i]) ||
        (V.eliminated[i] === SW.net.playerId ? W.player : null);
      if (w) victims.push(w);
    }
    victims.sort(function (a, b) { return a.laneF - b.laneF; });
    scheduleLasers(t, victims);
    if (V.gameend) online.ended = true;
  }

  var verdictPending = false;

  function beginVerdict(t) {
    lasers = [];
    verdictDone = -1;
    /* 判定はまだしない。ズレが確定する tHold の瞬間に、
     * 画面に凍結された値そのもので裁く。ここで裁くと、猶予中の入力や
     * 凍結までのわずかな時間ぶんだけ判定と見た目がずれる */
    verdictPending = true;
  }

  function resolveVerdict(t) {
    verdictPending = false;
    var target = SW.TARGETS[Math.min(roundIdx, SW.TARGETS.length - 1)];
    var quota = Math.max(0, W.aliveCount() - target);
    var victims = W.markVictims(1e9, quota);
    if (DBG.god) {
      victims = victims.filter(function (v) { return !v.isPlayer; });
    }
    scheduleLasers(t, victims);
  }

  function scheduleLasers(t, victims) {
    lasers = [];
    for (var i = 0; i < victims.length; i++) {
      var at = t + 1.1 + i * LASER_GAP;
      lasers.push({ w: victims[i], at: at, hit: false });
      /* 今際の際のひとこと。レーザーが落ちる寸前に叫ぶ */
      if (!victims[i].isPlayer) {
        bubbles.push({
          w: victims[i],
          text: U.pick(SW.LASTWORDS),
          until: at + LASER_FALL + 0.7,
          keepDead: true,
          ox: Math.random() * 2 - 1, oy: pickBubbleTier()
        });
      }
    }
    verdictDone = t + 1.1 + victims.length * LASER_GAP + 1.2;
  }

  function verdictTick(t) {
    for (var i = 0; i < lasers.length; i++) {
      var L = lasers[i];
      if (!L.hit && t >= L.at + LASER_FALL) {
        L.hit = true;
        W.kill(L.w, t);
        A.zap(t);
        spawnDebris(L.w);
        if (L.w.isPlayer) {
          playerDeadAt = t;
          flash = 0.7;
          shake = 0.9;
        }
        updateHud();
      }
    }
  }

  /* 衝撃の破片。血ではなく、砕けた路面と埃。灰色 */
  function spawnDebris(w) {
    var p = R2.screenOf(w.x, w.laneF);
    for (var i = 0; i < 10; i++) {
      var a = Math.random() * Math.PI - Math.PI;   /* 上方向中心 */
      var sp = 60 + Math.random() * 240;
      debris.push({
        x: p.x, y: p.y - p.ppm * 0.8,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 140,
        life: 0.55 + Math.random() * 0.35,
        size: 1.5 + Math.random() * 2.5
      });
    }
    if (debris.length > 120) debris.splice(0, debris.length - 120);
  }

  /* ---- 優勝エンディング ---- */

  var CHASE_STEP = 0.6;      /* 連打1回で進む距離 */

  function beginChase(t) {
    state = 'chase';
    chase = { t0: t, camFix: camX, speed: 2.4, done: null, doneAt: 0 };
    W.spawnChasers(38, t);
    A.bedStop();
    A.ambLevel(0.34, 2.0);
    cue('ユウショウ', true);
  }

  function chaseTick(t, dt) {
    var c = chase;
    if (!c || c.done) return;
    /* 追手はだんだん速くなる */
    c.speed += 0.12 * dt;
    W.updateChasers(t, dt, c.speed);

    /* 捕まった: 距離もレーンも詰められたら */
    for (var i = 0; i < W.chasers.length; i++) {
      var ch = W.chasers[i];
      if (Math.abs(ch.x - W.player.x) < 0.8 &&
          Math.abs(ch.laneF - W.player.laneF) < 0.07) {
        c.done = 'end';
        c.doneAt = t;
        A.thud(t);
        flash = 0.6;
        return;
      }
    }
    /* 画面右端まで逃げ切った */
    var sp = R2.screenOf(W.player.x, W.player.laneF);
    if (sp.x > R2.size().w - 30) {
      c.done = 'life';
      c.doneAt = t;
    }
  }

  function endChase() {
    state = 'end';
    A.panic();
    A.ambLevel(0.08, 1.6);
    hide('hud');
    var t = A.now();
    if (chase.done === 'life') {
      A.fanfare(t + 0.2);
      html('endTitle', 'Life continues...');
      html('endLead', '');
    } else {
      A.dead(t + 0.15);
      html('endTitle', 'End');
      html('endLead', '');
    }
    show('panelEnd');
  }

  function endRun(cleared) {
    state = 'end';
    A.panic();
    A.ambLevel(0.08, 1.4);
    hide('hud');
    var t = A.now();
    if (cleared) A.fanfare(t + 0.2); else A.dead(t + 0.15);

    html('endTitle', cleared ? 'カンポ' : 'ダツラク');
    html('endLead', cleared
      ? 'ノコリ ' + W.aliveCount() + ' メイ'
      : 'ノコリ ' + W.aliveCount() + ' メイ デ ダツラク');
    show('panelEnd');
  }

  /* ---- メインループ ---- */

  function frame(ms) {
    global.requestAnimationFrame(frame);
    var wall = ms / 1000;
    var dt = Math.min(0.05, lastFrame ? wall - lastFrame : 0.016);
    lastFrame = wall;
    if (!A.ok()) { R2.begin(0.2); R2.vignette(0.5); return; }
    var t = A.now();

    if (state === 'chase') {
      chaseTick(t, dt);
      /* カメラは固定。画面はじょじょに引いていく */
      zoomCur += (0.72 - zoomCur) * Math.min(1, dt * 0.22);
      R2.setZoom(zoomCur);
      R2.setCam(chase.camFix);
      if (chase.done && t - chase.doneAt > 1.2) endChase();
      draw(t, dt);
      return;
    }

    if (R && state !== 'end') {
      if (state === 'demo' && t >= R.tCount) {
        state = 'count';
      } else if (state === 'count' && t >= R.tGo) {
        state = 'black';
        A.musicLevel(0.0, 0.55);
        setTimeout(function () { A.bedStop(); }, 700);
        A.ambLevel(0.30, 1.2);
      } else if (state === 'black' && t >= R.tEnd) {
        if (online) {
          state = 'sync';
          roundEndAt = t;
          syncSince = t;
          online.sentResult = false;   /* 提出はズレ確定(tHold)後に1回だけ */
        } else {
          state = 'verdict';
          roundEndAt = t;
          beginVerdict(t);
        }
      }

      /* 号令。GO! は断絶への遷移と同フレームになるため、状態で縛らない */
      while (cueIdx < R.cues.length && t >= R.cues[cueIdx].t) {
        cue(R.cues[cueIdx].s, R.cues[cueIdx].long);
        cueIdx++;
      }

      while (autoIdx < autoPresses.length && autoPresses[autoIdx].t <= t) {
        pressAt(autoPresses[autoIdx].t);
        autoIdx++;
      }

      W.update(R, t, dt);
      W.pruneDead(t);

      /* 同期待ち: サーバの判決が来るまで歩き続ける */
      if (state === 'sync') {
        if (online && !online.sentResult && t >= R.tHold) {
          online.sentResult = true;
          SW.net.sendResult(roundIdx, W.relDev(W.player));
        }
        if (online && online.verdictQueue.length) {
          var V = online.verdictQueue.shift();
          W.applyDevs(V.devs);
          state = 'verdict';
          roundEndAt = t;
          beginServerVerdict(t, V);
        } else if (t - syncSince > 4 && !window.__syncToast) {
          window.__syncToast = 1;
          toast('ホカ ノ ホコウシャ ヲ マツ', 2200);
        }
      }

      /* 判決: ズレの確定を待ってから、レーザーが順に落ちる */
      if (state === 'verdict') {
        if (verdictPending && t >= R.tHold) resolveVerdict(t);
        verdictTick(t);
        if (playerDeadAt > 0 && t - playerDeadAt > 1.6) {
          endRun(false);
        } else if (playerDeadAt < 0 && !verdictPending && verdictDone > 0 && t >= verdictDone) {
          if (W.aliveCount() <= 1 || roundIdx >= TOTAL_ROUNDS - 1) {
            beginChase(t);
          } else {
            toast('ノコリ ' + W.aliveCount() + ' メイ', 1800);
            roundIdx++;
            W.formLine(false);   /* 空いたぶんを詰めて手前へ */
            W.sort();
            startRound();
          }
        }
      }

      bubbleTick(t);

      /* 人数が減るほどカメラが寄る。最後の二人はかなり大きい */
      var n = Math.max(2, W.aliveCount());
      var zTarget;
      if (n >= 4) zTarget = 1 + (12 - n) * 0.09;
      else if (n === 3) zTarget = 2.3;
      else zTarget = 3.6;                       /* 最後の二人。ほぼ全身アップ */
      zoomCur += (zTarget - zoomCur) * Math.min(1, dt * 1.2);
      R2.setZoom(zoomCur);

      camX += (W.player.x - camX) * Math.min(1, dt * 9);
      R2.setCam(camX);
    }

    draw(t, dt);
  }

  function draw(t, dt) {
    var dark = state === 'black' ? 0.30 : 0;

    var g = R2.ctx();
    g.save();
    if (shake > 0) {
      shake = Math.max(0, shake - dt * 3.2);
      g.translate((Math.random() - 0.5) * 9 * shake, (Math.random() - 0.5) * 7 * shake);
    }

    R2.begin(dark);
    R2.drawMarks();

    /* 先導者: 提示と判決で見え、号令で薄れ、無音で消える。
     * ただし無音に入って最初の1フレーズだけは薄い姿が残り、
     * そのフレーズが終わる頃にフェードアウトする（入りのアシスト）。
     * 視認モードでは以降もずっと薄い影が残る */
    var pTarget;
    if (state === 'black') {
      var assist = R ? U.clamp(1 - (t - R.tGo) / R.phraseDur, 0, 1) : 0;
      pTarget = Math.max(visMode ? 0.22 : 0, 0.30 * assist);
    } else {
      pTarget = state === 'count' ? 0.25 : 1;
    }
    pacerAlpha += (pTarget - pacerAlpha) * Math.min(1, dt * (state === 'verdict' ? 4.5 : 2.2));
    var pacerOpts = { alpha: pacerAlpha, flag: 'rgba(224,244,255,0.94)', glow: true, scale: 1.30 };

    /* 描画順は毎フレーム laneF で並べ直す。奥から描き、画面の下にいる者ほど手前。
     * 列の詰め直しの最中に配列順と実際の前後関係がズレて重なりが崩れるため */
    var list = W.walkers.slice(), i, w;
    if (state === 'chase') list = list.concat(W.chasers);
    else if (W.pacer && pacerAlpha > 0.02) list.push(W.pacer);
    list.sort(function (a, b) { return a.laneF - b.laneF; });
    for (i = 0; i < list.length; i++) {
      w = list[i];
      var wOpts = {};
      if (w === W.pacer) wOpts = pacerOpts;
      else if (w.isPacer) wOpts = { color: R2.pal.pacer, glow: true, scale: 1.18 };  /* 追手 */
      R2.drawWalker(w, t, wOpts);
    }

    /* 吹き出し */
    for (i = 0; i < bubbles.length; i++) {
      var B = bubbles[i];
      var age = B.until - t;
      var ba = Math.min(1, age / 0.4) * 0.92;
      R2.drawBubble(B.w, B.text, ba, B.ox, B.oy);
    }

    /* レーザー */
    if (state === 'verdict') {
      for (i = 0; i < lasers.length; i++) {
        var L = lasers[i];
        if (t < L.at) continue;
        var prog = (t - L.at) / LASER_FALL;
        if (prog > 1.4) continue;
        R2.drawLaser(L.w.x, L.w.laneF, prog, t);
      }
    }

    /* 破片。血ではなく、砕けた路面と埃 */
    if (debris.length) {
      for (i = debris.length - 1; i >= 0; i--) {
        var D = debris[i];
        D.life -= dt;
        if (D.life <= 0) { debris.splice(i, 1); continue; }
        D.vy += 620 * dt;
        D.x += D.vx * dt;
        D.y += D.vy * dt;
        g.globalAlpha = Math.min(1, D.life * 2.2) * 0.7;
        g.fillStyle = '#55555a';
        g.fillRect(D.x, D.y, D.size, D.size);
      }
      g.globalAlpha = 1;
    }

    g.restore();

    if (flash > 0) {
      flash = Math.max(0, flash - dt * 2.6);
      g.fillStyle = 'rgba(220,245,255,' + (flash * 0.45).toFixed(3) + ')';
      g.fillRect(0, 0, R2.size().w, R2.size().h);
    }

    R2.vignette(state === 'black' ? 0.60 : 0.32);
  }

  /* ---- 起動 ---- */

  /* ---- ロビー ---- */

  function lobbyMsg(sub) {
    html('lobbyStatus', sub || '');
  }

  function renderLobby(m) {
    var isHost = m.hostId === SW.net.playerId;
    var rows = '';
    for (var i = 0; i < m.players.length; i++) {
      var p = m.players[i];
      rows += '<li>' + p.name +
        (p.id === SW.net.playerId ? '　←アナタ' : '') +
        (p.id === m.hostId ? '　（シキ）' : '') + '</li>';
    }
    html('lobbyList', rows);
    $('btnGo').classList.toggle('hidden', !isHost);
    lobbyMsg(isHost
      ? (m.players.length < 2 ? 'ヒトリデモ ハジメラレル。ノコリハ ホコウシャ デ ウマル' : 'ソロッタラ ハジメロ')
      : 'シキ ノ ゴウレイ ヲ マツ');
  }

  G.openLobby = function () {
    var name = U.storage.get('sw_name', '');
    $('nameIn').value = name;
    hide('panelTitle');
    show('panelLobby');
    hide('lobbyRoom'); show('lobbyJoin');
    lobbyMsg('');
  };

  function joinMatch() {
    var name = ($('nameIn').value || 'ナナシ').slice(0, 8);
    U.storage.set('sw_name', name);
    lobbyMsg('セツゾク チュウ…');
    SW.net.quickMatch(name);
  }

  function leaveLobby() {
    SW.net.close();
    hide('panelLobby');
    show('panelTitle');
  }

  function bindNet() {
    var N = SW.net;
    N.on('joined', function () {
      hide('lobbyJoin'); show('lobbyRoom');
    });
    N.on('lobby', function (m) { renderLobby(m); });
    N.on('start', function (m) { startRunOnline(m); });
    N.on('verdict', function (m) {
      if (online) online.verdictQueue.push(m);
    });
    N.on('gameend', function () {
      if (online) online.ended = true;
    });
    N.on('error', function (msg) { lobbyMsg(String(msg)); });
    N.on('closed', function () {
      if (online && state !== 'end' && state !== 'title') {
        /* 回線が切れたら以降はローカル判定で続行 */
        toast('ツウシン ガ キレタ', 2400);
        online = null;
      }
    });
  }

  function saveTitleName() {
    var el = $('nameTitle');
    if (el) U.storage.set('sw_name', (el.value || '').slice(0, 8));
  }

  G.boot = function () {
    R2.init($('stage'));
    calOffset = U.storage.get('sw_cal', 0) || 0;
    var nt = $('nameTitle');
    if (nt) nt.value = U.storage.get('sw_name', '') || '';
    bindNet();

    document.addEventListener('keydown', onKeyDown);
    $('stage').addEventListener('pointerdown', onPointer);

    function btn(id, fn) {
      $(id).addEventListener('click', function (e) {
        e.stopPropagation();
        A.init(); A.ui(A.now());
        fn();
      });
    }
    btn('btnStart', function () {
      var nt3 = $('nameTitle');
      if (nt3 && !(nt3.value || '').trim()) {
        nt3.classList.add('need');
        nt3.placeholder = 'ナマエ ヲ イレロ';
        nt3.focus();
        return;
      }
      saveTitleName();
      G.startRun();
    });
    btn('btnAgain', function () { G.startRun(); });
    btn('btnMulti', function () { saveTitleName(); G.openLobby(); });
    btn('btnJoin', function () { joinMatch(); });
    btn('btnGo', function () { SW.net.start(); });
    btn('btnLeave', function () { leaveLobby(); });
    var bc = $('btnCal2');
    if (bc) bc.addEventListener('click', function (e) {
      e.stopPropagation();
      A.init(); A.ui(A.now());
      G.startCalib();
    });
    visMode = !!U.storage.get('sw_vis', false);
    var bv = $('btnVis');
    function visLabel() { bv.textContent = '視認モード: ' + (visMode ? 'オン' : 'オフ'); }
    visLabel();
    bv.addEventListener('click', function (e) {
      e.stopPropagation();
      A.init(); A.ui(A.now());
      visMode = !visMode;
      U.storage.set('sw_vis', visMode);
      visLabel();
    });

    state = 'title';
    show('panelTitle');
    global.requestAnimationFrame(frame);
  };

  G._frame = frame;   /* デバッグ用: ペイン非表示で rAF が止まっている時に手で回す */

  document.addEventListener('DOMContentLoaded', function () { G.boot(); });
})(window);
