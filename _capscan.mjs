import { readFileSync } from "node:fs";
import { makeGate } from "./gate.mjs";
const RPCS=["https://bsc-rpc.publicnode.com","https://bsc-dataseed.bnbchain.org","https://bsc.publicnode.com"];
let ri=0;
async function rpc(m,p){for(let k=0;k<10;k++){try{const r=await fetch(RPCS[ri++%3],{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:m,params:p}),signal:AbortSignal.timeout(15000)});const j=await r.json();if(j.result!==undefined)return j.result;}catch{}await new Promise(r=>setTimeout(r,200));}throw new Error("rpc "+m);}
const call=(to,data)=>rpc("eth_call",[{to,data},"latest"]).catch(()=>null);
const cc=new Map(); const codeOf=async a=>{if(!cc.has(a))cc.set(a,String(await rpc("eth_getCode",[a,"latest"]).catch(()=>"")).toLowerCase());return cc.get(a);};
const fullCode=async(c,code)=>code;
const wl=readFileSync("./watch.mjs","utf8").split(/\r?\n/);
const keccakHex=new Function(wl.slice(376,395).join("\n")+"\nreturn keccakHex;")();
const g=makeGate({call,codeOf,fullCode,keccakHex,cfg:{requireAutoLp:false}});
const log=readFileSync("./data/watch.log","utf8").split(/\r?\n/);
const seen=new Set(); const all=[];
for(const l of log){const m=l.match(/\[[^\]]+\]\s+(0x[a-fA-F0-9]{40})\s+(🤖|⏸|⛔|⚠️|⚪|❌)/); if(!m)continue; const a=m[1].toLowerCase(); if(seen.has(a))continue; seen.add(a); all.push(a);}
console.log("扫描",all.length,"个合约，找总量=10000 的…");
let i=0; const hits=[];
await Promise.all(Array.from({length:8},async()=>{ while(i<all.length){ const a=all[i++]; const r=await g.inspect(a).catch(()=>({info:{}})); const inf=r.info||{}; if((inf.sizes||[]).includes(10000)) hits.push({a,inf,v:r.v}); } }));
console.log("总量=10000 的合约:",hits.length,"\n");
for(const h of hits){ const code=await codeOf(h.a); console.log(`${h.a} router=${h.inf.router} lp=${(h.inf.lp||[]).join(",")||"-"} factory=${code.includes("ca143ce32fe78f1f7019d7d551a6402fc5350c73")} wbnb=${code.includes("bb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c")} permClean=${h.inf.permClean} denied=${(h.inf.denied||[]).slice(0,5).join(",")||"-"} sizes=${(h.inf.sizes||[]).join("/")}`); }
