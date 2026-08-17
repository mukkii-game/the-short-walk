/* Short Walk - 群衆シミュレーション
 *
 * NPCは「押した時刻の列」を各ラウンド頭に丸ごと生成する。
 * 描画も採点もその同じ配列から読む = 見た目と点数が絶対に食い違わない。
 */
(function (global) {
  'use strict';
  var SW = global.SW || (global.SW = {});
  var U = SW.util;

  var W = SW.world = {};

  var SPEED = SW.WALK_SPEED;

  W.walkers = [];
  W.player = null;
  W.pacer = null;
  W.marks = [];        /* 処理済みの跡 */
  W.totalDist = 0;     /* 背景スクロール用の累積距離 */

  function hueForNpc() {
    /* 低彩度・低明度。色相だけばらす。
     * ここを明るくするとプレイヤーが群衆に埋もれて見失う。暗さは仕様。 */
    var h = Math.floor(Math.random() * 360);
    return 'hsl(' + h + ',12%,' + (10 + Math.random() * 10).toFixed(0) + '%)';
  }

  /* NPCの実力分布
   *
   * 素直に「実力を一様乱数で配って上位半分を残す」と、5回も淘汰した時点で
   * 生き残りが上位3%の化け物だけになり、難易度が階段状に跳ね上がる。
   * そこで実力を「淘汰の梯子の何段目に相当するか(tier)」で直接定義する。
   *   tier r のNPC = 第rラウンドのボーダーちょうどの実力
   * 上位 2^-r 分位に落ちる者が tier r になるよう、分位点から逆算している。
   * ここを触れば難易度カーブがそのまま動く。
   */
  var NPC = W.NPC = {
    s1: 0.112, slope: 0.0076, lowSlope: 0.068, sMin: 0.027, rMax: 11,
    b1: 0.043, bSlope: 0.0037,
    p1: 0.28, pSlope: 0.028,
    d1: 0.13, dSlope: 0.013,
    k1: 0.16, kSlope: 0.014
  };

  function npcTier() {
    var u = Math.random();
    if (u > 0.99995) u = 0.99995;
    var z = -Math.log(1 - u) / Math.LN2;
    return Math.min(NPC.rMax, z - 0.415);
  }

  /* 歩き方の個性。
   * 実力(tier)とは独立に「どう狂うか」を配る。
   * 少しずつ前に出る者、少しずつ落ちる者、ほとんどズレない者、
   * 平均は合っているのに刻みが暴れる者、そして完全に見失った者。
   * プレイヤーが「誰を見て合わせるか」を選べるのは、この差があるから。 */
  var TYPES = [
    { key: 'steady',  w: 26, bias: 0.22, sign: 0, jitter: 0.75, recover: 0.75, sway: 0.5, label: 'ほとんどズレない' },
    { key: 'rush',    w: 24, bias: 1.35, sign: 1, jitter: 1.00, recover: 0.50, sway: 1.0, label: '少しずつ前に出る' },
    { key: 'drag',    w: 24, bias: 1.35, sign: -1, jitter: 1.00, recover: 0.50, sway: 1.0, label: '少しずつ落ちる' },
    { key: 'erratic', w: 18, bias: 0.30, sign: 0, jitter: 1.75, recover: 0.55, sway: 0.9, label: '刻みが暴れる' },
    { key: 'lost',    w: 8, bias: 2.20, sign: 0, jitter: 2.10, recover: 0.05, sway: 1.4, label: '見失っている' }
  ];
  var TYPE_TOTAL = 0;
  for (var ti = 0; ti < TYPES.length; ti++) TYPE_TOTAL += TYPES[ti].w;

  function pickType() {
    var r = Math.random() * TYPE_TOTAL;
    for (var i = 0; i < TYPES.length; i++) {
      r -= TYPES[i].w;
      if (r <= 0) return TYPES[i];
    }
    return TYPES[0];
  }

  function makeWalker(id, isPlayer) {
    var r = npcTier();
    var sig = r >= 1 ? NPC.s1 - NPC.slope * (r - 1) : NPC.s1 + NPC.lowSlope * (1 - r);
    var ty = pickType();
    var sign = ty.sign !== 0 ? ty.sign : (Math.random() < 0.5 ? -1 : 1);
    var w = {
      id: id,
      isPlayer: !!isPlayer,
      alive: true,
      tier: r,
      type: ty.key,
      skill: U.clamp(r / NPC.rMax, 0, 1),
      /* 実力パラメータ */
      sigma0: U.clamp(sig * ty.jitter, NPC.sMin * 0.8, 0.260),                  /* 刻みのブレ σ (秒) */
      bias: U.clamp(NPC.b1 - NPC.bSlope * (r - 1), 0.0025, 0.075) * ty.bias * sign,
      patErr: U.clamp(NPC.p1 - NPC.pSlope * (r - 1), 0.004, 0.55),             /* 余計に一歩踏む率 */
      dropRate: U.clamp(NPC.d1 - NPC.dSlope * (r - 1), 0.002, 0.30),           /* 踏み外す率 */
      panicBase: U.clamp(NPC.k1 - NPC.kSlope * (r - 1), 0.018, 0.40),          /* 無音中のσ増大率 (/秒) */
      recover: ty.recover,                                                      /* ズレを取り返す度合い */
      sway: ty.sway,                                                            /* 群衆の流れに乗ってしまう度合い */
      /* 体格の個体差。群衆が金太郎飴に見えないようにする */
      hMul: 0.92 + Math.random() * 0.15,
      bMul: 0.88 + Math.random() * 0.28,
      /* 配置 */
      laneF: Math.random(),
      laneT: 0,
      baseX: 0,
      baseT: 0,
      /* 実行時 */
      presses: [], pi: 0, stepCount: 0, steps: 0, countFrom: -9, devHold: 0, devBase: 0, gap: 0, pace: 0.6,
      x: 0, lastStepT: -9, prevStepT: -9, lastStepK: 'R', parity: 0,
      score: 0, res: null,
      dead: false, deathT: 0,
      color: isPlayer ? null : hueForNpc()
    };
    if (isPlayer) {
      w.tier = 99; w.skill = 1; w.type = 'player';
      w.hMul = 1.04; w.bMul = 1.0;
      w.sigma0 = 0; w.bias = 0; w.patErr = 0; w.dropRate = 0; w.panicBase = 0; w.recover = 0;
      w.colHead = '#e8c96a'; w.colBody = '#c8503f'; w.colHips = '#3f6f92';
    }
    return w;
  }

  /* 参加者を作る。総数 n（プレイヤー含む） */
  W.create = function (n, t0) {
    W.T0 = t0 || 0;
    W._regBase = 0; W._tv = W.T0; W.speed = SPEED;
    W.walkers = [];
    W.marks = [];
    W.totalDist = 0;

    var ids = [];
    for (var i = 1; i <= n; i++) ids.push(i);
    /* ゼッケンをシャッフル */
    for (i = ids.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = ids[i]; ids[i] = ids[j]; ids[j] = t;
    }

    var p = makeWalker(ids[0], true);
    p.laneF = W.LANE_NEAR;
    W.player = p;
    W.walkers.push(p);

    for (i = 1; i < n; i++) W.walkers.push(makeWalker(ids[i], false));

    /* 精鋭を必ず2人仕込む。ペースメーカーにほぼ合わせ切る者と、それに近い者。
     * ランダムに任せると全員凡庸な回ができてしまい、
     * 「最後の二人」の勝負（かなり正確でないと勝てない）が成立しない。 */
    var elite = W.walkers[W.walkers.length - 1];
    elite.type = 'elite'; elite.tier = 11;
    elite.sigma0 = 0.022; elite.bias = (Math.random() < 0.5 ? -1 : 1) * 0.0025;
    elite.patErr = 0.003; elite.dropRate = 0.001; elite.panicBase = 0.018; elite.sway = 0.15;
    var second = W.walkers[W.walkers.length - 2];
    second.type = 'steady'; second.tier = 9;
    second.sigma0 = 0.028; second.bias = (Math.random() < 0.5 ? -1 : 1) * 0.005;
    second.patErr = 0.006; second.dropRate = 0.002; second.panicBase = 0.022; second.sway = 0.3;

    /* 先導者（ペースメーカー） */
    var pc = makeWalker(0, false);
    pc.isPacer = true;
    pc.color = '#eef4ff';
    W.pacer = pc;

    for (i = 0; i < W.walkers.length; i++) {
      W.walkers[i].baseX = 0; W.walkers[i].baseT = 0; W.walkers[i].x = 0;
    }
    pc.baseX = 0; pc.baseT = 0; pc.x = 0;
    W.formLine(true);
    W.sort();
    return W;
  };

  /* オンライン用。自分＋他の人間＋計画表つきNPCで隊列を作る。
   * humans: [{id,name}]（自分含む・サーバの順）
   * npcPlan: [{id, devs:[r1..r5]}] 各ラウンドの最終ズレ。
   * NPCはこの値に「到着するように」歩く。見た目と判定が食い違わない。 */
  W.createOnline = function (selfId, humans, npcPlan, t0) {
    W.T0 = t0 || 0;
    W._regBase = 0; W._tv = W.T0; W.speed = SPEED;
    W.walkers = [];
    W.marks = [];

    var i, w;
    for (i = 0; i < humans.length; i++) {
      var isSelf = humans[i].id === selfId;
      w = makeWalker(i + 1, isSelf);
      w.netId = humans[i].id;
      if (!isSelf) {
        w.type = 'remote';
        w.isRemote = true;
        w.name = humans[i].name;
        /* 他人はラウンド中は規定どおりに歩いて見える（結果は判決で反映） */
        w.sigma0 = 0.03; w.bias = 0; w.patErr = 0; w.dropRate = 0;
        w.panicBase = 0.02; w.sway = 0; w.planDevs = null;
        /* 人間は明るめの服で塗り分け（群衆より浮かせる） */
        w.color = 'hsl(' + ((i * 47) % 360) + ',30%,42%)';
      }
      if (isSelf) W.player = w;
      W.walkers.push(w);
    }
    for (i = 0; i < npcPlan.length; i++) {
      w = makeWalker(100 + i, false);
      w.netId = npcPlan[i].id;
      w.planDevs = npcPlan[i].devs;
      w.sway = 0;
      W.walkers.push(w);
    }

    var pc = makeWalker(0, false);
    pc.isPacer = true;
    pc.color = '#eef4ff';
    W.pacer = pc;

    for (i = 0; i < W.walkers.length; i++) {
      W.walkers[i].baseX = 0; W.walkers[i].baseT = 0; W.walkers[i].x = 0;
    }
    pc.baseX = 0; pc.baseT = 0; pc.x = 0;
    W.formLine(true);
    W.sort();
    return W;
  };

  /* 判決で確定した各自のズレを反映。位置は update() の追従で滑らかに動く */
  W.applyDevs = function (map) {
    for (var i = 0; i < W.walkers.length; i++) {
      var w = W.walkers[i];
      if (w.netId != null && map[w.netId] != null && !w.isPlayer) {
        w.devHold = map[w.netId];
      }
    }
  };

  W.byNetId = function (id) {
    for (var i = 0; i < W.walkers.length; i++) {
      if (W.walkers[i].netId === id) return W.walkers[i];
    }
    return null;
  };

  W.aliveCount = function () {
    var c = 0;
    for (var i = 0; i < W.walkers.length; i++) if (W.walkers[i].alive) c++;
    return c;
  };

  W.sort = function () {
    W.walkers.sort(function (a, b) { return a.laneF - b.laneF; });
  };

  /* 隊列
   *
   * 全員が横一列。X座標は先導者と同じ0から始まる。
   * 全員が規定どおりなら一直線のまま進み、速い者・遅い者だけが
   * 線から突き出る。それが唯一の手がかりであり、そのまま死の基準になる。
   */
  W.LANE_NEAR = 0.99;        /* 手前端（プレイヤー） */
  W.LANE_FAR = 0.16;         /* 奥端 */

  /* 間隔は人数で割らず固定。人が減ると空いたぶんが詰められ、
   * 生き残りは手前側に寄っていく。immediate=false なら現在地から滑らかに移動 */
  W.LANE_GAP = (W.LANE_NEAR - W.LANE_FAR) / 12;

  W.formLine = function (immediate) {
    var alive = [], others = [], i;
    for (i = 0; i < W.walkers.length; i++) if (W.walkers[i].alive) alive.push(W.walkers[i]);
    for (i = 0; i < alive.length; i++) if (!alive[i].isPlayer) others.push(alive[i]);

    var pl = W.player;
    pl.laneT = W.LANE_NEAR;

    /* 先導者はプレイヤーのすぐ奥、同じX */
    W.pacer.laneT = W.LANE_NEAR - W.LANE_GAP;

    for (i = 0; i < others.length; i++) {
      others[i].laneT = W.LANE_NEAR - W.LANE_GAP * (i + 2);
    }
    if (immediate) {
      pl.laneF = pl.laneT;
      W.pacer.laneF = W.pacer.laneT;
      for (i = 0; i < others.length; i++) others[i].laneF = others[i].laneT;
    }
  };

  /* 無音の間、規定位置から limit を超えて離れた者をその場で処理する。
   * 判定はこれだけ。ジャッジタイムも集計もない。 */
  /* 処刑対象を選ぶ（まだ殺さない）。
   *
   * 規則は二段構え:
   *   1. 枠(limit)の外にいる者は全員
   *   2. それが足りなくても、成績下位 quota 名は必ず処理される
   * 誰もズレていなくても淘汰は止まらない。これはそういう行進である。
   * 返す順は奥から手前（レーザーが奥から順に落ちる）。 */
  W.markVictims = function (limit, quota) {
    var alive = [], out = [], i, w;
    for (i = 0; i < W.walkers.length; i++) {
      w = W.walkers[i];
      if (w.alive) alive.push(w);
    }
    /* ズレの大きい順 */
    alive.sort(function (a, b) { return Math.abs(b.devHold) - Math.abs(a.devHold); });
    for (i = 0; i < alive.length; i++) {
      if (Math.abs(alive[i].devHold) > limit || out.length < (quota || 0)) out.push(alive[i]);
    }
    /* 最後の一人は殺さない（勝者が残る） */
    if (out.length >= alive.length) out = out.slice(0, alive.length - 1);
    out.sort(function (a, b) { return a.laneF - b.laneF; });
    return out;
  };

  /* レーザー着弾。ここで初めて死ぬ */
  W.kill = function (w, t) {
    if (!w.alive) return;
    w.alive = false;
    w.dead = true;
    w.deathT = t;
  };

  /* 倒れてから時間が経った者を路面の跡に変える */
  W.pruneDead = function (t) {
    for (var i = W.walkers.length - 1; i >= 0; i--) {
      var w = W.walkers[i];
      if (w.dead && t - w.deathT > 2.2) {
        W.marks.push({
          x: w.x, laneF: w.laneF,
          id: w.id, isPlayer: !!w.isPlayer,
          rot: (w.id % 2 === 0 ? 1 : -1) * Math.PI / 2
        });
        if (W.marks.length > 100) W.marks.shift();
        W.walkers.splice(i, 1);
      }
    }
  };

  /* ---- ラウンド ---- */

  /* R: {t0, tEcho, tBlack, tEnd, bpm, barDur, pattern, slotsEcho[], slotsBlack[], idx} */
  W.beginRound = function (R) {
    var i;

    /* 群衆全体の流れ。
     * 個々のズレを対称に配ると「群衆の真ん中＝正解」になってしまう。
     * ラウンドごとに全員へ同じ向きのバイアスをかけ、
     * 全員遅れがちな回・全員走りがちな回を作る。真ん中は信用できない。 */
    if (Math.random() < 0.45) {
      R.crowdBias = U.gauss(0, 0.004);                                 /* ほぼ流れなし */
    } else {
      R.crowdBias = (Math.random() < 0.5 ? -1 : 1) * U.rand(0.008, 0.022);  /* 一方向に流れる */
    }
    /* 位置に反映する歩数を数え始める時刻。
     * 提示フェーズの歩数まで数えると、追従の開始と同時に
     * 提示フェーズぶんの距離を一気に前に飛んでしまう（先導者が特にそうなる）。
     * 追従1発目をわずかに早く押した場合を拾うため、最小スロット間隔の半分だけ手前から数える。 */
    var minGap = 1e9;
    for (i = 1; i < R.slotsBlack.length; i++) {
      var gp = R.slotsBlack[i].t - R.slotsBlack[i - 1].t;
      if (gp > 0.001 && gp < minGap) minGap = gp;
    }
    if (minGap > 1e8) minGap = 0.6;
    R.countFrom = R.tGo - Math.min(0.25, minGap * 0.45);

    for (i = 0; i < W.walkers.length; i++) {
      var w = W.walkers[i];
      resetWalker(w, R);
      if (!w.alive) continue;
      if (w.isPlayer) genAutoWalk(w, R); else genPresses(w, R);
    }

    /* 先導者は完璧に歩く（提示・追従フェーズのみ姿を見せる） */
    var pc = W.pacer;
    resetWalker(pc, R);
    var all = R.slotsDemo.concat(R.slotsCount, R.slotsBlack, R.slotsCool);
    for (i = 0; i < all.length; i++) pc.presses.push({ t: all[i].t, k: 'R' });
  };

  function resetWalker(w, R) {
    w.presses = []; w.pi = 0;
    w.stepCount = 0; w.steps = 0;
    w.pace = R.phraseDur / R.pattern.length;
    w.countFrom = R.countFrom;
    w.devBase = null;        /* START の瞬間の実ズレで確定させる（提示中の復帰を反映） */
    w.lastStepT = -9; w.prevStepT = -9; w.parity = 0; w.warned = 0;
    w.score = 0; w.res = null;
    /* w.x はリセットしない。ラウンドをまたいで歩き続けるため */
  }

  /* プレイヤー用。判定のない区間だけ、隊列どおりに脚を動かすための歩み。
   * 追従〜断絶の区間はこの配列を読まない（本人の入力がすべて）。 */
  function genAutoWalk(w, R) {
    var all = R.slotsDemo.concat(R.slotsCount, R.slotsCool), i;
    for (i = 0; i < all.length; i++) w.presses.push({ t: all[i].t, k: 'R' });
  }

  /* NPCの歩み。
   *
   * 重要: 手本のスロット時刻に誤差を足すだけでは駄目。
   * それだと「何歩踏んだか」が全員同じになり、位置が一切ズレない。
   * 判定が位置だけになった以上、NPCは自分のテンポで独立に歩かせる必要がある。
   *
   *   tempo > 1 … 速い → 同じ時間に多く踏む → 前に出る
   *   tempo < 1 … 遅い → 後ろに落ちる
   *   wander    … テンポ自体がゆっくり揺らぐ。刻みが不安定な者はこれで流されていく
   */
  function genPresses(w, R) {
    var i, s;

    /* 提示〜号令フェーズ: 手本どおりに歩く */
    var guided = R.slotsDemo.concat(R.slotsCount);
    for (i = 0; i < guided.length; i++) {
      s = guided[i];
      w.presses.push({ t: s.t + U.gauss(0, w.sigma0 * 0.5), k: 'R' });
    }

    /* 追従フェーズ以降は自分のテンポ */
    var panic = w.panicBase * (1 + R.idx * 0.15);
    var span = Math.max(0.001, R.tEnd - R.tGo);
    var wanderSigma = w.sigma0 * 0.085;
    /* 流されやすさは個性による。腕のいい者ほど流れに乗らない */
    var tempo = 1 + w.bias + (R.crowdBias || 0) * (w.sway == null ? 1 : w.sway);
    /* 計画表があるNPC（オンライン）は、ラウンド末にその値へ到着するテンポで歩く */
    if (w.planDevs && w.planDevs[R.idx] != null) {
      var span2 = Math.max(1, W.speed * (R.tEnd - R.tGo));
      tempo = 1 + w.planDevs[R.idx] / span2;
      wanderSigma *= 0.4;
    }

    /* 最後の一騎打ちの相手は、もう限界が来ている。
     * 突然走り出し、立ち止まり、また歩き出す。そのたびに何かを漏らす。
     * 走る・止まるの予定表(duelSegs)を作っておき、吹き出しはそこに同期する */
    if (w.finalDuel) {
      w.duelSegs = [];
      var stepD = W.speed * R.phraseDur / R.pattern.length;   /* 一歩の距離 */
      var out = [];
      var lastT = R.tGo;
      var segIdx = 0;
      while (lastT < R.tEnd) {
        /* 実際に出した歩数から、いまの正確なズレを出す。
         * 見積りで回すと誤差が蓄積して、終盤に沈んだまま戻れなくなる */
        var devNow = out.length * stepD - W.speed * (lastT - R.tGo);
        var mode = segIdx % 3 === 1 ? 'run' : (segIdx % 3 === 2 ? 'stop' : 'walk');
        /* 大きく置いていかれているときは、止まらずに走って戻る */
        if (mode === 'stop' && devNow < -1.2) mode = 'run';
        if (mode === 'run' && devNow > 1.2) mode = 'stop';
        var dur = mode === 'stop' ? 0.5 + Math.random() * 0.5
                : mode === 'run' ? 1.0 + Math.random() * 1.0
                : 2.0 + Math.random() * 2.0;
        if (segIdx > 0) w.duelSegs.push({ t: lastT, mode: mode });
        var rate = mode === 'run' ? 1.35 + Math.random() * 0.2
                 : mode === 'stop' ? 0
                 : U.clamp(1 - devNow * 0.5, 0.65, 1.4);
        if (rate > 0.2) {
          var interval = (R.phraseDur / R.pattern.length) / rate;
          for (var tt = lastT; tt < Math.min(lastT + dur, R.tEnd); tt += interval) {
            out.push({ t: tt + U.gauss(0, 0.02), k: 'R' });
          }
        }
        lastT += dur;
        segIdx++;
      }
      w.presses = w.presses.filter(function (pr) { return pr.t < R.tGo; }).concat(out);
      w.presses.sort(function (a, b) { return a.t - b.t; });
      return;
    }
    var wander = 0;
    var phase = R.tGo;
    var endT = R.tEnd + R.phraseDur * 5;
    var guard = 0;

    while (phase < endT && guard++ < 400) {
      var rate = Math.max(0.55, tempo + wander);
      var dur = R.phraseDur / rate;
      for (i = 0; i < R.pattern.length; i++) {
        var t = phase + R.pattern[i] * R.beatDur / rate;
        if (t >= endT) break;
        var prog = U.clamp((t - R.tGo) / span, 0, 1.4);
        if (Math.random() < w.dropRate * (0.35 + prog)) continue;      /* 踏み外す */
        var sigma = w.sigma0 * (1 + panic * Math.max(0, t - R.tGo));
        w.presses.push({ t: t + U.gauss(0, sigma), k: 'R' });
        if (Math.random() < w.patErr * 0.5 * (0.5 + prog)) {           /* つまずいて余計に一歩 */
          w.presses.push({ t: t + U.rand(0.09, 0.19), k: 'R' });
        }
      }
      phase += dur;
      wander += U.gauss(0, wanderSigma);
    }

    w.presses.sort(function (a, b) { return a.t - b.t; });
  }

  /* 行進は一度も止まらない。
   *
   * ラウンドの区切りでも、照合中でも、隊列は歩き続ける。
   * そのため規定位置は「ラウンド開始からの距離」ではなく
   * 「走り出しからの通し距離」で持つ。ラウンドをまたいでも座標が飛ばない。 */
  W.T0 = 0;
  W.speed = SPEED;
  W._regBase = 0;
  W._tv = 0;

  /* 行進速度の切り替え。規定位置が飛ばないよう、切替時点を基点に積み上げる */
  W.setSpeed = function (v, t) {
    W._regBase = W.regAt(t);
    W._tv = t;
    W.speed = v;
  };

  W.regAt = function (t) { return W._regBase + W.speed * (t - W._tv); };

  /* 毎フレーム。t は AudioContext 時刻 */
  W.update = function (R, t, dt) {
    var i, w, target;
    var reg = W.regAt(t);
    var anchor = W.regAt(R.tEcho);
    var regEnd = W.regAt(R.tEnd);
    var stepDist = W.speed * R.phraseDur / R.pattern.length;
    var smooth = 1 - Math.pow(0.0009, dt);

    for (i = 0; i < W.walkers.length; i++) {
      w = W.walkers[i];
      if (w.dead) continue;               /* 倒れた者はその場に残り、隊列が追い越していく */
      if (!w.alive) continue;
      /* 提示フェーズと照合フェーズ以降は、プレイヤーも隊列に合わせて自動で歩く。
       * ここを省くと、本人が入力していない区間で脚が止まったまま滑る。 */
      if (!w.isPlayer || t < R.tEcho || t >= R.tHold) advancePresses(w, t);
      target = stepTarget(w, R, t, reg, anchor, regEnd, stepDist, dt);
      w.x += (target - w.x) * smooth;
      w.laneF += (w.laneT - w.laneF) * Math.min(1, dt * 1.1);
    }

    var pc = W.pacer;
    advancePresses(pc, t);
    target = stepTarget(pc, R, t, reg, anchor, regEnd, stepDist, dt);
    pc.x += (target - pc.x) * smooth;
    pc.laneF += (pc.laneT - pc.laneF) * Math.min(1, dt * 1.1);

    W.regX = reg;
  };

  /* 3つの歩き方
   *   提示フェーズ   : 隊列に合わせて自動で歩く（判定なし）。ズレはそのまま持ち越す
   *   追従〜断絶     : 自分の押した歩数がそのまま位置になる
   *   照合フェーズ以降: 判定時点のズレを保ったまま、規定速度で歩き続ける
   *
   * ズレは絶対にリセットしない。少しずつ落ちた者は落ちたまま、
   * 前に出た者は出たまま次のラウンドに入る。
   * 隊列を組み直して全員を元の位置に戻すのは、行進として嘘になる。
   */
  function stepTarget(w, R, t, reg, anchor, regEnd, stepDist, dt) {
    if (t < R.tEcho || t >= R.tHold) {
      /* 提示の間、生き残ったズレは自然に列へ戻っていく。
       * 「多少ズレて入るが、また横並びになる」ための緩やかな回復 */
      if (t < R.tCount) w.devHold += (0 - w.devHold) * Math.min(1, (dt || 0.016) * 0.9);
      return w.baseX + w.devHold + reg;
    }
    /* START の瞬間のズレを基点に、そこから少しずつ離れていく。
     * 古い値を使うと号令の直後に全員が一斉に飛ぶ */
    if (w.devBase === null) w.devBase = w.devHold;
    /* まだ一歩も踏んでいない者は、惰性でわずかに流れたあと止まる。
     * ここを「規定速度で流す」にすると、何も押さない＝完璧な歩行になってしまう。
     * 歩かない者は置いていかれる。それがこのゲームの全てなので、ここは絶対に守る */
    if (w.steps === 0) {
      var coast = Math.min(reg - anchor, stepDist * 0.6);
      w.devHold = w.devBase + coast - (reg - anchor);
      return w.baseX + w.devBase + anchor + coast;
    }
    /* 判定用のズレは補間した連続量で持つ（公平さのため）。
     * ただし見た目の位置は「一歩＝きっかり一歩ぶん」に量子化する。
     * 押した瞬間にその距離をパッと進む。歩幅と移動が一致して見えるように。
     * 多少カクつくのは仕様で、update() 側の緩やかな追従で角を丸める */
    var frac = U.clamp((t - w.lastStepT) / w.pace, 0, 1.25);
    w.devHold = (w.devBase + (w.steps - 1 + frac) * stepDist) - (reg - anchor);
    return w.baseX + w.devBase + anchor + (w.steps - 1) * stepDist + stepDist * 0.5;
  }
  function advancePresses(w, t) {
    while (w.pi < w.presses.length && w.presses[w.pi].t <= t) {
      W.registerStep(w, w.presses[w.pi].t, w.presses[w.pi].k);
      w.pi++;
    }
  }

  W.registerStep = function (w, t, k) {
    if (w.lastStepT > -8) {
      var iv = U.clamp(t - w.lastStepT, 0.12, 1.6);
      w.pace += (iv - w.pace) * 0.45;    /* 直近の歩調 */
    }
    w.prevStepT = w.lastStepT;
    w.lastStepT = t;
    w.lastStepK = k;
    w.parity ^= 1;
    w.stepCount++;
    if (t >= w.countFrom) w.steps++;   /* 位置に効くのは追従フェーズ以降の歩数だけ */
  };

  /* 規定位置からのズレ（メートル）。前が +
   * 断絶中は実時間の値、照合フェーズ以降は判定時点で確定した値を返す。 */
  W.deviation = function (w) { return w.devHold; };
  W.liveDeviation = function (w) { return (w.x - w.baseX) - W.regX; };

  /* ---- 採点と淘汰 ---- */

})(window);
