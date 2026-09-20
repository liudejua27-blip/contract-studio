import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const base='http://127.0.0.1:3210/api';
const accounts=JSON.parse(await readFile('.data/local-accounts.json','utf8'));
const report={time:new Date().toISOString(),checks:[],liveAI:'not configured / not exercised',onlyoffice:'separate browser acceptance required'};
const check=(name)=>{report.checks.push(name);console.log('PASS',name)};
function actor(){return {cookie:''}}
async function req(a,path,body,expected=200){const r=await fetch(`${base}/${path}`,{method:body===undefined?'GET':'POST',headers:{...(a.cookie?{cookie:a.cookie}:{}),...(body instanceof FormData?{}:body===undefined?{}:{'content-type':'application/json'})},body:body instanceof FormData?body:body===undefined?undefined:JSON.stringify(body)});if(r.headers.get('set-cookie'))a.cookie=r.headers.get('set-cookie').split(';')[0];const text=await r.text();let data;try{data=JSON.parse(text)}catch{}assert.equal(r.status,expected,`${path} status: ${data?.error||text.slice(0,80)}`);return data?.data}
async function bytes(a,id){const r=await fetch(`${base}/files/${id}`,{headers:{cookie:a.cookie}});assert.equal(r.status,200);return Buffer.from(await r.arrayBuffer())}
const clients={};
try{
 for(const account of accounts){const a=actor();await req(a,'auth/login',{email:account.email,password:account.password});clients[account.role]=a;assert.equal((await req(a,'session')).id,account.id)}check('three roles authenticate with persisted sessions');
 const client=clients.client,lawyer=clients.lawyer,admin=clients.admin;
 const outsider=actor();await req(outsider,'auth/register',{name:'隔离测试用户',email:`isolation-${Date.now()}@contract.local`,password:randomBytes(24).toString('hex'),role:'admin'},201);assert.equal((await req(outsider,'session')).role,'client');await req(outsider,'users',undefined,403);check('registration cannot self-elevate');
 let c=await req(client,'contracts',{title:'软件开发服务合同 · 流程验收'},201);report.contractId=c.id;
 await req(outsider,`contracts/${c.id}`,undefined,404);await req(lawyer,`contracts/${c.id}`,undefined,404);check('unassigned lawyer and unrelated client cannot read contract');
 c=await req(client,`contracts/${c.id}/chat`,{message:'甲方为示例甲公司，乙方为示例乙公司；开发小程序，费用8万元，三个月交付，付款节点待确认。',mode:'demo'});assert.equal(c.messages.length,2);
 c=await req(client,`contracts/${c.id}/chat`,{message:'请生成草稿，未确认的信息保留待补充。',mode:'demo',generate:true});assert.equal(c.versions.length,1);assert.equal(c.versions[0].source,'demo');const original=c.versions[0];const doc=await bytes(client,original.id);assert.equal(doc.subarray(0,2).toString(),'PK');assert.equal(createHash('sha256').update(doc).digest('hex'),original.sha256);await writeFile('.data/qa/source.docx',doc);check('explicit demo produces a downloadable real DOCX with matching hash');
 await req(outsider,`files/${original.id}`,undefined,404);check('document download enforces owner access');
 c=await req(client,`contracts/${c.id}/reviews`,{versionId:original.id,stance:'甲方',concerns:'付款节点和知识产权'},201);let review=c.reviews.at(-1);report.reviewId=review.id;
 await req(client,`contracts/${c.id}/reviews`,{versionId:original.id,stance:'甲方'},409);
 await req(client,`contracts/${c.id}/chat`,{message:'改变金额',mode:'demo',generate:true},409);check('review submission freezes exact draft and prevents duplicate open task');
 await req(client,`contracts/${c.id}/reviews/${review.id}/assign`,{lawyerId:accounts.find(a=>a.role==='lawyer').id},403);
 c=await req(admin,`contracts/${c.id}/reviews/${review.id}/assign`,{lawyerId:accounts.find(a=>a.role==='lawyer').id});
 c=await req(lawyer,`contracts/${c.id}/reviews/${review.id}/start`,{});assert.equal(c.reviews.at(-1).status,'reviewing');check('only admin assigns and assigned lawyer starts task');
 c=await req(lawyer,`contracts/${c.id}/reviews/${review.id}/messages`,{content:'请确认分期付款比例。',requestInfo:true});assert.equal(c.reviews.at(-1).status,'need_info');
 c=await req(client,`contracts/${c.id}/reviews/${review.id}/messages`,{content:'首期30%，验收后70%。'});assert.equal(c.reviews.at(-1).status,'reviewing');check('supplement request and reply roundtrip changes task state');
 const fake=new FormData();fake.set('file',new Blob(['not a docx']),'invalid.docx');await req(lawyer,`contracts/${c.id}/reviews/${review.id}/upload`,fake,400);check('fake DOCX rejected');
 const upload=new FormData();upload.set('file',new Blob([doc],{type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}),'lawyer-reviewed.docx');c=await req(lawyer,`contracts/${c.id}/reviews/${review.id}/upload`,upload);review=c.reviews.at(-1);assert.equal(review.saveStatus,'saved');const finalId=review.editingVersionId;
 await req(lawyer,`contracts/${c.id}/reviews/${review.id}/complete`,{versionId:original.id,deliveryNote:'不能交付旧版'},409);
 c=await req(lawyer,`contracts/${c.id}/reviews/${review.id}/complete`,{versionId:finalId,deliveryNote:'此为开发验收样例，验证文件交付和版本冻结；并非专业律师法律意见。'});assert.equal(c.reviews.at(-1).status,'completed');assert.equal(c.reviews.at(-1).finalVersionId,finalId);assert.deepEqual(await bytes(client,finalId),doc);assert.deepEqual(await bytes(client,original.id),doc);check('delivery uses exact saved lawyer file and preserves original');
 c=await req(client,`contracts/${c.id}/chat`,{message:'交付后新草稿示例',mode:'demo',generate:true});assert.equal(c.versions.at(-1).kind,'draft');assert.equal(c.reviews.at(-1).finalVersionId,finalId);check('post-delivery generation creates unreviewed new draft without replacing final');
 await req(client,'auth/logout',{});assert.equal(await req(client,'session'),null);await req(client,'contracts',undefined,401);check('logout revokes session');
 report.result='passed';
}catch(e){report.result='failed';report.error=e.message;console.error(e.message);process.exitCode=1}finally{await writeFile('docs/api-smoke-results.json',JSON.stringify(report,null,2))}
