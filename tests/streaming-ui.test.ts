import test from 'node:test';
import assert from 'node:assert/strict';
import {publicPreview,sseData,type AgentStreamEvent} from '../src/lib/agent-stream';
import {agentStreamResponse} from '../src/server/agent/http-stream';
import {createAgentViewStore} from '../src/lib/agent-view-store';
import {createAgentJobRunner} from '../src/lib/agent-job-runner';
import type {Contract,GenerationJob} from '../src/lib/types';
const job=(phase:GenerationJob['phase']='generate',status:GenerationJob['status']='pending'):GenerationJob=>({id:'job',messageId:'user',phase,status,attempt:0,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),versionId:'version'});
const contract=(j=job()):Contract=>({id:'c',ownerId:'user',ownerName:'测试',title:'测试合同',createdAt:'',updatedAt:'',messages:[],versions:[],reviews:[],workflow:{job:j}});

test('public preview is path scoped and preserves >24000 Chinese characters',()=>{
 const text='逐条核对交易事实。'.repeat(4000)+'末尾仍在生成';
 const source=JSON.stringify({result:{title:'合同',sections:[{title:'条款',content:text}],attachments:[{title:'附件',content:'真实附件'}],facts:{content:'PRIVATE'},ruleApplications:[{title:'PRIVATE',content:'PRIVATE'}],reviewNotes:[{content:'PRIVATE'}]}});
 const preview=publicPreview(source,'draft');assert.ok(preview.length>24000);assert.ok(preview.includes('末尾仍在生成'));assert.doesNotMatch(preview,/PRIVATE/);
 assert.equal(publicPreview('{"result":{"facts":{"reply":"PRIVATE"},"reply":"你好"}}','intake'),'你好');assert.equal(publicPreview(source,'verify'),'');
});
test('all JSON split positions survive quotes, backslashes, Chinese and surrogate escape fragments',()=>{
 const text='第一条："支付"；路径\\说明\n继续😀';
 const source=JSON.stringify({result:{reply:text}}).replace('😀','\\ud83d\\ude00');
 for(let n=1;n<=source.length;n++){const preview=publicPreview(source.slice(0,n),'intake');assert.ok(text.startsWith(preview),`split ${n}: ${preview}`);}
 assert.equal(publicPreview(source,'intake'),text);
});
test('HTTP stream transmits deltas and explicitly replaces a restarted candidate',async()=>{
 const response=agentStreamResponse(async emit=>{for(const text of ['旧','旧文字','','新','新文字'])emit({type:'preview',text});return contract(job('export','completed'));});
 let text='';const events:AgentStreamEvent[]=[];
 for await(const frame of sseData(response.body!)){const e=JSON.parse(frame) as AgentStreamEvent;events.push(e);if(e.type==='preview_delta'&&e.text)text=e.replace?e.text:text+e.text;}
 assert.equal(text,'新文字');assert.deepEqual(events.filter(e=>e.type==='preview_delta').map(e=>e.text),['旧','文字','','新','文字']);assert.equal(events.at(-1)?.type,'result');
});
test('view preserves phase transition, resets new candidates and rejects cancelled or stale events',()=>{
 const store=createAgentViewStore();const t1=store.begin('a',job());store.event('a',t1,{type:'preview_delta',text:'旧正文',replace:true});
 const t2=store.begin('a',job('verify'));assert.equal(store.get('a')?.text,'旧正文');
 store.event('a',t1,{type:'preview',text:'过期'});assert.equal(store.get('a')?.text,'旧正文');
 const t3=store.begin('a',job());store.event('a',t3,{type:'preview_delta',text:'',replace:true});assert.equal(store.get('a')?.text,'旧正文');
 store.event('a',t3,{type:'preview_delta',text:'新正文',replace:true});assert.equal(store.get('a')?.text,'新正文');
 store.settle('a',job('generate','cancelled'));store.event('a',t3,{type:'preview',text:'迟到'});store.settle('a',job('export','completed'));assert.equal(store.get('a')?.text,'新正文');assert.equal(store.get('a')?.status,'cancelled');
 assert.equal(store.get('b'),undefined);assert.ok(t2!==t3);
});
test('only the subscribed contract is notified; failure retains partial preview',()=>{
 const store=createAgentViewStore();let a=0,b=0;store.subscribe('a',()=>a++);store.subscribe('b',()=>b++);
 const token=store.begin('a',job());store.event('a',token,{type:'preview',text:'未完成内容'});store.interrupted('a',token,'网络中断');
 assert.equal(a,3);assert.equal(b,0);assert.equal(store.get('a')?.text,'未完成内容');assert.equal(store.get('a')?.status,'failed');
});
test('runner immediately advances phases once without polling and keeps preview through verify/export',async()=>{
 const store=createAgentViewStore(),calls:string[]=[],seen:string[]=[];let n=0;
 const runner=createAgentJobRunner({store,load:async()=>contract(),error:()=>assert.fail('unexpected error'),update:c=>{seen.push(store.get('c')?.text||'');},stream:async(path,emit)=>{
  calls.push(path);n++;if(n===1){emit({type:'preview_delta',text:'正文',replace:true});return contract(job('verify'));}if(n===2)return contract(job('export'));return contract(job('export','completed'));
 }});
 await Promise.all([runner.run(contract()),runner.run(contract())]);assert.equal(calls.length,3);assert.deepEqual(seen,['正文','正文','正文']);assert.equal(store.get('c')?.status,'completed');
});
test('cancel acknowledgement prevents old run from advancing or updating the contract',async()=>{
 const store=createAgentViewStore();let finish!:(c:Contract)=>void,updates=0;
 const runner=createAgentJobRunner({store,load:async()=>contract(),error:()=>{},update:()=>updates++,stream:async()=>new Promise(resolve=>{finish=resolve;})});
 const running=runner.run(contract());store.settle('c',job('generate','cancelled'));runner.disconnect('c');finish(contract(job('verify')));await running;
 assert.equal(updates,0);assert.equal(store.get('c')?.status,'cancelled');assert.equal(runner.isRunning('c'),false);
});
test('disconnect reconciliation accepts a saved final result instead of marking it failed',async()=>{
 const store=createAgentViewStore();let errors=0;
 const runner=createAgentJobRunner({store,load:async()=>contract(job('export','completed')),error:()=>errors++,update:()=>{},stream:async(_path,emit)=>{emit({type:'preview',text:'已生成正文'});throw new Error('network');}});
 await runner.run(contract());assert.equal(errors,0);assert.equal(store.get('c')?.status,'completed');assert.equal(store.get('c')?.text,'已生成正文');
});
