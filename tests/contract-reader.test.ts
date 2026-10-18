import test from 'node:test';
import assert from 'node:assert/strict';
import {readContract,clearContractReadCache} from '../src/lib/contract-reader';
test('conditional reads reuse an unchanged response and account changes discard the private cache',async()=>{
 const original=globalThis.fetch;clearContractReadCache();const headers:any[]=[];let n=0;
 globalThis.fetch=async(_url,init)=>{headers.push(init?.headers);return ++n===2?new Response(null,{status:304}):new Response(JSON.stringify({data:{id:'fixture',revision:n}}),{headers:{etag:'"revision"'}})};
 try{const first=await readContract('fixture');assert.equal(await readContract('fixture'),first);assert.equal(headers[1]['If-None-Match'],'"revision"');clearContractReadCache();assert.notEqual(await readContract('fixture'),first);assert.equal(headers[2]['If-None-Match'],undefined);}finally{globalThis.fetch=original;clearContractReadCache()}
});
test('a response from a previous account cannot refill the cache after logout',async()=>{
 const original=globalThis.fetch;let finish!:(r:Response)=>void;clearContractReadCache();
 globalThis.fetch=()=>new Promise(r=>{finish=r});
 try{const pending=readContract('fixture');clearContractReadCache();finish(new Response(JSON.stringify({data:{id:'fixture'}}),{headers:{etag:'"old"'}}));await assert.rejects(pending,/账户已变化/);}finally{globalThis.fetch=original;clearContractReadCache()}
});
