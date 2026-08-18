/* Short Walk - サウンドエンジン
 *
 * 鉄則: 判定に使う時刻は必ず AudioContext.currentTime。
 *       setTimeout / Date.now / performance.now は判定に使わない。
 * 音源はすべて WebAudio で合成（外部アセットなし = GitHub Pages にそのまま置ける）。
 */
(function (global) {
  'use strict';
  var SW = global.SW || (global.SW = {});

  var ctx = null;
  var master = null;      // 全体
  var busSfx = null;      // クリック・足音・演出
  var busMusic = null;    // BGM
  var busAmb = null;      // 環境音（風）
  var noiseBuf = null;
  var scheduled = [];     // 未来に予約済みのノード（中断時に止める）
  var windNodes = null;
  var eerieNodes = null;
  var ready = false;

  function makeNoise() {
    var len = Math.floor(ctx.sampleRate * 2.0);
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  function track(node) {
    scheduled.push(node);
    if (scheduled.length > 400) scheduled.splice(0, 200);
    return node;
  }

  /* ---- 実音源レイヤー ----
   *
   * assets/sfx/ に該当ファイルがあればそれを鳴らし、無ければ合成音に落ちる。
   * 差し替え手順は assets/README.md を参照。
   * file:// で開くと fetch が CORS で失敗するため、実音源を使うときは
   * ローカルサーバか GitHub Pages 経由で開くこと（合成音では問題ない）。
   */
  var MANIFEST = {
    stepR:      'step_r',       /* 右手を上げて踏む足音 */
    stepL:      'step_l',       /* 左手 */
    stepJ:      'step_jump',    /* 着地 */
    horn:       'horn',         /* 照合開始の合図 */
    thud:       'thud',         /* 照合の一撃 */
    ui:         'ui',           /* 画面操作。重低音を短く */
    beam:       'beam',         /* 走査ビーム */
    zap:        'zap',          /* 処理音（1体） */
    dead:       'dead',
    fanfare:    'fanfare',
    wind:       'wind_loop',    /* 環境音。ループ。周期性のない素材を選ぶこと */
    bed:        'bed_loop'      /* 提示・追従フェーズの下敷き。拍のない持続音のみ */
  };

  /* 拡張子はこの順で探す。
   * クリックと足音は mp3 を避けること。mp3 はエンコード時に数十msの無音が
   * 先頭に入り、それがそのままリズムの基準のズレになる。wav か ogg を使う。 */
  var EXTS = ['.wav', '.ogg', '.mp3'];
  var DIR = 'assets/sfx/';

  var raw = {};      /* name -> ArrayBuffer */
  var buf = {};      /* name -> AudioBuffer */
  var bedSrc = null;
  var windSrc = null;

  function tryFetch(name, i) {
    if (i >= EXTS.length) return;
    global.fetch(DIR + MANIFEST[name] + EXTS[i])
      .then(function (r) { return r.ok ? r.arrayBuffer() : null; })
      .then(function (b) {
        if (b && b.byteLength > 64) { raw[name] = b; decodeOne(name); }
        else tryFetch(name, i + 1);
      })
      .catch(function () { tryFetch(name, i + 1); });
  }

  function fetchAll() {
    if (!global.fetch) return;
    Object.keys(MANIFEST).forEach(function (name) { tryFetch(name, 0); });
  }

  function decodeOne(name) {
    if (!ctx || !raw[name] || buf[name]) return;
    var data = raw[name];
    raw[name] = null;
    try {
      ctx.decodeAudioData(data.slice(0), function (b) { buf[name] = b; }, function () {});
    } catch (e) { /* 非対応形式 */ }
  }

  function decodeAll() { Object.keys(MANIFEST).forEach(decodeOne); }

  /* 読み込み済みならサンプルを鳴らして true を返す */
  function sample(name, t, vol, bus, rate) {
    if (!ready || !buf[name]) return false;
    var s = ctx.createBufferSource();
    s.buffer = buf[name];
    if (rate) s.playbackRate.value = rate;
    var g = ctx.createGain();
    g.gain.value = vol == null ? 1 : vol;
    s.connect(g); g.connect(bus || busSfx);
    s.start(t);
    track(s);
    return true;
  }

  var A = SW.audio = {

    manifest: MANIFEST,
    has: function (name) { return !!buf[name]; },
    loaded: function () { return Object.keys(buf); },


    /* ユーザー操作の中で呼ぶこと（自動再生ポリシー） */
    init: function () {
      if (ready) {
        if (ctx.state === 'suspended') ctx.resume();
        return;
      }
      var AC = global.AudioContext || global.webkitAudioContext;
      ctx = new AC({ latencyHint: 'interactive' });
      master = ctx.createGain(); master.gain.value = 0.9; master.connect(ctx.destination);
      busSfx = ctx.createGain(); busSfx.gain.value = 1.0; busSfx.connect(master);
      busMusic = ctx.createGain(); busMusic.gain.value = 0.55; busMusic.connect(master);
      busAmb = ctx.createGain(); busAmb.gain.value = 0.0; busAmb.connect(master);
      noiseBuf = makeNoise();
      ready = true;
      if (ctx.state === 'suspended') ctx.resume();

      /* iOS対策。
       * 1) WebAudioは既定で「着信音」扱いになり、サイレントスイッチONだと無音になる。
       *    audioSession を playback にすると、メディア再生扱いになりマナーでも鳴る */
      try {
        if (navigator.audioSession) navigator.audioSession.type = 'playback';
      } catch (e) { /* 未対応ブラウザ */ }
      /* 2) 無音の<audio>を一度再生してメディアセッションを確立させる保険 */
      try {
        var un = document.createElement('audio');
        un.setAttribute('playsinline', '');
        un.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
        un.volume = 0.01;
        var pr = un.play();
        if (pr && pr.catch) pr.catch(function () { /* 拒否されても実害なし */ });
      } catch (e) { /* noop */ }
      /* 3) iOSはタブ切替や着信で AudioContext が止まったまま戻ることがある。
       *    以後の操作のたびに復帰を試みる */
      if (!global.__swResumeHook) {
        global.__swResumeHook = true;
        var kick = function () {
          if (ctx && ctx.state !== 'running') { try { ctx.resume(); } catch (e) { /* noop */ } }
        };
        document.addEventListener('pointerdown', kick, true);
        document.addEventListener('keydown', kick, true);
        document.addEventListener('visibilitychange', function () {
          if (!document.hidden) kick();
        });
      }
      decodeAll();
    },

    ok: function () { return ready; },

    /* 録画用: ゲーム音声を MediaStream として取り出す */
    tapStream: function () {
      if (!ready) return null;
      var msd = ctx.createMediaStreamDestination();
      master.connect(msd);
      return msd.stream;
    },
    now: function () { return ready ? ctx.currentTime : 0; },
    ctx: function () { return ctx; },

    /* 予約済みの音を全部止める（ラウンド中断・リトライ時） */
    panic: function () {
      for (var i = 0; i < scheduled.length; i++) {
        try { scheduled[i].stop(0); } catch (e) { /* 既に停止済み */ }
      }
      scheduled.length = 0;
    },

    /* ---- 基本波形ヘルパ ---- */

    blip: function (t, freq, dur, vol, type, bus) {
      if (!ready) return;
      var o = ctx.createOscillator();
      var g = ctx.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(bus || busSfx);
      o.start(t); o.stop(t + dur + 0.05);
      track(o);
      return o;
    },

    sweep: function (t, f0, f1, dur, vol, type, bus) {
      if (!ready) return;
      var o = ctx.createOscillator();
      var g = ctx.createGain();
      o.type = type || 'sawtooth';
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(bus || busSfx);
      o.start(t); o.stop(t + dur + 0.05);
      track(o);
    },

    noise: function (t, dur, vol, filterType, freq, q, bus) {
      if (!ready) return;
      var s = ctx.createBufferSource();
      s.buffer = noiseBuf;
      s.loop = true;
      var f = ctx.createBiquadFilter();
      f.type = filterType || 'bandpass';
      f.frequency.setValueAtTime(freq, t);
      f.Q.value = q || 1;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(f); f.connect(g); g.connect(bus || busSfx);
      s.start(t); s.stop(t + dur + 0.05);
      track(s);
      return f;
    },

    /* ---- ゲーム内の音 ---- */

    /* このゲームにメトロノームは無い。
     * リズムの手本は先導者の足音そのもので示す。
     * クリックのような拍を刻む記号音は、意図的に一切用意していない。 */

    /* 足音。btn: 'R' | 'L' | 'J'
     * 左右は録音のテイクを変えたうえで、わずかに音程もずらす。
     * 「どのボタンか」を目だけでなく耳でも判別できるようにするため。 */
    step: function (t, btn, vol) {
      var v = vol == null ? 0.5 : vol;
      var nm = btn === 'J' ? 'stepJ' : (btn === 'L' ? 'stepL' : 'stepR');
      var base = btn === 'J' ? 0.86 : (btn === 'L' ? 0.93 : 1.05);
      /* 素材の単調さを消すため、毎回わずかに散らす */
      if (sample(nm, t, v * 1.6, null, base + (Math.random() - 0.5) * 0.05)) return;
      if (btn === 'J') {
        A.noise(t, 0.10, 0.30 * v, 'bandpass', 420, 0.8);
        A.sweep(t, 260, 520, 0.13, 0.16 * v, 'triangle');
      } else if (btn === 'L') {
        A.noise(t, 0.075, 0.34 * v, 'bandpass', 700, 1.1);
      } else {
        A.noise(t, 0.075, 0.34 * v, 'bandpass', 1250, 1.1);
      }
    },

    /* 環境音（風）。周期性を持たせない = 断絶中のメトロノーム代わりにさせない */
    windStart: function () {
      if (!ready || windNodes) return;
      if (buf.wind) {
        var ws = ctx.createBufferSource();
        ws.buffer = buf.wind; ws.loop = true;
        ws.connect(busAmb); ws.start();
        windSrc = ws;
        windNodes = { s: ws };
        return;
      }
      var s = ctx.createBufferSource();
      s.buffer = noiseBuf; s.loop = true;
      var lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 400; lp.Q.value = 0.4;
      var g = ctx.createGain(); g.gain.value = 0.5;
      /* 無理数比の2本のLFOでフィルタを揺らす → 周期が知覚できない */
      var l1 = ctx.createOscillator(); l1.frequency.value = 0.071;
      var l2 = ctx.createOscillator(); l2.frequency.value = 0.0313;
      var a1 = ctx.createGain(); a1.gain.value = 170;
      var a2 = ctx.createGain(); a2.gain.value = 95;
      l1.connect(a1); a1.connect(lp.frequency);
      l2.connect(a2); a2.connect(lp.frequency);
      s.connect(lp); lp.connect(g); g.connect(busAmb);
      s.start(); l1.start(); l2.start();
      windNodes = { s: s, l1: l1, l2: l2 };
    },

    /* 不気味な接近音。うなりを持つ低い二重音と、かすかな高い笛。
     * 無理数比の周波数で、周期を感じさせない */
    eerieStart: function () {
      if (!ready || eerieNodes) return;
      var g1 = ctx.createGain(); g1.gain.value = 0.0001; g1.connect(master);
      var o1 = ctx.createOscillator(); o1.type = 'sine'; o1.frequency.value = 92.6;
      var o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = 96.1;
      var o3 = ctx.createOscillator(); o3.type = 'sine'; o3.frequency.value = 1873;
      var g3 = ctx.createGain(); g3.gain.value = 0.014;
      var lfo = ctx.createOscillator(); lfo.frequency.value = 0.113;
      var lg = ctx.createGain(); lg.gain.value = 0.06;
      lfo.connect(lg); lg.connect(g1.gain);
      o1.connect(g1); o2.connect(g1); o3.connect(g3); g3.connect(g1);
      o1.start(); o2.start(); o3.start(); lfo.start();
      g1.gain.setTargetAtTime(0.16, ctx.currentTime, 2.5);
      eerieNodes = { g: g1, stop: function () {
        try { o1.stop(); o2.stop(); o3.stop(); lfo.stop(); } catch (e) { /* 停止済み */ }
      } };
    },

    eerieStop: function (fade) {
      if (!eerieNodes) return;
      var n = eerieNodes; eerieNodes = null;
      n.g.gain.setTargetAtTime(0.0001, ctx.currentTime, fade || 0.8);
      setTimeout(function () { n.stop(); }, (fade || 0.8) * 4000);
    },

    /* 環境音の音量。0..1 */
    ambLevel: function (v, ramp) {
      if (!ready) return;
      var t = ctx.currentTime;
      busAmb.gain.cancelScheduledValues(t);
      busAmb.gain.setValueAtTime(busAmb.gain.value, t);
      busAmb.gain.linearRampToValueAtTime(v, t + (ramp || 0.6));
    },

    /* 提示・追従フェーズの下敷き。
     * 拍を刻むものは絶対に鳴らさない。テンポの手がかりは足音だけに限る。
     * bed_loop があればそれを、無ければ拍のない合成ドローンを鳴らす。 */
    bedStart: function (t) {
      if (!ready) return;
      A.bedStop();
      if (buf.bed) {
        var s2 = ctx.createBufferSource();
        s2.buffer = buf.bed; s2.loop = true;
        s2.connect(busMusic);
        s2.start(t);
        bedSrc = s2;
        track(s2);
        return;
      }
      /* 合成ドローン: 低い持続音を2本、無理数比のLFOで揺らす */
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.22, t + 1.2);
      g.connect(busMusic);
      var o1 = ctx.createOscillator(); o1.type = 'triangle'; o1.frequency.value = 55;
      var o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = 82.4;
      var g2 = ctx.createGain(); g2.gain.value = 0.35;
      var lfo = ctx.createOscillator(); lfo.frequency.value = 0.083;
      var lg = ctx.createGain(); lg.gain.value = 0.14;
      lfo.connect(lg); lg.connect(g2.gain);
      o1.connect(g); o2.connect(g2); g2.connect(g);
      o1.start(t); o2.start(t); lfo.start(t);
      bedSrc = { stop: function (x) { o1.stop(x); o2.stop(x); lfo.stop(x); }, gain: g };
      track({ stop: function () { try { o1.stop(0); o2.stop(0); lfo.stop(0); } catch (e) { /* 停止済み */ } } });
    },

    bedStop: function () {
      if (!bedSrc) return;
      try { bedSrc.stop(0); } catch (e) { /* 停止済み */ }
      bedSrc = null;
    },

    musicLevel: function (v, ramp) {
      if (!ready) return;
      var t = ctx.currentTime;
      busMusic.gain.cancelScheduledValues(t);
      busMusic.gain.setValueAtTime(busMusic.gain.value, t);
      busMusic.gain.linearRampToValueAtTime(v, t + (ramp || 0.4));
    },

    /* 画面操作。ピコ音は使わない */
    ui: function (t) {
      if (sample('ui', t, 0.7)) return;
      A.blip(t, 92, 0.28, 0.30, 'sine');
      A.blip(t, 138, 0.14, 0.10, 'triangle');
    },

    /* 照合の一撃 */
    thud: function (t) {
      if (sample('thud', t, 0.8)) return;
      A.sweep(t, 120, 42, 0.45, 0.42, 'sine');
    },

    /* ジャッジ開始の合図 */
    horn: function (t) {
      if (sample('horn', t, 0.9)) return;
      A.blip(t, 180, 0.5, 0.30, 'sawtooth');
      A.blip(t + 0.02, 181.5, 0.5, 0.22, 'sawtooth');
    },

    /* 走査ビーム */
    beam: function (t) {
      if (sample('beam', t, 0.85)) return;
      A.sweep(t, 2400, 200, 0.55, 0.20, 'sawtooth');
      A.noise(t, 0.55, 0.14, 'bandpass', 1800, 0.7);
    },

    /* 処理音（1体ぶん）。非グロ、事務的に */
    zap: function (t) {
      if (sample('zap', t, 0.5)) return;
      A.blip(t, 1400, 0.05, 0.12, 'square');
      A.noise(t + 0.02, 0.09, 0.16, 'lowpass', 900, 1);
    },

    /* 脱落。驚かせない。低く長く響かせる */
    dead: function (t) {
      if (sample('dead', t, 0.95)) return;
      A.blip(t, 110, 2.4, 0.30, 'sine');
      A.blip(t + 0.01, 164.8, 2.0, 0.12, 'sine');
    },

    /* 完歩 */
    fanfare: function (t) {
      if (sample('fanfare', t, 0.95)) return;
      A.blip(t, 220, 3.0, 0.26, 'sine');
      A.blip(t + 0.02, 330, 2.6, 0.12, 'sine');
    }
  };

  fetchAll();
  void windSrc;
})(window);
