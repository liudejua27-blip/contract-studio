import test from 'node:test';
import assert from 'node:assert/strict';
import { generateContractReply, validateNumericFacts } from '../src/server/ai';
import type { ContractContent } from '../src/lib/types';
const content:ContractContent={title:'软件开发合同',parties:[{role:'甲方',name:'待补充'}],sections:[{title:'费用',content:'合同总价人民币80,000元，付款节点待补充。'}],signing:'待补充',missing:['付款节点']};
test('numeric guard normalizes ten-thousand currency and refuses invented amount/date',()=>{validateNumericFacts(content,'费用8万元');assert.throws(()=>validateNumericFacts(content,'费用2万元'));assert.throws(()=>validateNumericFacts({...content,signing:'2026年10月1日签署'},'费用8万元'));});
test('live malformed output fails closed and current lawyer document enters rewrite context',async()=>{
 const oldFetch=globalThis.fetch,oldKey=process.env.CONTRACT_AI_API_KEY;process.env.CONTRACT_AI_API_KEY='test-only-not-a-real-key';let requestBody='';
 try{
 globalThis.fetch=async(_url,init)=>{requestBody=String(init?.body);return Response.json({choices:[{message:{content:'not valid contract JSON'}}]})};
 await assert.rejects(generateContractReply({mode:'live',templateId:'software',generate:true,prompt:'修改付款节点',title:'合同',messages:[],existingDocumentText:'律师修改：付款前必须验收。'}),/valid contract/);
 assert.ok(requestBody.includes('律师修改：付款前必须验收。'));
 globalThis.fetch=async()=>Response.json({choices:[{message:{content:JSON.stringify(content)}}]});
 const r=await generateContractReply({mode:'live',templateId:'software',generate:true,prompt:'费用8万元',title:'合同',messages:[]});assert.equal(r.source,'ai');assert.equal(r.content?.title,content.title);assert.ok(!r.reply.includes('"sections"'));
 }finally{globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.CONTRACT_AI_API_KEY;else process.env.CONTRACT_AI_API_KEY=oldKey;}
});

test('generation requests JSON and refuses token-truncated output even when JSON parses', async () => {
 const oldFetch=globalThis.fetch, oldKey=process.env.CONTRACT_AI_API_KEY;
 process.env.CONTRACT_AI_API_KEY='test-only-not-a-real-key';
 try {
  let body: Record<string,unknown>={};
  globalThis.fetch=async(_url,init)=>{body=JSON.parse(String(init?.body));return Response.json({choices:[{finish_reason:'length',message:{content:JSON.stringify(content)}}]})};
  await assert.rejects(generateContractReply({mode:'live',templateId:'software',generate:true,prompt:'费用8万元',title:'合同',messages:[]}), (error:unknown)=>(error as {code?:string}).code==='AI_OUTPUT_TRUNCATED');
  assert.deepEqual(body.response_format,{type:'json_object'});
 } finally {globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.CONTRACT_AI_API_KEY;else process.env.CONTRACT_AI_API_KEY=oldKey;}
});

test('provider timeout is distinct from connectivity failure',async()=>{
 const oldFetch=globalThis.fetch,oldKey=process.env.CONTRACT_AI_API_KEY,oldTimeout=process.env.CONTRACT_AI_TIMEOUT_MS;
 process.env.CONTRACT_AI_API_KEY='test-only-not-a-real-key';process.env.CONTRACT_AI_TIMEOUT_MS='10';
 try{
  globalThis.fetch=async(_url,init)=>new Promise((_resolve,reject)=>{init?.signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true})});
  await assert.rejects(generateContractReply({mode:'live',generate:false,prompt:'起草合同',title:'合同',messages:[]}), (error:unknown)=>(error as {code?:string}).code==='AI_TIMEOUT');
 }finally{globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.CONTRACT_AI_API_KEY;else process.env.CONTRACT_AI_API_KEY=oldKey;if(oldTimeout===undefined)delete process.env.CONTRACT_AI_TIMEOUT_MS;else process.env.CONTRACT_AI_TIMEOUT_MS=oldTimeout;}
});
