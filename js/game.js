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
  var verdictDone = -1;

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
      round: q.round != null ? Math.max(1, parseInt(q.round, 10)) : 1
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
  function cue(s) {
    var c = $('cue');
    c.textContent = s;
    c.classList.remove('on');
    void c.offsetWidth;      /* アニメーションを打ち直す */
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
      limit: SW.limitFor(idx),
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
    fill(r.slotsCool, cfg.demo + 1 + cfg.black, 3);

    /* 号令の時刻。無音に入る直前の3拍と、入りの瞬間 */
    r.cues = [
      { t: r.tGo - 3 * beatDur, s: '3' },
      { t: r.tGo - 2 * beatDur, s: '2' },
      { t: r.tGo - 1 * beatDur, s: '1' },
      { t: r.tGo, s: 'START' }
    ];
    return r;
  }

  function scheduleRoundAudio(r) {
    /* 鳴らすのは提示フェーズの先導者の足音だけ。
     * 拍子が2つあるお題では、拍子ごとに足音を変えて節の変わり目を示す */
    for (var i = 0; i < r.slotsDemo.length; i++) {
      var k = r.cfg.groups.length > 1 ? (r.slotsDemo[i].g === 0 ? 'R' : 'L') : 'R';
      A.step(r.slotsDemo[i].t, k, 0.75);
    }
    /* 号令の音。低く短く */
    A.ui(r.cues[0].t); A.ui(r.cues[1].t); A.ui(r.cues[2].t);
    A.thud(r.cues[3].t);
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
    roundIdx = Math.min(DBG.round, TOTAL_ROUNDS) - 1;
    W.create(SW.START_COUNT, A.now());
    camX = 0;
    R2.setCam(0);
    playerDeadAt = -1;
    hide('panelTitle'); hide('panelCalib'); hide('panelEnd');
    show('hud');
    startRound();
  };

  function startRound() {
    R = buildRound(roundIdx);
    presses = [];
    cueIdx = 0;
    roundEndAt = -1;
    pacerAlpha = 1;
    W.beginRound(R);
    scheduleRoundAudio(R);
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
    if (!isLive(t)) return;
    presses.push({ t: t });
    W.registerStep(W.player, t, 'R');
    A.step(A.now(), 'R', state === 'black' ? 0.66 : 0.52);
  }

  function pressKey() {
    if (!A.ok()) return;
    pressAt(A.now() - calOffset);
  }

  function isStepKey(code) {
    return code === 'Space' || code === 'Enter' ||
      code.indexOf('Key') === 0 || code.indexOf('Arrow') === 0 ||
      code.indexOf('Digit') === 0 || code === 'ShiftLeft' || code === 'ShiftRight';
  }

  function onKeyDown(e) {
    if (e.repeat) return;
    if (e.code === 'Space') e.preventDefault();

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
    if (isStepKey(e.code)) pressKey();
  }

  function onPointer() {
    if (state === 'title') { G.startRun(); return; }
    if (state === 'calib') { calibTap(); return; }
    if (state === 'end') { G.startRun(); return; }
    pressKey();
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
    A.panic();
    A.musicLevel(0.0, 0.3);
    A.ambLevel(0.10, 0.6);
    state = 'title';
    R = null;
    hide('hud'); hide('panelCalib'); hide('panelEnd');
    show('panelTitle');
  };

  /* ---- 判決・終了 ----
   *
   * 無音が終わるとペースメーカーが現れ、少し間を置いてから、
   * 枠の外にいた者へ上からレーザーが落ちる。生き残りは次の提示の間に
   * 自然と列へ戻っていく。
   */

  var LASER_FALL = 0.30;     /* 降下時間 */
  var LASER_GAP = 0.14;      /* 1本ごとの間隔 */

  function beginVerdict(t) {
    lasers = [];
    verdictDone = -1;
    var victims = W.markVictims(R.limit);
    for (var i = 0; i < victims.length; i++) {
      lasers.push({ w: victims[i], at: t + 1.1 + i * LASER_GAP, hit: false });
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
        if (L.w.isPlayer) {
          playerDeadAt = t;
          flash = 0.7;
          shake = 0.9;
        }
        updateHud();
      }
    }
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

    if (R && state !== 'end') {
      if (state === 'demo' && t >= R.tCount) {
        state = 'count';
      } else if (state === 'count' && t >= R.tGo) {
        state = 'black';
        A.musicLevel(0.0, 0.55);
        setTimeout(function () { A.bedStop(); }, 700);
        A.ambLevel(0.30, 1.2);
      } else if (state === 'black' && t >= R.tEnd) {
        state = 'verdict';
        roundEndAt = t;
        beginVerdict(t);
      }

      /* 号令 */
      if (state === 'count' || state === 'demo') {
        while (cueIdx < R.cues.length && t >= R.cues[cueIdx].t) {
          cue(R.cues[cueIdx].s);
          cueIdx++;
        }
      }

      while (autoIdx < autoPresses.length && autoPresses[autoIdx].t <= t) {
        pressAt(autoPresses[autoIdx].t);
        autoIdx++;
      }

      W.update(R, t, dt);
      W.pruneDead(t);

      /* 判決: レーザーが順に落ちる */
      if (state === 'verdict') {
        verdictTick(t);
        if (playerDeadAt > 0 && t - playerDeadAt > 1.6) {
          endRun(false);
        } else if (playerDeadAt < 0 && t >= verdictDone) {
          if (W.aliveCount() <= 1) {
            endRun(true);
          } else if (roundIdx >= TOTAL_ROUNDS - 1) {
            endRun(true);
          } else {
            toast('ノコリ ' + W.aliveCount() + ' メイ', 1800);
            roundIdx++;
            startRound();
          }
        }
      }

      camX += (W.player.x - camX) * Math.min(1, dt * 3.5);
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

    /* 先導者: 提示と判決で見え、号令で薄れ、無音で消える */
    var pTarget = state === 'black' ? 0 : (state === 'count' ? 0.25 : 1);
    pacerAlpha += (pTarget - pacerAlpha) * Math.min(1, dt * (state === 'verdict' ? 4.5 : 2.2));
    var pacerOpts = { alpha: pacerAlpha, flag: 'rgba(224,244,255,0.94)', glow: true, scale: 1.30 };

    var list = W.walkers, pl = W.player, i, w;
    var drewPacer = false;
    for (i = 0; i < list.length; i++) {
      w = list[i];
      if (!drewPacer && W.pacer.laneF <= w.laneF) {
        if (pacerAlpha > 0.02) R2.drawWalker(W.pacer, t, pacerOpts);
        drewPacer = true;
      }
      R2.drawWalker(w, t, {});
    }
    if (!drewPacer && pacerAlpha > 0.02) R2.drawWalker(W.pacer, t, pacerOpts);

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

    g.restore();

    if (flash > 0) {
      flash = Math.max(0, flash - dt * 2.6);
      g.fillStyle = 'rgba(220,245,255,' + (flash * 0.45).toFixed(3) + ')';
      g.fillRect(0, 0, R2.size().w, R2.size().h);
    }

    R2.vignette(state === 'black' ? 0.60 : 0.32);
  }

  /* ---- 起動 ---- */

  G.boot = function () {
    R2.init($('stage'));
    calOffset = U.storage.get('sw_cal', 0) || 0;

    document.addEventListener('keydown', onKeyDown);
    $('stage').addEventListener('pointerdown', onPointer);

    function btn(id, fn) {
      $(id).addEventListener('click', function (e) {
        e.stopPropagation();
        A.init(); A.ui(A.now());
        fn();
      });
    }
    btn('btnStart', function () { G.startRun(); });
    btn('btnAgain', function () { G.startRun(); });

    state = 'title';
    show('panelTitle');
    global.requestAnimationFrame(frame);
  };

  G._frame = frame;   /* デバッグ用: ペイン非表示で rAF が止まっている時に手で回す */

  document.addEventListener('DOMContentLoaded', function () { G.boot(); });
})(window);
