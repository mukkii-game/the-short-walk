/* Short Walk - 採点コア【現在は未使用】
 *
 * 採点は「最終的な位置の差だけ」に単純化したため、このモジュールは
 * index.html から読み込んでいない。リズムの精度そのものを評価に戻す
 * ことになったら、また使う。
 *
 * プレイヤーもNPCも、まったく同じこの関数で採点される。
 *
 *  ドリフト D : 誤差の中央値。系統的にテンポが速い/遅い。→ ゆるく採点（人間は必ずズレる）
 *  ブレ     J : 誤差から直線トレンドを引いた残差の標準偏差。刻みの不安定さ。→ 厳しく採点
 *  パターン P : 正解ボタン一致率。押し漏れ・空押しも分母に入る。→ 最も厳しく採点
 */
(function (global) {
  'use strict';
  var SW = global.SW || (global.SW = {});
  var U = SW.util;

  var J = SW.judge = {};

  /* 重み（バランス調整はここだけ触ればいい） */
  J.W = {
    alpha: 0.030,   /* ドリフト 1ms あたりの減点 */
    beta: 0.350,   /* ブレ 1ms あたりの減点 */
    gamma: 120.0    /* パターン精度の欠落 100% あたりの減点 */
  };

  /* 判定の対応付け窓（秒）
   * 狭くするとリズムが細かい課題だけ「対応付け失敗 → 押し漏れ＋空押しの二重減点」が
   * 起きて難易度が階段状に跳ね上がる。窓は広く取り、時間のズレは J（ブレ）で見る。 */
  function windowFor(slots) {
    var minGap = 1e9, i;
    for (i = 1; i < slots.length; i++) {
      var g = slots[i].t - slots[i - 1].t;
      if (g > 0.001 && g < minGap) minGap = g;
    }
    if (minGap > 1e8) minGap = 0.6;
    return Math.min(0.45, Math.max(0.22, minGap * 0.95));
  }

  /* 押下とスロットの対応付け。近いペアから貪欲に確定させる */
  J.match = function (slots, presses) {
    var win = windowFor(slots);
    var pairs = [], i, k, dt;
    for (i = 0; i < presses.length; i++) {
      for (k = 0; k < slots.length; k++) {
        dt = presses[i].t - slots[k].t;
        if (Math.abs(dt) <= win) pairs.push({ p: i, s: k, d: Math.abs(dt), e: dt });
      }
    }
    pairs.sort(function (a, b) { return a.d - b.d; });

    var usedP = {}, usedS = {}, matched = [];
    for (i = 0; i < pairs.length; i++) {
      var pr = pairs[i];
      if (usedP[pr.p] || usedS[pr.s]) continue;
      usedP[pr.p] = 1; usedS[pr.s] = 1;
      matched.push({
        slot: pr.s,
        st: slots[pr.s].t,
        e: pr.e,
        correct: presses[pr.p].k === slots[pr.s].k,
        got: presses[pr.p].k,
        want: slots[pr.s].k
      });
    }
    matched.sort(function (a, b) { return a.slot - b.slot; });

    var extras = 0;
    for (i = 0; i < presses.length; i++) if (!usedP[i]) extras++;

    return { matched: matched, extras: extras, misses: slots.length - matched.length, window: win };
  };

  /* 誤差から直線トレンドを引いた残差。
   * 回帰の x は「スロットの時刻」でなければならない。添字で回帰すると、
   * 八分と四分が混ざった不均等な譜面でドリフト成分が残り、
   * 凝ったリズムの課題だけブレが過大評価される（＝難易度が跳ねる）。 */
  function residuals(matched) {
    var n = matched.length, i;
    if (n < 3) return matched.map(function (m) { return m.e; });
    var sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (i = 0; i < n; i++) {
      var x = matched[i].st, y = matched[i].e;
      sx += x; sy += y; sxx += x * x; sxy += x * y;
    }
    var den = n * sxx - sx * sx;
    if (Math.abs(den) < 1e-9) return matched.map(function (m) { return m.e; });
    var b = (n * sxy - sx * sy) / den;
    var a = (sy - b * sx) / n;
    var out = [];
    for (i = 0; i < n; i++) out.push(matched[i].e - (a + b * matched[i].st));
    return out;
  }

  /* slots/presses: [{t, k}]  →  採点結果 */
  J.analyze = function (slots, presses) {
    var m = J.match(slots, presses);
    var es = [], corr = 0, i;
    for (i = 0; i < m.matched.length; i++) {
      es.push(m.matched[i].e);
      if (m.matched[i].correct) corr++;
    }

    var total = slots.length + m.extras;
    var P = total > 0 ? corr / total : 0;

    var D, Jt;
    if (m.matched.length < 3) {
      /* ほぼ歩けていない。壊滅的な扱い */
      D = 800; Jt = 250;
    } else {
      D = U.median(es) * 1000;
      Jt = U.stdev(residuals(m.matched)) * 1000;
    }

    var W = J.W;
    var score = 100 - W.alpha * Math.abs(D) - W.beta * Jt - W.gamma * (1 - P);
    score = U.clamp(score, 0, 100);

    return {
      D: D, J: Jt, P: P, score: score,
      hits: m.matched.length, misses: m.misses, extras: m.extras,
      matched: m.matched
    };
  };

  /* 追従フェーズ用のその場判定（学習補助。断絶中は絶対に呼ばない） */
  J.liveGrade = function (err) {
    var a = Math.abs(err);
    if (a <= 0.045) return { label: 'そろった', cls: 'good' };
    if (a <= 0.095) return { label: err < 0 ? 'すこし速い' : 'すこし遅い', cls: 'ok' };
    return { label: err < 0 ? '速い' : '遅い', cls: 'bad' };
  };
})(window);
