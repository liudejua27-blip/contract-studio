import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {query,closeDatabase} from '../src/server/db';
import {storage,renderContract} from '../src/server/documents';
import {contentFixture} from './fixtures';
import {saveEditor,markEditorDirty,completeReview,addReviewMessage} from '../src/server/contracts';
import {uploadReviewMaterial,listReviewMaterials,materialFile,loadMaterials} from '../src/server/materials';
import type {User} from '../src/lib/types';
const enabled=Boolean(process.env.DATABASE_URL);
test.after(async()=>{if(enabled)await closeDatabase()});
async function fixture(work:(f:any)=>Promise<void>){
 const owner:User={id:randomUUID(),name:'Client',email:randomUUID()+'@fixture.test',role:'client'},lawyer:User={id:randomUUID(),name:'Lawyer',email:randomUUID()+'@fixture.test',role:'lawyer'};
 const cid=randomUUID(),rid=randomUUID(),vid=randomUUID(),key=`contracts/${cid}/source.docx`,bytes=Buffer.from(await renderContract(contentFixture())),hash=createHash('sha256').update(bytes).digest('hex');
 const objects=new Map<string,Buffer>([[key,bytes]]),get=storage.get,put=storage.put,fetch=globalThis.fetch;
 const prior={command:process.env.ONLYOFFICE_COMMAND_URL,secret:process.env.ONLYOFFICE_JWT_SECRET};
 storage.get=async k=>objects.get(k)??null;storage.put=async(k,b)=>{objects.set(k,Buffer.from(b))};
 process.env.ONLYOFFICE_COMMAND_URL='http://fixture.invalid/command';process.env.ONLYOFFICE_JWT_SECRET='fixture-secret-012345678901234567890123456789';
 globalThis.fetch=async()=>new Response(JSON.stringify({error:4}),{headers:{'content-type':'application/json'}});
 try{
  await query("INSERT INTO users(id,name,email,email_normalized,password_hash,role) VALUES($1,'Client',$3,$3,'fixture','client'),($2,'Lawyer',$4,$4,'fixture','lawyer')",[owner.id,lawyer.id,owner.email,lawyer.email]);
  await query("INSERT INTO contracts(id,owner_id,title,workflow) VALUES($1,$2,'Collaboration fixture',$3::jsonb)",[cid,owner.id,JSON.stringify({inputRevision:7,intake:{confirmedAt:'2026-09-26T00:00:00Z'}})]);
  await query("INSERT INTO versions(id,contract_id,number,kind,file_key,content,source,sha256) VALUES($1,$2,1,'draft',$3,$4::jsonb,'demo',$5)",[vid,cid,key,JSON.stringify(contentFixture()),hash]);
  await query("INSERT INTO reviews(id,contract_id,submitted_version_id,lawyer_id,status,stance,concerns,requirements) VALUES($1,$2,$3,$4,'reviewing','甲方','痛点','原始需求')",[rid,cid,vid,lawyer.id]);
  await work({owner,lawyer,cid,rid,vid,key,bytes,hash,objects});
 }finally{
  storage.get=get;storage.put=put;globalThis.fetch=fetch;
  for(const [key,value] of [['ONLYOFFICE_COMMAND_URL',prior.command],['ONLYOFFICE_JWT_SECRET',prior.secret]]){if(value===undefined)delete process.env[key!];else process.env[key!]=value;}
  await query('DELETE FROM editor_sessions WHERE review_id=$1',[rid]);await query('DELETE FROM reviews WHERE id=$1',[rid]);await query('DELETE FROM versions WHERE contract_id=$1',[cid]);await query('DELETE FROM contracts WHERE id=$1',[cid]);await query('DELETE FROM users WHERE id=ANY($1::text[])',[[owner.id,lawyer.id]]);
 }
}
test('unchanged document saves once, can be delivered, and rejects delayed edit events without changing delivery',{skip:!enabled},()=>fixture(async({lawyer,cid,rid,vid,hash})=>{
 const saved=await saveEditor(lawyer,cid,rid,{}),review=saved.reviews[0];
 assert.equal(review.saveStatus,'saved');assert.notEqual(review.editingVersionId,vid);
 assert.equal(saved.versions.find(v=>v.id===review.editingVersionId)?.sha256,hash);
 assert.equal((await saveEditor(lawyer,cid,rid,{})).versions.length,2,'repeat no-change save reuses version');
 const delivered=await completeReview(lawyer,cid,rid,{versionId:review.editingVersionId,deliveryNote:'经审阅无需修改，按此版本交付。'});
 assert.equal(delivered.reviews[0].status,'completed');
 await assert.rejects(()=>markEditorDirty(lawyer,cid,rid,{}),(e:any)=>e.code==='REVIEW_COMPLETED');
 await assert.rejects(()=>saveEditor(lawyer,cid,rid,{}),(e:any)=>e.code==='REVIEW_COMPLETED');
 assert.equal((await query('SELECT save_status FROM reviews WHERE id=$1',[rid])).rows[0].save_status,'saved');
}));
test('no-change response cannot conceal unsaved edits, late edits, corrupt files or a genuine command error',{skip:!enabled},()=>fixture(async({lawyer,cid,rid,key,objects})=>{
 await markEditorDirty(lawyer,cid,rid,{});
 await assert.rejects(()=>saveEditor(lawyer,cid,rid,{}),(e:any)=>e.code==='EDITOR_SAVE_PENDING');
 assert.equal((await query('SELECT editing_version_id FROM reviews WHERE id=$1',[rid])).rows[0].editing_version_id,null);
 await query('UPDATE editor_sessions SET saved_epoch=dirty_epoch WHERE review_id=$1',[rid]);
 globalThis.fetch=async()=>{await markEditorDirty(lawyer,cid,rid,{});return new Response(JSON.stringify({error:4}))};
 await assert.rejects(()=>saveEditor(lawyer,cid,rid,{}),(e:any)=>['EDITOR_REVISION_STALE','EDITOR_SAVE_PENDING'].includes(e.code));
 globalThis.fetch=async()=>new Response(JSON.stringify({error:3}));
 await assert.rejects(()=>saveEditor(lawyer,cid,rid,{}),(e:any)=>e.code==='ONLYOFFICE_FORCE_SAVE_FAILED');
 globalThis.fetch=async()=>new Response(JSON.stringify({error:4}));
 await query('UPDATE editor_sessions SET saved_epoch=dirty_epoch WHERE review_id=$1',[rid]);
 objects.set(key,Buffer.from('corrupt'));
 await assert.rejects(()=>saveEditor(lawyer,cid,rid,{}),(e:any)=>e.code==='VERSION_FILE_MISMATCH');
}));
test('supplement uploads are private, retry-safe and independent of the frozen draft and Agent facts',{skip:!enabled},()=>fixture(async({owner,lawyer,cid,rid,vid,hash})=>{
 const stranger={...lawyer,id:randomUUID()},file={name:'交货清单.txt',bytes:Buffer.from('十台设备及安装清单')};
 const before=(await query('SELECT workflow FROM contracts WHERE id=$1',[cid])).rows[0].workflow;
 await assert.rejects(()=>uploadReviewMaterial(stranger,cid,rid,file),(e:any)=>e.code==='NOT_FOUND');
 const results=await Promise.all([uploadReviewMaterial(owner,cid,rid,file),uploadReviewMaterial(owner,cid,rid,file)]);
 assert.equal(results[0].length,1);const id=results[0][0].id;
 assert.equal((await listReviewMaterials(lawyer,cid,rid)).length,1);
 assert.deepEqual((await materialFile(lawyer,cid,id)).bytes,file.bytes);
 await assert.rejects(()=>materialFile(stranger,cid,id),(e:any)=>e.code==='MATERIAL_NOT_FOUND');
 assert.equal((await loadMaterials(owner,cid)).length,0,'supplements are not silently reintroduced as Agent facts');
 assert.deepEqual((await query('SELECT workflow FROM contracts WHERE id=$1',[cid])).rows[0].workflow,before);
 assert.equal((await query('SELECT sha256 FROM versions WHERE id=$1',[vid])).rows[0].sha256,hash);
 assert.equal((await query('SELECT count(*)::int AS n FROM review_messages WHERE review_id=$1',[rid])).rows[0].n,1);
 await uploadReviewMaterial(lawyer,cid,rid,{name:'核对说明.txt',bytes:Buffer.from('律师核对说明')});
 assert.equal((await listReviewMaterials(owner,cid,rid)).length,2);
}));
test('concurrent retries persist one message and notification; changed payload and other identities stay isolated',{skip:!enabled},()=>fixture(async({owner,lawyer,cid,rid})=>{
 const requestId=randomUUID(),before=Number((await query('SELECT count(*)::int AS n FROM notifications WHERE user_id=$1',[lawyer.id])).rows[0].n);
 await Promise.all(Array.from({length:4},()=>addReviewMessage(owner,cid,rid,{requestId,content:'一次消息'})));
 assert.equal((await query('SELECT count(*)::int AS n FROM review_messages WHERE review_id=$1',[rid])).rows[0].n,1);
 assert.equal(Number((await query('SELECT count(*)::int AS n FROM notifications WHERE user_id=$1',[lawyer.id])).rows[0].n)-before,1);
 await assert.rejects(()=>addReviewMessage(owner,cid,rid,{requestId,content:'不同内容'}),(e:any)=>e.code==='MESSAGE_REQUEST_CONFLICT');
 await assert.rejects(()=>addReviewMessage({...owner,id:randomUUID()},cid,rid,{requestId,content:'一次消息'}),(e:any)=>e.code==='FORBIDDEN');
 await addReviewMessage(lawyer,cid,rid,{requestId,content:'另一位参与者的回复'});
 assert.equal((await query('SELECT count(*)::int AS n FROM review_messages WHERE review_id=$1',[rid])).rows[0].n,2);
}));
