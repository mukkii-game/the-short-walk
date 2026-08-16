/* 難易度カーブの検証。ブラウザを開かずに位置モデルだけ回す。
 *   node tools/balance.js
 * 判定は「先導者との位置の差」だけ。ズレはラウンドをまたいで持ち越す。 */
global.window = global;
global.localStorage = { getItem(){return null;}, setItem(){} };
require('../js/util.js'); require('../js/patterns.js');
const SW = global.SW, U = SW.util;
const SPEED = SW.WALK_SPEED;

function buildRound(idx){
  const c = SW.rounds[idx];
  const beat = 60 / c.bpm, phrase = beat * c.beats;
  return { cfg:c, idx, beat, phrase,
    tEcho:0, tBlack:c.echo*phrase, tEnd:(c.echo+c.black)*phrase,
    stepDist: SPEED * phrase / c.pattern.length };
}
const ROUNDS = SW.rounds.map((_,i)=>buildRound(i));

/* そのラウンドで進んだ距離。位置は連続量（歩数＋次の一歩への進みぶん） */
function walkOf(w, R){
  const panic = w.panicBase * (1 + R.idx * 0.15);
  const span = Math.max(0.001, R.tEnd - R.tBlack);
  const wanderSigma = w.sigma0 * 0.085;
  let tempo = 1 + w.bias, wander = 0, phase = R.tEcho;
  let n = 0, last = R.tEcho, pace = R.phrase / R.cfg.pattern.length, guard = 0;
  while (phase < R.tEnd && guard++ < 400) {
    const rate = Math.max(0.55, tempo + wander);
    for (const b of R.cfg.pattern) {
      const t = phase + b * R.beat / rate;
      if (t >= R.tEnd) break;
      const prog = U.clamp((t - R.tBlack) / span, 0, 1.4);
      if (Math.random() < w.dropRate * (0.35 + prog)) continue;
      const sigma = w.sigma0 * (1 + panic * Math.max(0, t - R.tBlack));
      const tt = t + U.gauss(0, sigma);
      if (n > 0) pace += (U.clamp(tt - last, 0.12, 1.6) - pace) * 0.45;
      last = tt; n++;
      if (Math.random() < w.patErr * 0.5 * (0.5 + prog)) { last = tt + 0.14; n++; }
    }
    phase += R.phrase / rate;
    wander += U.gauss(0, wanderSigma);
  }
  const frac = U.clamp((R.tEnd - last) / pace, 0, 1.25);
  return n > 0 ? (n - 1 + frac) * R.stepDist : 0;
}

const C = { s1:0.112, slope:0.0076, lowSlope:0.068, sMin:0.027, rMax:11,
  b1:0.043, bSlope:0.0037, p1:0.28, pSlope:0.028, d1:0.13, dSlope:0.013,
  k1:0.16, kSlope:0.014 };
const TYPES = [
  { key:'steady',  w:26, bias:0.22, sign:0,  jitter:0.75, recover:0.75 },
  { key:'rush',    w:24, bias:1.35, sign:1,  jitter:1.00, recover:0.50 },
  { key:'drag',    w:24, bias:1.35, sign:-1, jitter:1.00, recover:0.50 },
  { key:'erratic', w:18, bias:0.30, sign:0,  jitter:1.75, recover:0.55 },
  { key:'lost',    w:8,  bias:2.80, sign:0,  jitter:2.10, recover:0.05 }
];
const TW = TYPES.reduce((a,t)=>a+t.w,0);
function pickType(){ let r=Math.random()*TW; for(const t of TYPES){ r-=t.w; if(r<=0) return t; } return TYPES[0]; }

function mkNpc(){
  let u = Math.random(); if (u > 0.99995) u = 0.99995;
  const r = Math.min(C.rMax, -Math.log2(1 - u) - 0.415);
  const sig = r >= 1 ? C.s1 - C.slope*(r-1) : C.s1 + C.lowSlope*(1-r);
  const ty = pickType();
  const sign = ty.sign !== 0 ? ty.sign : (Math.random() < 0.5 ? -1 : 1);
  return { type: ty.key, dev: 0, recover: ty.recover,
    sigma0: U.clamp(sig*ty.jitter, C.sMin*0.8, 0.260),
    bias: U.clamp(C.b1 - C.bSlope*(r-1), 0.0025, 0.075) * ty.bias * sign,
    patErr: U.clamp(C.p1 - C.pSlope*(r-1), 0.004, 0.55),
    dropRate: U.clamp(C.d1 - C.dSlope*(r-1), 0.002, 0.30),
    panicBase: U.clamp(C.k1 - C.kSlope*(r-1), 0.018, 0.40) };
}

/* 現行ルール: ラウンド末にペースメーカーが現れ、枠の外にいた者が処刑される。
 * 生き残りのズレは次の提示中に列へ戻る（＝毎ラウンドほぼリセット） */
function run(pp, trace){
  let npcs = []; for (let i = 0; i < SW.START_COUNT-1; i++) npcs.push(mkNpc());
  const pl = Object.assign({}, pp);
  for (let idx = 0; idx < ROUNDS.length; idx++) {
    const R = ROUNDS[idx];
    const limit = SW.limitFor(idx);
    const correct = SPEED * (R.tEnd - R.tEcho);
    const devP = walkOf(pl, R) - correct;
    const devs = npcs.map(w => walkOf(w, R) - correct);
    const before = npcs.length;
    npcs = npcs.filter((w, i) => Math.abs(devs[i]) <= limit);
    if (trace) trace.push(`R${idx+1} 自分${devP.toFixed(2)}m 枠±${limit.toFixed(2)} NPC死${before-npcs.length} 残${npcs.length+1}`);
    if (Math.abs(devP) > limit) return idx;
    if (npcs.length === 0) return ROUNDS.length;
  }
  return ROUNDS.length;
}

/* recover = 手本の間に先導者との差を見て歩調を直せる度合い。人間の腕前そのもの */
const PROF = {
 '下手 3.0% 補正0.2': { sigma0:0.060, bias:0.030, patErr:0.10, dropRate:0.05, panicBase:0.10, recover:0.20 },
 '普通 1.8% 補正0.4': { sigma0:0.045, bias:0.018, patErr:0.05, dropRate:0.025, panicBase:0.06, recover:0.40 },
 '中上 1.2% 補正0.55':{ sigma0:0.036, bias:0.012, patErr:0.03, dropRate:0.012, panicBase:0.04, recover:0.75 },
 '上手 0.8% 補正0.7': { sigma0:0.029, bias:0.008, patErr:0.015, dropRate:0.005, panicBase:0.03, recover:0.70 },
 '達人 0.4% 補正0.85':{ sigma0:0.022, bias:0.004, patErr:0.00, dropRate:0.00, panicBase:0.02, recover:0.85 }
};

const N = 30;
for (const [name, p] of Object.entries(PROF)) {
  let sum = 0, clears = 0; const dist = {};
  for (let i = 0; i < N; i++) { const r = run(p); sum += r; if (r === 10) clears++; dist[r]=(dist[r]||0)+1; }
  console.log(name.padEnd(20), '平均', (sum/N).toFixed(1), '完歩', (clears/N*100).toFixed(0)+'%', JSON.stringify(dist));
}
console.log('\n--- 上手プロファイルの1周ぶん ---');
const tr = []; run(PROF['上手 0.8% 補正0.7'], tr); tr.forEach(l => console.log(' ', l));
