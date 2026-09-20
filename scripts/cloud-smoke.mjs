import {Miniflare} from 'miniflare';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {randomBytes,createHash,pbkdf2Sync} from 'node:crypto';
const bootstrap=randomBytes(32).toString('hex');
const password=randomBytes(20).toString('hex'),salt=randomBytes(32).toString('hex');
const adminHash='pbkdf2$100000$'+salt+'$'+pbkdf2Sync(password,salt,100000,32,'sha256').toString('hex');
const content={title:'云端验收合同',parties:[{role:'甲方',name:'测试甲公司'},{role:'乙方',name:'测试乙公司'}],sections:[{title:'费用',content:'人民币20000元，其他条件待补充。'}],signing:'待补充',missing:['日期']};
const mf=new Miniflare({workers:[{name:"contract",modules:true,scriptPath:'dist/server/index.js',compatibilityDate:'2026-08-01',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],r2Buckets:['BUCKET'],bindings:{CONTRACT_BOOTSTRAP_SECRET:bootstrap,CONTRACT_BOOTSTRAP_ADMIN_EMAIL:'admin@test.local',CONTRACT_BOOTSTRAP_ADMIN_HASH:adminHash,CONTRACT_AI_API_KEY:'test-key',CONTRACT_AI_BASE_URL:'https://model.test'},outboundService:async()=>Response.json({choices:[{message:{content:JSON.stringify(content)}}]})}]});
const results=[];const pass=s=>{results.push(s);console.log('PASS',s)};
const actor=()=>({cookie:''});const admin=actor(),client=actor(),lawyer=actor(),other=actor();
async function req(a,path,body,expected=200,method,headers={}){
 if(body instanceof FormData){const encoded=new Request('https://contract.test',{method:'POST',body});headers={...headers,'content-type':encoded.headers.get('content-type')};body=new Uint8Array(await encoded.arrayBuffer());}
 const response=await mf.dispatchFetch('https://contract.test/api/'+path,{method:method||(body===undefined?'GET':'POST'),headers:{...(a.cookie?{cookie:a.cookie}:{}),...(body instanceof FormData?{}:{'content-type':'application/json'}),...headers},body:body===undefined?undefined:body instanceof Uint8Array?body:body instanceof FormData?body:JSON.stringify(body)});
 if(response.headers.get('set-cookie'))a.cookie=response.headers.get('set-cookie').split(';')[0];
 const data=await response.json();assert.equal(response.status,expected,`${path}: ${JSON.stringify(data)}`);return data.data;
}
try{
 const db=await mf.getD1Database('DB');for(const f of(await readdir('drizzle')).filter(f=>f.endsWith('.sql')).sort()){const sql=await readFile('drizzle/'+f,'utf8');await db.batch(sql.split('--> statement-breakpoint').filter(x=>x.trim()).map(s=>db.prepare(s)));}

 await req(client,'auth/register',{name:'冒领管理员',email:'admin@test.local',password},409);
 await req(admin,'auth/login',{email:'admin@test.local',password:'wrong-password'},401);
 await req(admin,'auth/login',{email:'admin@test.local',password});
 await req(admin,'auth/bootstrap',{name:'二次管理员',email:'admin2@test.local',password},409,undefined,{'x-contract-bootstrap':bootstrap});pass('administrator first login is credential-bound, reserved, and single-use');
 await req(admin,'auth/login',{email:'admin@test.local',password});const lawyerUser=await req(admin,'users',{name:'律师',email:'lawyer@test.local',password,role:'lawyer'},201);
 await req(lawyer,'auth/login',{email:'lawyer@test.local',password});await req(client,'auth/register',{name:'客户',email:'client@test.local',password,role:'admin'},201);await req(other,'auth/register',{name:'其他客户',email:'other@test.local',password},201);assert.equal((await req(client,'session')).role,'client');await req(client,'users',undefined,403);pass('roles and registration privilege boundaries');
 await req(actor(),'templates/nda/download',undefined,401);
 const templateResponse=await mf.dispatchFetch('https://contract.test/api/templates/nda/download',{headers:{cookie:client.cookie}});assert.equal(templateResponse.status,200);assert.equal(Buffer.from(await templateResponse.arrayBuffer()).subarray(0,2).toString(),'PK');await req(client,'templates/nonexistent/download',undefined,404);pass('template downloads require login and reject unknown template');
 let c=await req(client,'contracts',{title:'云端测试'},201);await req(other,`contracts/${c.id}`,undefined,404);await req(lawyer,`contracts/${c.id}`,undefined,404);pass('contract ownership isolation');
 c=await req(client,`contracts/${c.id}/chat`,{mode:'live',generate:true,message:'费用20000元，其余待补充',templateId:'purchase'});const v=c.versions.at(-1);assert.equal(v.content.drafting.templateId,'purchase');assert.equal(v.content.drafting.reviewStatus,'pending_lawyer_review');await req(client,`contracts/${c.id}/chat`,{message:'test',templateId:'invalid'},400);const downloaded=await mf.dispatchFetch('https://contract.test/api/files/'+v.id,{headers:{cookie:client.cookie}});assert.equal(downloaded.status,200);const bytes=Buffer.from(await downloaded.arrayBuffer());assert.equal(createHash('sha256').update(bytes).digest('hex'),v.sha256);assert.equal(bytes.subarray(0,2).toString(),'PK');await req(other,'files/'+v.id,undefined,404);pass('model response produces real private DOCX in R2');
 c=await req(client,`contracts/${c.id}/reviews`,{versionId:v.id,stance:'甲方'},201);const review=c.reviews.at(-1),base=`contracts/${c.id}/reviews/${review.id}`;
 await req(client,`contracts/${c.id}/chat`,{mode:'live',message:'再修改'},409);await req(client,`contracts/${c.id}/reviews`,{versionId:v.id,stance:'甲方'},409);pass('review freezes draft and rejects duplicate review');
 c=await req(admin,base+'/assign',{lawyerId:lawyerUser.id});c=await req(lawyer,base+'/start',{});c=await req(lawyer,base+'/messages',{content:'请补充日期',requestInfo:true});assert.equal(c.reviews.at(-1).status,'need_info');c=await req(client,base+'/messages',{content:'日期待双方确认'});assert.equal(c.reviews.at(-1).status,'reviewing');pass('assignment and supplement roundtrip');
 const fake=new FormData();fake.set('file',new Blob(['invalid']),'invalid.docx');await req(lawyer,base+'/upload',fake,400);
 const upload=new FormData();upload.set('file',new Blob([bytes]),'reviewed.docx');c=await req(lawyer,base+'/upload',upload);const finalId=c.reviews.at(-1).editingVersionId;await req(lawyer,base+'/complete',{versionId:v.id,deliveryNote:'旧版本'},409);c=await req(lawyer,base+'/complete',{versionId:finalId,deliveryNote:'测试交付，不代表法律意见'});assert.equal(c.reviews.at(-1).finalVersionId,finalId);await req(lawyer,base+'/upload',upload,409);pass('upload validation and immutable confirmed delivery');
 const final=await mf.dispatchFetch('https://contract.test/api/files/'+finalId,{headers:{cookie:client.cookie}});assert.deepEqual(Buffer.from(await final.arrayBuffer()),bytes);pass('client receives exact lawyer upload');
 c=await req(client,`contracts/${c.id}/chat`,{mode:'live',generate:true,message:'费用20000元，重新起草'});const newDraft=c.versions.at(-1);assert.equal(newDraft.content.drafting.templateId,'purchase');assert.equal(c.versions.find(x=>x.id===v.id).content.drafting.createdAt,v.content.drafting.createdAt);const restricted=await req(lawyer,`contracts/${c.id}`);assert.ok(!restricted.versions.some(v=>v.id===newDraft.id));await req(lawyer,'files/'+newDraft.id,undefined,404);pass('lawyer cannot see client post-delivery draft');
 const before=await db.prepare('SELECT revision FROM contracts WHERE id=?').bind(c.id).first();const concurrent=await Promise.all([mf.dispatchFetch('https://contract.test/api/'+`contracts/${c.id}/reviews`,{method:'POST',headers:{cookie:client.cookie,'content-type':'application/json'},body:JSON.stringify({versionId:newDraft.id,stance:'甲方'})}),mf.dispatchFetch('https://contract.test/api/'+`contracts/${c.id}/reviews`,{method:'POST',headers:{cookie:client.cookie,'content-type':'application/json'},body:JSON.stringify({versionId:newDraft.id,stance:'乙方'})})]);assert.equal(concurrent.filter(r=>r.status===201).length,1);assert.equal(concurrent.filter(r=>r.status===409).length,1);pass('concurrent submissions commit only one review');
 await req(admin,'users/'+lawyerUser.id,{disabled:true},200,'PATCH');assert.equal(await req(lawyer,'session'),null);await req(lawyer,'contracts',undefined,401);pass('disabled account session is revoked');
 await req(client,'contracts',{},403,'POST',{origin:'https://attacker.test'});await req(client,'auth/logout',{});await req(client,'contracts',undefined,401);pass('CSRF and logout');
 await writeFile('docs/cloud-smoke-results.json',JSON.stringify({result:'passed',time:new Date().toISOString(),checks:results},null,2));
}finally{await mf.dispose();}
