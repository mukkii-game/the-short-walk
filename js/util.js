/* Short Walk - 汎用ユーティリティ */
(function (global) {
  'use strict';
  var SW = global.SW || (global.SW = {});

  var U = SW.util = {};

  U.clamp = function (v, a, b) { return v < a ? a : (v > b ? b : v); };
  U.lerp = function (a, b, t) { return a + (b - a) * t; };
  U.rand = function (a, b) { return a + Math.random() * (b - a); };
  U.randInt = function (a, b) { return Math.floor(a + Math.random() * (b - a + 1)); };
  U.pick = function (arr) { return arr[Math.floor(Math.random() * arr.length)]; };

  /* Box-Muller 正規乱数 */
  U.gauss = function (mu, sigma) {
    var u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  U.median = function (arr) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };

  U.mean = function (arr) {
    if (!arr.length) return 0;
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
  };

  U.stdev = function (arr) {
    if (arr.length < 2) return 0;
    var m = U.mean(arr), s = 0;
    for (var i = 0; i < arr.length; i++) { var d = arr[i] - m; s += d * d; }
    return Math.sqrt(s / (arr.length - 1));
  };

  /* y = a + b*x の最小二乗。x は 0..n-1 の添字 */
  U.detrend = function (ys) {
    var n = ys.length;
    if (n < 3) return ys.slice();
    var sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (var i = 0; i < n; i++) { sx += i; sy += ys[i]; sxx += i * i; sxy += i * ys[i]; }
    var den = n * sxx - sx * sx;
    if (Math.abs(den) < 1e-9) return ys.slice();
    var b = (n * sxy - sx * sy) / den;
    var a = (sy - b * sx) / n;
    var out = new Array(n);
    for (var j = 0; j < n; j++) out[j] = ys[j] - (a + b * j);
    return out;
  };

  U.pad = function (n, w) {
    var s = '' + n;
    while (s.length < w) s = '0' + s;
    return s;
  };

  /* 数値をカンマ区切り */
  U.num = function (n) { return ('' + n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); };

  /* 0..1 の ease */
  U.easeOut = function (t) { return 1 - Math.pow(1 - t, 3); };
  U.easeIn = function (t) { return t * t * t; };
  U.easeInOut = function (t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };

  U.storage = {
    get: function (k, dflt) {
      try {
        var v = global.localStorage.getItem(k);
        return v === null ? dflt : JSON.parse(v);
      } catch (e) { return dflt; }
    },
    set: function (k, v) {
      try { global.localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* noop */ }
    }
  };
})(window);
