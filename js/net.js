/* Short Walk - オンライン対戦の通信
 *
 * 方式: ラウンド単位のロックステップ。
 * ラウンド中は一切通信しない。終わったら自分のズレを1つ送るだけ。
 * 判定は各自のローカル時計基準なので、回線や端末の差でリズム感覚は狂わない。
 */
(function (global) {
  'use strict';
  var SW = global.SW || (global.SW = {});

  /* サーバの場所。本番に出すときはここを wss://…workers.dev に変える */
  var SERVER =
    (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
      ? 'ws://localhost:8787'
      : 'wss://short-walk.CHANGE-ME.workers.dev';

  var N = SW.net = {};
  var ws = null;
  var cb = {};          /* イベントコールバック */
  N.playerId = null;
  N.connected = false;

  N.on = function (ev, fn) { cb[ev] = fn; };
  function emit(ev, data) { if (cb[ev]) cb[ev](data); }

  N.quickMatch = function (name) {
    N.close();
    var url = SERVER + '/?name=' + encodeURIComponent(name || 'ナナシ');
    try {
      ws = new WebSocket(url);
    } catch (e) {
      emit('error', 'ツウシン デキマセン');
      return;
    }
    var opened = false;
    ws.onopen = function () { opened = true; N.connected = true; };
    ws.onmessage = function (e) {
      var m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      if (m.type === 'joined') { N.playerId = m.playerId; }
      emit(m.type, m);
    };
    ws.onerror = function () { if (!opened) emit('error', 'セツゾク シッパイ'); };
    ws.onclose = function () {
      N.connected = false;
      emit('closed', {});
    };
  };

  N.start = function () { send({ type: 'start' }); };
  N.sendResult = function (round, dev) { send({ type: 'result', round: round, dev: +dev.toFixed(3) }); };

  N.close = function () {
    if (ws) { cb = Object.assign({}, cb); try { ws.onclose = null; ws.close(); } catch (e) { /* noop */ } }
    ws = null;
    N.connected = false;
    N.playerId = null;
  };

  function send(o) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(o));
  }
})(window);
