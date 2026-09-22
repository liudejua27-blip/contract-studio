import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {z} from 'zod';
import {configuredThinking,thinkingParameters} from '../src/server/agent/thinking';
import {runStructuredAgent as sdk} from '../src/server/agent/runtime';
import {runStructuredAgent as core} from '../src/server/agent/runtime-core';
const env={CONTRACT_AI_API_KEY:'test',CONTRACT_AI_BASE_URL:'https://api.deepseek.com',CONTRACT_AI_MODEL:'deepseek-flash'};
const call=(name:string,result:unknown,thinking:string)=>Response.json({choices:[{finish_reason:'tool_calls',message:{reasoning_content:thinking,tool_calls:[{id:crypto.randomUUID(),type:'function',function:{name,arguments:JSON.stringify(result)}}]}}]});

test('Pi effort is mapped explicitly; off disables thinking and non-DeepSeek remains compatible',()=>{
 assert.equal(configuredThinking({}),'high');
 for(const [level,effort] of [['minimal','low'],['low','low'],['medium','high'],['high','high'],['xhigh','high'],['max','max']] as const){assert.deepEqual(thinkingParameters(env.CONTRACT_AI_BASE_URL,{},level),{thinking:{type:'enabled'},reasoning_effort:effort});}
 assert.deepEqual(thinkingParameters(env.CONTRACT_AI_BASE_URL,{CONTRACT_AI_THINKING:'off'}),{thinking:{type:'disabled'},temperature:0.2});
 assert.deepEqual(thinkingParameters('https://other.test',{}),{temperature:0.2});
});
for(const [name,run] of [['sdk',sdk],['core',core]] as const){
 test(`${name}: all three stages actually send high and carry private thinking through tool calls`,async()=>{
  const original=fetch;let calls=0;const publicEvents:unknown[]=[];
  try{
   for(const stage of ['intake','draft','verify'] as const){
    let step=0;globalThis.fetch=async(_url,init)=>{
     calls++;const body=JSON.parse(String(init?.body));assert.equal(body.model,'deepseek-flash');assert.deepEqual(body.thinking,{type:'enabled'});assert.equal(body.reasoning_effort,'high');assert.equal(body.tool_choice,'auto');assert.equal(body.temperature,undefined);
     if(step++===0)return call('get_contract_rules',{},'PRIVATE_REASONING_TEST');
     assert.equal(body.messages.find((m:any)=>m.role==='assistant'&&m.tool_calls)?.reasoning_content,'PRIVATE_REASONING_TEST');
     return call('save_result',{result:{ok:true}},'PRIVATE_FINAL_REASONING');
    };
    const result=await run({prompt:'test',messages:[{role:'user',content:'test'}],schema:z.object({ok:z.boolean()}),toolName:'save_result',rules:{general:{}},environment:env,stage,onEvent:e=>publicEvents.push(e)});
    assert.equal(result.value.ok,true);
   }
   assert.equal(calls,6);assert.doesNotMatch(JSON.stringify(publicEvents),/PRIVATE_/);
  }finally{globalThis.fetch=original;}
 });
}
test('changing reasoning effort invalidates the completed SDK result cache',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'contract-thinking-')),original=fetch;let calls=0;
 const context={ownerId:'test',contractId:'c',requestId:'r',history:[]};
 try{
  globalThis.fetch=async(_url,init)=>{calls++;const body=JSON.parse(String(init?.body));assert.equal(body.reasoning_effort,calls===1?'low':'high');return call('save_result',{result:{ok:true}},'private');};
  const input={prompt:'test',messages:[{role:'user' as const,content:'test'}],schema:z.object({ok:z.boolean()}),toolName:'save_result',context};
  for(const level of ['low','high','high'])await sdk({...input,environment:{...env,CONTRACT_PI_SESSION_DIR:dir,CONTRACT_AI_REASONING_EFFORT:level}});
  assert.equal(calls,2);
 }finally{globalThis.fetch=original;await rm(dir,{recursive:true,force:true});}
});
