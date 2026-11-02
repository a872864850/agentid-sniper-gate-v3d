import { makeGate } from './gate.mjs';
import { readFileSync } from 'node:fs';
const RPCS = ['https://bsc-rpc.publicnode.com','https://bsc-dataseed.bnbchain.org','https://bsc.publicnode.com'];
let ri=0;
async function rpc(m,p){for(let k=0;k<8;k++){try{const r=await fetch(RPCS[ri++%3],{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:m,params:p}),signal:AbortSignal.timeout(15000)});const j=await r.json();if(j.result!==undefined)return j.result;}catch{}await new Promise(r=>setTimeout(r,300));}throw new Error('rpc');}
const call=(to,data)=>rpc('eth_call',[{to,data},'latest']).catch(()=>null);
async function codeOf(a){return String(await rpc('eth_getCode',[a,'latest']).catch(()=>'')).toLowerCase();}
const wl = readFileSync('./watch.mjs','utf8').split(/\r?\n/);
const keccakHex = new Function(wl.slice(376,395).join('\n') + '\nreturn keccakHex;')();
if (keccakHex('') !== 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470') throw new Error('keccak bad');
const cfg = JSON.parse(readFileSync('./config.json','utf8')).sniping;
const gate = makeGate({call, codeOf, fullCode: async (c,cd)=>cd, keccakHex, cfg, log: console.log});
for (const a of process.argv.slice(2)) {
  const r = await gate.inspect(a);
  console.log(a, '→', r.v || '✅ 通過', JSON.stringify({sizes:r.info.sizes, router:r.info.router, lp:r.info.lpSels, backdoors:r.info.backdoors, soft:r.info.softs, owner:r.info.owner}));
}
