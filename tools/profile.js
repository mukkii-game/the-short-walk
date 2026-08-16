global.window = global; global.localStorage={getItem(){return null;},setItem(){}};
require('../js/util.js'); require('../js/patterns.js'); require('../js/judge.js');
const SW=global.SW,U=SW.util;
function buildRound(idx){const c=SW.rounds[idx],beat=60/c.bpm,bar=beat*4,slots=[];
 for(let b=0;b<c.black;b++)for(const p of c.pattern)slots.push({t:b*bar+p.b*beat,k:p.k});
 return {slots,tEnd:c.black*bar,idx,cfg:c,pool:[...new Set(c.pattern.map(p=>p.k))]};}
function play(w,R){const out=[];const panic=w.panicBase*(1+R.idx*0.15);const span=R.tEnd;
 let pool=R.pool.length>1?R.pool:['R','L'];
 for(const s of R.slots){const dt=s.t,prog=dt/span;
  if(Math.random()<w.dropRate*(0.35+prog))continue;
  const sig=w.sigma0*(1+panic*dt);const e=w.bias*dt+U.gauss(0,sig);let k=s.k;
  if(Math.random()<w.patErr*(0.5+prog)){const a=pool.filter(x=>x!==s.k);if(a.length)k=a[0];}
  out.push({t:s.t+e,k});} out.sort((a,b)=>a.t-b.t);return out;}
const P={sigma0:0.030,bias:0.008,patErr:0.015,dropRate:0.005,panicBase:0.03};
for(const idx of [0,1,3,5,9]){
  const R=buildRound(idx);
  let acc={D:0,J:0,P:0,s:0};const N=200;
  for(let i=0;i<N;i++){const r=SW.judge.analyze(R.slots,play(P,R));
    acc.D+=Math.abs(r.D);acc.J+=r.J;acc.P+=r.P;acc.s+=r.score;}
  console.log(`R${idx+1} slots=${R.slots.length} 無音${R.cfg.black}小節(${R.tEnd.toFixed(1)}s)`,
    '|D|',(acc.D/N).toFixed(0),'J',(acc.J/N).toFixed(0),'P',(acc.P/N).toFixed(3),
    '→ score',(acc.s/N).toFixed(1));
}
