import { readFileSync } from "node:fs";
import { makeGate } from "./gate.mjs";
const RPCS=["https://bsc-rpc.publicnode.com","https://bsc-dataseed.bnbchain.org","https://bsc.publicnode.com"];
let ri=0;
async function rpc(m,p){for(let k=0;k<10;k++){try{const r=await fetch(RPCS[ri++%3],{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:m,params:p}),signal:AbortSignal.timeout(15000)});const j=await r.json();if(j.result!==undefined)return j.result;}catch{}await new Promise(r=>setTimeout(r,200));}throw new Error("rpc "+m);}
const call=(to,data)=>rpc("eth_call",[{to,data},"latest"]).catch(()=>null);
const cc=new Map(); const codeOf=async a=>{if(!cc.has(a))cc.set(a,String(await rpc("eth_getCode",[a,"latest"]).catch(()=>"")).toLowerCase());return cc.get(a);};
const fullCode=async(c,code)=>code;
const wsrc=readFileSync("./watch.mjs","utf8");
const ks=wsrc.indexOf("const KRC ="), ke=wsrc.indexOf("const DEPLOYERS", ks);
const keccakHex=new Function(wsrc.slice(ks,ke)+"\nreturn keccakHex;")();
const g=makeGate({call,codeOf,fullCode,keccakHex,cfg:{requireAutoLp:false}});
const addrs=process.argv.slice(2);
for(const a of addrs){const r=await g.inspect(a);const i=r.info;
 console.log(`${a}\n  cap=${(i.sizes||[]).join("/")} capOk=${i.capOk} router=${i.router} lp=${(i.lp||[]).join(",")} permClean=${i.permClean} denied=${(i.denied||[]).join(",")||"-"}\n  → ${r.v||"✅ 通過"}`);}
