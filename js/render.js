/* Short Walk - 描画
 *
 * 柱C: 「リズムゲームに見えない絵」。譜面もノーツも判定文字も画面に出さない。
 *       情報はすべてキャラクターの動きと位置に埋める。
 */
(function (global) {
  'use strict';
  var SW = global.SW || (global.SW = {});
  var U = SW.util;

  var R2 = SW.render = {};

  var cv = null, g = null, DPR = 1;
  var Wd = 0, Ht = 0;

  /* 調整用パラメータ（イテレーションはここを触る） */
  var CFG = R2.cfg = {
    horizonF: 0.24,
    groundF: 0.97,
    ppm: 70,            /* 1メートルあたりのピクセル（最前列基準） */
    playerScreenF: 0.44,
    laneCurve: 1.12,
    scaleFar: 0.62,     /* 一番奥でも小さくなりすぎない。重なりは許容する */
    scaleNear: 1.10,
    bodyH: 1.70         /* メートル */
  };

  var PAL = R2.pal = {
    skyTop: '#2b2f3a',
    skyBot: '#6b6455',
    hillFar: '#3c3f48',
    hillNear: '#33353d',
    /* 路面は人物より明るく保つ。暗くすると影絵が浮いて見えなくなる */
    roadFar: '#6a6355',
    roadNear: '#57524a',
    vergeFar: '#4c4638',
    vergeNear: '#3a3629',
    mark: 'rgba(226,220,196,0.30)',
    pacer: '#eef4ff'
  };

  var camX = 0;
  var zoom = 1;

  R2.setZoom = function (z) { zoom = z; };
  R2.zoom = function () { return zoom; };

  /* ---- ドット絵スプライト ----
   *
   * assets/sprites/crowd.png … 横9フレーム × 縦バリエーション（64px角）
   *   行0 = 先導者 / 行1 = プレイヤー / 行2以降 = 群衆
   * 読み込みに失敗したら（file:// 直開きなど）手描きシルエットに自動で落ちる。
   *
   * フレームの割り当てが肝心:
   *   フレーム0 = 直立。1..8 = 歩行ループ（1歩 = 4フレーム）。
   *   「押した瞬間に踏み込みの絵になる」ように、歩調(pace)で位相を進める。
   *   素材のアニメ速度に合わせるのではなく、ゲームの一歩に絵を従わせる。
   */
  var SPR = {
    img: null, ok: false, rows: 0,
    CELL: 64, FRAMES: 9,
    FOOT: 62,      /* セル内で足が接地している y */
    BODY_H: 58     /* セル内のキャラの実高。拡大率の基準 */
  };

  (function loadSprites() {
    var im = new Image();
    im.onload = function () {
      SPR.img = im;
      SPR.rows = Math.floor(im.height / SPR.CELL);
      SPR.ok = SPR.rows >= 3;
    };
    im.onerror = function () { SPR.ok = false; };
    im.src = 'assets/sprites/crowd.png';
  })();

  R2.spriteOk = function () { return SPR.ok; };

  function spriteRowFor(w) {
    if (w.isPacer) return 0;
    if (w.isPlayer) return 1;
    /* id で決めて固定。毎フレーム変わらないように */
    return 2 + ((w.id * 7919 + 13) % (SPR.rows - 2));
  }

  function spriteFrame(w, t) {
    var interval = U.clamp(w.pace || 0.6, 0.15, 1.4);
    var since = t - w.lastStepT;
    if (w.lastStepT < -8 || since > interval * 1.9) return 0;   /* 立ち止まっている */
    var prog = U.clamp(since / interval, 0, 0.999);
    /* 1歩 = 半サイクル4フレーム。parity で左右の足を交互に */
    var base = w.parity ? 1 : 5;
    return base + Math.floor(prog * 4);
  }


  R2.init = function (canvas) {
    cv = canvas;
    g = cv.getContext('2d');
    R2.resize();
    global.addEventListener('resize', R2.resize);
    /* 起動時にレイアウトが未確定だとサイズ0のまま固まるので監視しておく */
    if (global.ResizeObserver) {
      new global.ResizeObserver(function () { R2.resize(); }).observe(cv);
    }
  };

  R2.resize = function () {
    DPR = Math.min(2, global.devicePixelRatio || 1);
    var w = cv.clientWidth || global.innerWidth || 960;
    var h = cv.clientHeight || global.innerHeight || 540;
    if (w === Wd && h === Ht && cv.width) return;
    Wd = w; Ht = h;
    cv.width = Math.floor(Wd * DPR);
    cv.height = Math.floor(Ht * DPR);
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
  };

  function horizonY() { return Ht * CFG.horizonF; }
  function groundY() { return Ht * CFG.groundF; }

  function laneT(laneF) { return Math.pow(U.clamp(laneF, 0, 1), CFG.laneCurve); }

  function screenOf(x, laneF) {
    var t = laneT(laneF);
    var s = U.lerp(CFG.scaleFar, CFG.scaleNear, t);
    var y = U.lerp(horizonY(), groundY(), t);
    var ppm = CFG.ppm * zoom * s;
    var sx = Wd * CFG.playerScreenF + (x - camX) * ppm;
    return { x: sx, y: y, s: s, ppm: ppm };
  }
  R2.screenOf = screenOf;
  R2.setCam = function (x) { camX = x; };
  R2.camX = function () { return camX; };

  /* ---- 背景 ---- */

  function drawSky(dark) {
    var hy = horizonY();
    var gr = g.createLinearGradient(0, 0, 0, hy);
    gr.addColorStop(0, PAL.skyTop);
    gr.addColorStop(1, PAL.skyBot);
    g.fillStyle = gr;
    g.fillRect(0, 0, Wd, hy);

    /* 太陽（低く、にじんだ） */
    var sx = Wd * 0.72, sy = hy * 0.62;
    var sg = g.createRadialGradient(sx, sy, 0, sx, sy, Ht * 0.30);
    sg.addColorStop(0, 'rgba(255,220,160,0.30)');
    sg.addColorStop(1, 'rgba(255,220,160,0)');
    g.fillStyle = sg;
    g.fillRect(0, 0, Wd, hy);

    if (dark > 0) {
      g.fillStyle = 'rgba(8,9,14,' + (dark * 0.42).toFixed(3) + ')';
      g.fillRect(0, 0, Wd, hy);
    }
  }

  function drawHills() {
    var hy = horizonY();
    var i, x, k;
    g.fillStyle = PAL.hillFar;
    g.beginPath();
    g.moveTo(0, hy);
    for (i = 0; i <= 40; i++) {
      x = (i / 40) * Wd;
      k = Math.sin((camX * 0.012) + i * 0.7) * 0.5 + Math.sin(i * 0.31 + 2.1) * 0.5;
      g.lineTo(x, hy - 8 - k * 12 - 10);
    }
    g.lineTo(Wd, hy); g.closePath(); g.fill();

    g.fillStyle = PAL.hillNear;
    g.beginPath();
    g.moveTo(0, hy);
    for (i = 0; i <= 30; i++) {
      x = (i / 30) * Wd;
      k = Math.sin((camX * 0.03) + i * 0.9 + 1.3) * 0.5 + Math.sin(i * 0.5) * 0.5;
      g.lineTo(x, hy - 2 - k * 6 - 3);
    }
    g.lineTo(Wd, hy); g.closePath(); g.fill();
  }

  /* 路面。
   * 道幅は隊列のレーン範囲と一致させる。端に路肩と外側線を引くことで
   * 「野原を歩いている」ではなく「幹線道路を歩かされている」絵にする。 */
  function drawGround(dark) {
    var hy = horizonY(), gy = groundY();
    var W3 = SW.world;
    var far = (W3.LANE_FAR != null ? W3.LANE_FAR : 0.42) - 0.07;
    var near = (W3.LANE_NEAR != null ? W3.LANE_NEAR : 0.99) + 0.06;

    function yOf(lane) { return U.lerp(hy, gy, laneT(U.clamp(lane, 0, 1.3))); }
    var yFar = yOf(far), yNear = Math.max(yOf(near), gy);

    /* 路肩（道の外） */
    var vg = g.createLinearGradient(0, hy, 0, Ht);
    vg.addColorStop(0, PAL.vergeFar);
    vg.addColorStop(1, PAL.vergeNear);
    g.fillStyle = vg;
    g.fillRect(0, hy, Wd, Ht - hy);

    /* 路面 */
    var rg = g.createLinearGradient(0, yFar, 0, yNear);
    rg.addColorStop(0, PAL.roadFar);
    rg.addColorStop(1, PAL.roadNear);
    g.fillStyle = rg;
    g.fillRect(0, yFar, Wd, yNear - yFar);

    /* 外側線 */
    g.strokeStyle = PAL.mark;
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(0, yFar + 0.5); g.lineTo(Wd, yFar + 0.5);
    g.stroke();
    g.lineWidth = 2.0;
    g.beginPath();
    g.moveTo(0, yNear - 1); g.lineTo(Wd, yNear - 1);
    g.stroke();

    /* 中央の破線。8mごと、4mぶん */
    var mid = (far + near) / 2;
    var yMid = yOf(mid);
    var ppmMid = CFG.ppm * zoom * U.lerp(CFG.scaleFar, CFG.scaleNear, laneT(mid));
    var span = 8, start = Math.floor((camX - 40) / span) * span;
    g.strokeStyle = PAL.mark;
    g.lineWidth = Math.max(1.5, 0.16 * ppmMid);
    g.beginPath();
    for (var x = start; x < camX + 60; x += span) {
      var a = Wd * CFG.playerScreenF + (x - camX) * ppmMid;
      var b = a + 4 * ppmMid;
      if (b < -20 || a > Wd + 20) continue;
      g.moveTo(a, yMid); g.lineTo(b, yMid);
    }
    g.stroke();

    /* 路面の汚れ。奥行きの手がかりになる程度に薄く */
    g.strokeStyle = 'rgba(30,28,24,0.10)';
    g.lineWidth = 1;
    for (var lane = far + 0.06; lane < near; lane += 0.12) {
      var y = yOf(lane);
      var pm = CFG.ppm * zoom * U.lerp(CFG.scaleFar, CFG.scaleNear, laneT(lane));
      g.beginPath();
      for (var x2 = start; x2 < camX + 60; x2 += 3) {
        var ax = Wd * CFG.playerScreenF + (x2 - camX) * pm;
        if (ax < -20 || ax > Wd + 20) continue;
        g.moveTo(ax, y); g.lineTo(ax + 0.9 * pm, y);
      }
      g.stroke();
    }

    if (dark > 0) {
      g.fillStyle = 'rgba(8,9,14,' + (dark * 0.34).toFixed(3) + ')';
      g.fillRect(0, hy, Wd, Ht - hy);
    }
  }

  function drawPoles() {
    var hy = horizonY();
    var spacing = 26;
    var start = Math.floor((camX - 60) / spacing) * spacing;
    g.strokeStyle = 'rgba(20,20,26,0.55)';
    for (var x = start; x < camX + 120; x += spacing) {
      var p = screenOf(x, 0.06);
      if (p.x < -60 || p.x > Wd + 60) continue;
      var h = 78 * p.s * 1.9;
      g.lineWidth = Math.max(1, 2.4 * p.s);
      g.beginPath();
      g.moveTo(p.x, p.y);
      g.lineTo(p.x, p.y - h);
      g.moveTo(p.x - h * 0.14, p.y - h * 0.86);
      g.lineTo(p.x + h * 0.14, p.y - h * 0.86);
      g.stroke();
    }
    void hy;
  }

  /* ---- キャラクター ---- */

  function raiseAmt(dt, dur) {
    if (dt < 0) return 0;
    if (dt > dur) return 0;
    var p = dt / dur;
    /* 立ち上がり速く、落ちがゆっくり */
    return p < 0.18 ? U.easeOut(p / 0.18) : 1 - U.easeInOut((p - 0.18) / 0.82);
  }

  /* 関節のある人体を描く。
   *
   * 棒人間をやめ、肩・肘・腰・膝を持たせて太さのあるシルエットにしている。
   * 群衆の縮尺（高さ40〜70px）では、輪郭の面積と歩行時の脚の交差が
   * 「人が歩いている」という印象のほぼすべてを作る。
   * 線の細い棒人間だとこれが出ない。
   */

  /* 極座標で伸ばす。角は鉛直下向きが0、前（右）が正 */
  function ext(x, y, ang, len) {
    return { x: x + Math.sin(ang) * len, y: y + Math.cos(ang) * len };
  }

  function drawSpriteWalker(w, t, opts, p, h) {
    var fr = spriteFrame(w, t);
    var row = spriteRowFor(w);
    var scale = h / SPR.BODY_H;
    var size = SPR.CELL * scale;
    var fx = p.x - size / 2;
    var fy = p.y - SPR.FOOT * scale;

    var fog = U.clamp(1 - laneT(w.laneF) * 1.25, 0, 0.55);
    var alpha = (opts.alpha == null ? 1 : opts.alpha) * (1 - fog * 0.5);

    /* 倒れた者: 潰れて薄れる */
    var squash = 1;
    if (w.dead) {
      var ddt = t - w.deathT;
      if (ddt > 2.2) return;
      squash = U.clamp(1 - ddt / 0.55, 0.06, 1);
      alpha *= U.clamp(1 - (ddt - 0.55) / 1.5, 0, 1);
    }

    g.save();
    g.imageSmoothingEnabled = false;
    g.globalAlpha = alpha;
    if (squash < 1) {
      g.translate(p.x, p.y);
      g.scale(1, squash);
      g.translate(-p.x, -p.y);
    }
    /* 足元の影 */
    g.fillStyle = 'rgba(0,0,0,0.30)';
    g.beginPath();
    g.ellipse(p.x, p.y, h * 0.16, h * 0.035, 0, 0, Math.PI * 2);
    g.fill();

    g.drawImage(SPR.img,
      fr * SPR.CELL, row * SPR.CELL, SPR.CELL, SPR.CELL,
      fx, fy, size, size);

    /* 先導者の後光。脈打つ白 */
    if (opts.glow) {
      var pulse = 0.72 + 0.28 * Math.sin(t * 5.2);
      var gr = g.createRadialGradient(p.x, fy + (SPR.FOOT * 0.5 - SPR.FOOT) * scale, h * 0.1,
                                       p.x, fy + (SPR.FOOT * 0.5 - SPR.FOOT) * scale, h * 0.85);
      gr.addColorStop(0, 'rgba(235,245,255,' + (0.30 * pulse * alpha).toFixed(3) + ')');
      gr.addColorStop(1, 'rgba(235,245,255,0)');
      g.fillStyle = gr;
      g.beginPath();
      g.arc(p.x, fy + (SPR.FOOT * 0.5 - SPR.FOOT) * scale, h * 0.85, 0, 6.284);
      g.fill();
    }

    /* 名札（オンラインの他プレイヤー） */
    if (w.name) {
      var nfs = U.clamp(h * 0.14, 10, 18);
      g.font = nfs + 'px "Yu Mincho", serif';
      g.textAlign = 'center'; g.textBaseline = 'bottom';
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.fillText(w.name, p.x + 1, fy + 1 - h * 1.02);
      g.fillStyle = 'rgba(232,228,214,0.92)';
      g.fillText(w.name, p.x, fy - h * 1.02);
    }

    /* 先導者の旗 */
    if (opts.flag) {
      var poleX = p.x + size * 0.16;
      var poleTop = fy - h * 0.55;
      g.strokeStyle = opts.flag;
      g.lineWidth = Math.max(1, h * 0.02);
      g.beginPath(); g.moveTo(poleX, fy + h * 0.28); g.lineTo(poleX, poleTop); g.stroke();
      g.fillStyle = opts.flag;
      g.beginPath();
      g.moveTo(poleX, poleTop);
      g.lineTo(poleX + h * 0.22, poleTop + h * 0.06);
      g.lineTo(poleX, poleTop + h * 0.125);
      g.closePath(); g.fill();
    }

    g.globalAlpha = 1;
    g.restore();
  }

  R2.drawWalker = function (w, t, opts) {
    opts = opts || {};
    var p = screenOf(w.x, w.laneF);
    var h = CFG.bodyH * p.ppm * (opts.scale || 1) * (w.hMul || 1);
    if (h < 6) return;
    if (p.x < -80 || p.x > Wd + 80) return;

    if (SPR.ok) { drawSpriteWalker(w, t, opts, p, h); return; }

    var since = t - w.lastStepT;
    var interval = U.clamp(w.lastStepT - w.prevStepT, 0.18, 1.1);
    var prog = U.clamp(since / interval, 0, 1);

    /* 跳躍 */
    var jump = 0;
    if (w.lastStepK === 'J' && since >= 0 && since < 0.42) {
      jump = Math.sin(Math.PI * (since / 0.42)) * h * 0.22;
    }

    var fx = p.x, fy = p.y - jump;
    var build = w.bMul || 1;

    /* 人体の寸法（身長比） */
    var hipY = fy - h * 0.470;
    var shY = fy - h * 0.800;
    var neckY = fy - h * 0.845;
    var headR = h * 0.063 * build;
    var headY = fy - h * 0.905;
    var shW = h * 0.098 * build;
    var hipW = h * 0.070 * build;
    var thigh = h * 0.245, shin = h * 0.235;
    var upper = h * 0.175, fore = h * 0.170;

    var fog = U.clamp(1 - laneT(w.laneF) * 1.25, 0, 0.55);
    var alpha = (opts.alpha == null ? 1 : opts.alpha) * (1 - fog * 0.5);

    /* 倒れた者は路面に伏せる */
    var squash = 1;
    if (w.dead) {
      var ddt = t - w.deathT;
      if (ddt > 2.2) return;
      squash = U.clamp(1 - ddt / 0.55, 0, 1);
      alpha *= U.clamp(1 - (ddt - 0.55) / 1.5, 0, 1);
      if (squash <= 0.03) {
        g.globalAlpha = alpha * 0.75;
        g.fillStyle = w.color || '#2a2a30';
        g.beginPath();
        g.ellipse(fx, fy, h * 0.22, h * 0.035, 0, 0, Math.PI * 2);
        g.fill();
        g.globalAlpha = 1;
        return;
      }
    }

    /* 歩行の位相。踏み込むたび左右が入れ替わる */
    var dir = w.parity ? 1 : -1;
    var sw = 0.44;                       /* 振り幅(rad) */
    var aFront = U.lerp(-sw, sw, prog) * dir;
    var aBack = -aFront;
    var bendF = Math.sin(Math.PI * prog) * 0.55;   /* 振り出す脚の膝 */
    var bendB = 0.16;

    /* 腕は脚と逆に振れるだけ。ボタンが1つになったので、
     * 「どの手を挙げたか」を示す必要はもう無い。
     * 踏んだ瞬間に肩がわずかに沈むぶんだけ、拍が目に見える。 */
    var kick = raiseAmt(since, 0.22) * 0.16;
    var armR = -aFront * 0.85 - kick, armL = -aBack * 0.85 + kick;
    var elbowR = 0.34, elbowL = 0.34;

    g.save();
    if (squash < 1) {
      g.translate(fx, fy); g.scale(1, squash); g.translate(-fx, -fy);
    }
    g.globalAlpha = alpha;
    g.lineCap = 'round';
    g.lineJoin = 'round';

    var main = w.isPlayer ? w.colBody : (w.color || '#2c2c33');
    var headC = w.isPlayer ? w.colHead : main;
    var legC = w.isPlayer ? w.colHips : main;
    if (opts.color) { main = headC = legC = opts.color; }

    function leg(ang, bend, side, col, lw) {
      var hipX = fx + side * hipW * 0.55;
      var knee = ext(hipX, hipY, ang, thigh);
      var foot = ext(knee.x, knee.y, ang - bend, shin);
      g.strokeStyle = col;
      g.lineWidth = lw;
      g.beginPath();
      g.moveTo(hipX, hipY); g.lineTo(knee.x, knee.y); g.lineTo(foot.x, foot.y);
      g.stroke();
      /* 足 */
      g.lineWidth = lw * 0.55;
      g.beginPath();
      g.moveTo(foot.x, foot.y);
      g.lineTo(foot.x + h * 0.045, foot.y);
      g.stroke();
    }

    function arm(ang, bend, side, col, lw) {
      var sx2 = fx + side * shW * 0.72;
      var elbow = ext(sx2, shY, ang, upper);
      var hand = ext(elbow.x, elbow.y, ang + bend, fore);
      g.strokeStyle = col;
      g.lineWidth = lw;
      g.beginPath();
      g.moveTo(sx2, shY); g.lineTo(elbow.x, elbow.y); g.lineTo(hand.x, hand.y);
      g.stroke();
    }

    var legW = h * 0.072 * build;
    var armW = h * 0.052 * build;

    /* 縁取り（プレイヤーのみ）。群衆から確実に分離する */
    if (opts.outline) {
      g.strokeStyle = opts.outline; g.fillStyle = opts.outline;
      var o = h * 0.030;
      leg(aBack, bendB, -0.6, opts.outline, legW + o * 2);
      leg(aFront, bendF, 0.6, opts.outline, legW + o * 2);
      arm(armL, elbowL, -1, opts.outline, armW + o * 2);
      g.lineWidth = shW * 2 + o * 2;
      g.beginPath(); g.moveTo(fx, hipY); g.lineTo(fx, shY); g.stroke();
      arm(armR, elbowR, 1, opts.outline, armW + o * 2);
      g.beginPath(); g.arc(fx, headY, headR + o, 0, 6.284); g.fill();
    }

    /* 奥の脚と腕は少し沈める */
    var dark = 'rgba(0,0,0,0.30)';
    leg(aBack, bendB, -0.6, main, legW);
    g.globalAlpha = alpha * 0.55;
    g.strokeStyle = dark; g.lineWidth = legW; 
    g.globalAlpha = alpha;

    leg(aFront, bendF, 0.6, legC, legW);

    /* 奥の腕 */
    g.globalAlpha = alpha * 0.68;
    arm(armL, elbowL, -1, main, armW);
    g.globalAlpha = alpha;

    /* 胴。腰から肩へのカプセル＋肩幅 */
    g.strokeStyle = main;
    g.lineWidth = hipW * 2;
    g.beginPath(); g.moveTo(fx, hipY); g.lineTo(fx, fy - h * 0.62); g.stroke();
    g.lineWidth = shW * 1.75;
    g.beginPath(); g.moveTo(fx, fy - h * 0.64); g.lineTo(fx, shY); g.stroke();
    g.lineWidth = h * 0.055 * build;
    g.beginPath(); g.moveTo(fx - shW, shY); g.lineTo(fx + shW, shY); g.stroke();

    /* 首と頭 */
    g.lineWidth = h * 0.038 * build;
    g.beginPath(); g.moveTo(fx, shY); g.lineTo(fx, neckY); g.stroke();
    g.fillStyle = headC;
    g.beginPath(); g.ellipse(fx, headY, headR * 0.92, headR * 1.08, 0, 0, Math.PI * 2); g.fill();

    /* 手前の腕 */
    arm(armR, elbowR, 1, main, armW);

    /* 先導者の旗 */
    if (opts.flag) {
      var poleTop = headY - h * 0.95;
      g.strokeStyle = opts.flag;
      g.lineWidth = Math.max(1, h * 0.016);
      g.beginPath(); g.moveTo(fx + shW * 0.9, shY); g.lineTo(fx + shW * 0.9, poleTop); g.stroke();
      g.fillStyle = opts.flag;
      g.beginPath();
      g.moveTo(fx + shW * 0.9, poleTop);
      g.lineTo(fx + shW * 0.9 + h * 0.20, poleTop + h * 0.055);
      g.lineTo(fx + shW * 0.9, poleTop + h * 0.115);
      g.closePath(); g.fill();
    }

    g.globalAlpha = 1;
    g.restore();
  };

  /* 上から落ちるレーザー。prog 0..1 で降下、1で着弾 */
  R2.drawLaser = function (x, laneF, prog, t) {
    var p = screenOf(x, laneF);
    if (p.x < -60 || p.x > Wd + 60) return;
    var h = CFG.bodyH * p.ppm;
    var e = prog < 1 ? prog * prog : 1;
    var tipY = -30 + (p.y + 2 + 30) * e;
    var wCore = Math.max(2, h * 0.05);

    g.save();
    g.globalCompositeOperation = 'lighter';
    var gr = g.createLinearGradient(0, 0, 0, tipY);
    gr.addColorStop(0, 'rgba(200,235,255,0.05)');
    gr.addColorStop(1, 'rgba(235,250,255,0.9)');
    g.fillStyle = gr;
    g.fillRect(p.x - wCore * 2, 0, wCore * 4, tipY);
    g.fillStyle = 'rgba(255,255,255,0.95)';
    g.fillRect(p.x - wCore / 2, 0, wCore, tipY);

    if (prog >= 1) {
      /* 着弾の閃光 */
      var age = U.clamp((prog - 1) * 4, 0, 1);
      var r = h * (0.25 + age * 0.55);
      var fg = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      fg.addColorStop(0, 'rgba(255,255,255,' + (0.9 * (1 - age)).toFixed(3) + ')');
      fg.addColorStop(1, 'rgba(200,235,255,0)');
      g.fillStyle = fg;
      g.beginPath(); g.arc(p.x, p.y, r, 0, 6.284); g.fill();
    }
    g.restore();
    void t;
  };

  /* NPCの吹き出し。💬のように頭から横へずらし、とんがり口で本人を指す。
   * カメラが寄るほど文字も大きくなる */
  R2.drawBubble = function (w, text, alpha) {
    var p = screenOf(w.x, w.laneF);
    if (p.x < -120 || p.x > Wd + 120) return;
    var h = CFG.bodyH * p.ppm;
    var fs = U.clamp(h * 0.19, 11, 30);
    /* 出す側は本人ごとに固定（毎フレーム揺れないように） */
    var side = (w.id % 2 === 0) ? 1 : -1;
    var headX = p.x, headY = p.y - h * 0.98;
    var cx = p.x + side * h * 0.62;

    g.save();
    g.globalAlpha = alpha;
    g.font = fs + 'px "Yu Mincho", "Hiragino Mincho ProN", serif';
    var tw = g.measureText(text).width;
    var pad = fs * 0.45;
    var bw = tw + pad * 2;
    var bh = fs + pad * 1.1;
    var bx = cx - bw / 2 + side * bw * 0.18;
    var by = headY - bh - fs * 0.55;

    g.fillStyle = 'rgba(10,11,15,0.80)';
    g.strokeStyle = 'rgba(210,204,188,0.45)';
    g.lineWidth = 1;
    g.beginPath();
    if (g.roundRect) g.roundRect(bx, by, bw, bh, 5); else g.rect(bx, by, bw, bh);
    g.fill(); g.stroke();

    /* とんがり口。吹き出しの根元から本人の頭へ */
    var rootX = U.clamp(headX + side * fs * 0.9, bx + 6, bx + bw - 6);
    g.beginPath();
    g.moveTo(rootX - fs * 0.32, by + bh - 0.5);
    g.lineTo(rootX + fs * 0.32, by + bh - 0.5);
    g.lineTo(headX + side * fs * 0.15, headY);
    g.closePath();
    g.fill();

    g.fillStyle = '#ded8c8';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, bx + bw / 2, by + bh / 2);
    g.restore();
  };

  R2.drawMarks = function () {
    for (var i = 0; i < SW.world.marks.length; i++) {
      var m = SW.world.marks[i];
      var p = screenOf(m.x, m.laneF);
      if (p.x < -30 || p.x > Wd + 30) continue;
      var h = CFG.bodyH * p.ppm;
      g.globalAlpha = 0.30;
      g.fillStyle = m.color;
      g.beginPath();
      g.ellipse(p.x, p.y, h * 0.19, h * 0.042, 0, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = 1;
    }
  };

  /* ---- 演出 ---- */

  /* 監視車（プレイヤーの手前を並走） */
  R2.drawTruck = function (x, laneF, t, lightOn) {
    var p = screenOf(x, laneF);
    if (p.x < -260 || p.x > Wd + 260) return;
    var s = p.ppm;
    var w = 5.2 * s, h = 2.0 * s;
    var y = p.y;
    g.fillStyle = '#1b1d24';
    g.fillRect(p.x - w / 2, y - h, w, h);
    g.fillStyle = '#252832';
    g.fillRect(p.x - w / 2 + w * 0.55, y - h * 1.45, w * 0.34, h * 0.5);
    g.fillStyle = '#0e0f13';
    g.beginPath(); g.arc(p.x - w * 0.28, y, h * 0.24, 0, 6.284); g.fill();
    g.beginPath(); g.arc(p.x + w * 0.30, y, h * 0.24, 0, 6.284); g.fill();
    if (lightOn) {
      var blink = (Math.sin(t * 12) * 0.5 + 0.5);
      g.fillStyle = 'rgba(255,90,70,' + (0.35 + blink * 0.5).toFixed(2) + ')';
      g.beginPath(); g.arc(p.x, y - h * 1.62, h * 0.16, 0, 6.284); g.fill();
    }
  };

  /* スポットライト（警告） */
  R2.drawSpot = function (wk, intensity, t) {
    var p = screenOf(wk.x, wk.laneF);
    var h = CFG.bodyH * p.ppm;
    var r = h * 1.5;
    var flick = 0.85 + Math.sin(t * 26) * 0.15;
    var gr = g.createRadialGradient(p.x, p.y - h * 0.5, 0, p.x, p.y - h * 0.5, r);
    gr.addColorStop(0, 'rgba(255,240,190,' + (0.30 * intensity * flick).toFixed(3) + ')');
    gr.addColorStop(1, 'rgba(255,240,190,0)');
    g.fillStyle = gr;
    g.beginPath(); g.arc(p.x, p.y - h * 0.5, r, 0, 6.284); g.fill();
  };

  /* 走査ビーム。0..1 で画面を横切る */
  R2.drawBeam = function (prog) {
    var x = -Wd * 0.15 + prog * Wd * 1.3;
    var gr = g.createLinearGradient(x - 90, 0, x + 90, 0);
    gr.addColorStop(0, 'rgba(180,240,255,0)');
    gr.addColorStop(0.5, 'rgba(210,250,255,0.55)');
    gr.addColorStop(1, 'rgba(180,240,255,0)');
    g.fillStyle = gr;
    g.fillRect(x - 90, horizonY() - 40, 180, Ht);
  };

  /* 開示: 規定位置に縦線を引き、プレイヤーとのズレを見せる */
  R2.drawGapMarker = function (regX, playerW, alpha) {
    var lane = playerW.laneF;
    var a = screenOf(regX + playerW.baseX, lane);
    var b = screenOf(playerW.x, lane);
    var h = CFG.bodyH * a.ppm;
    g.save();
    g.globalAlpha = alpha;
    g.setLineDash([5, 5]);
    g.lineWidth = 1.5;
    g.strokeStyle = 'rgba(230,245,255,0.85)';
    g.beginPath(); g.moveTo(a.x, a.y - h * 1.35); g.lineTo(a.x, a.y + 4); g.stroke();
    g.setLineDash([]);
    g.strokeStyle = Math.abs(b.x - a.x) < h * 0.22 ? 'rgba(120,255,170,0.95)' : 'rgba(255,140,120,0.95)';
    g.lineWidth = 2.5;
    g.beginPath(); g.moveTo(a.x, a.y + 6); g.lineTo(b.x, a.y + 6); g.stroke();
    g.restore();
  };

  /* ---- フレーム ---- */

  R2.begin = function (dark) {
    g.clearRect(0, 0, Wd, Ht);
    drawSky(dark);
    drawHills();
    drawGround(dark);
    drawPoles();
  };

  R2.vignette = function (amount) {
    if (amount <= 0) return;
    var gr = g.createRadialGradient(Wd * 0.5, Ht * 0.55, Ht * 0.20, Wd * 0.5, Ht * 0.55, Ht * 0.95);
    gr.addColorStop(0, 'rgba(0,0,0,0)');
    gr.addColorStop(1, 'rgba(0,0,0,' + (0.75 * amount).toFixed(3) + ')');
    g.fillStyle = gr;
    g.fillRect(0, 0, Wd, Ht);
  };

  R2.size = function () { return { w: Wd, h: Ht }; };
  R2.ctx = function () { return g; };
})(window);
