/* Short Walk - お題（譜面）定義
 *
 * ボタンは1つだけ。押した瞬間に一歩進む。
 * 難易度は「いつ押すか」だけで作る。
 *
 *   groups  : ひとつのお題を構成する拍子。[4] なら四拍子、[4,7] なら四拍子＋七拍子
 *   pattern : 拍位置の並び（お題の先頭を 0、1拍を 1.0 とする）
 *   demo / echo / black : それぞれ「お題を何回ぶん」か
 *
 * groups が2つ以上あるお題では、先導者の足音が拍子ごとに変わる。
 * 数えるのではなく、音の変わり目で節を掴ませるため。
 *
 * 刻みは八分音符までに抑えている。十六分を入れると判定窓が
 * 人間の揺らぎより狭くなり、運ゲーになるため。
 */
(function (global) {
  'use strict';
  var SW = global.SW || (global.SW = {});

  SW.WALK_SPEED = 1.1111;   /* 4 km/h = 1.1111 m/s */

  SW.rounds = [
    { /* 1 */
      bpm: 100, groups: [4], demo: 2, echo: 2, black: 4,
      name: '四つ',
      note: '一定の間隔で四つ',
      pattern: [0, 1, 2, 3]
    },
    { /* 2 */
      bpm: 102, groups: [4], demo: 2, echo: 2, black: 6,
      name: 'つまずき',
      note: '八分が混ざり、無音が伸びる',
      pattern: [0, 1, 1.5, 2, 3]
    },
    { /* 3 */
      bpm: 104, groups: [7], demo: 3, echo: 2, black: 5,
      name: '七つ',
      note: '四つではない。数えても割り切れない',
      pattern: [0, 1, 2, 3, 4, 5, 6]
    },
    { /* 4 */
      bpm: 106, groups: [4], demo: 3, echo: 2, black: 8,
      name: 'ずらす',
      note: '食う。拍の頭がほとんど無い',
      pattern: [0, 0.5, 1.5, 2.5, 3]
    },
    { /* 5 */
      bpm: 108, groups: [7, 4], demo: 3, echo: 2, black: 5,
      name: '最後の二人',
      note: '七拍から四拍へ。総合試験',
      pattern: [0, 1, 1.5, 2, 3, 4, 5, 5.5, 6, 7, 7.5, 8, 9, 9.5, 10]
    }
  ];

  /* 各ラウンド終了時の生存数。12 → 8 → 5 → 3 → 2 → 1
   * 枠の距離ではなく順位で切る。ズレの大きい下位から処理される。 */
  SW.TARGETS = [8, 5, 3, 2, 1];

  /* 各お題の合計拍数と、拍位置がどの拍子に属するか */
  SW.rounds.forEach(function (r) {
    var total = 0, bounds = [];
    r.groups.forEach(function (g) { bounds.push(total); total += g; });
    r.beats = total;
    r.slots = r.pattern.map(function (b) {
      var gi = 0;
      for (var i = 0; i < bounds.length; i++) if (b >= bounds[i]) gi = i;
      return { b: b, g: gi };
    });
  });

  /* 参加人数。道幅いっぱいの横一列に並ぶぶんだけ。
   * 大群衆はやめた。全員の顔（ズレ具合）が見える人数に絞り、
   * 「少しずつ減っていく」を1人単位で見せる。 */
  SW.START_COUNT = 12;   /* プレイヤー含む。先導者は別 */


})(window);
