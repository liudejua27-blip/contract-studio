import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {query,closeDatabase} from '../src/server/db';
import {deletionRequest,deletionState,purgeDueContracts} from '../src/server/lifecycle';
import {addReviewMessage,getContractForRoute,contractChangeToken,versionDetails,messagePage,workflowStore} from '../src/server/contracts';
import {contentFixture} from './fixtures';
import type {User} from '../src/lib/types';
const enabled=!!process.env.DATABASE_URL;
test.after(async()=>{if(enabled)await closeDatabase()});
async function fixture(work:(f:any)=>Promise<void>){
 const owner:User={id:randomUUID(),role:'client',name:'Fixture',email:randomUUID()+'@fixture.test'},lawyer:User={id:randomUUID(),role:'lawyer',name:'Lawyer',email:randomUUID()+'@fixture.test'};
 const cid=randomUUID(),rid=randomUUID(),vid=randomUUID();
 try{
 await query("INSERT INTO users(id,name,email,email_normalized,password_hash,role) VALUES($1,'Fixture',$2,$2,'fixture','client'),($3,'Lawyer',$4,$4,'fixture','lawyer')",[owner.id,owner.email,lawyer.id,lawyer.email]);
 await query("INSERT INTO contracts(id,owner_id,title) VALUES($1,$2,'Fixture')",[cid,owner.id]);
 await query("INSERT INTO versions(id,contract_id,number,kind,file_key,source,content) VALUES($1,$2,1,'draft',$1,'demo',$3::jsonb)",[vid,cid,JSON.stringify(contentFixture())]);
 await query("INSERT INTO reviews(id,contract_id,submitted_version_id,lawyer_id,status,stance,concerns,requirements) VALUES($1,$2,$3,$4,'completed','','','')",[rid,cid,vid,lawyer.id]);
 await work({owner,lawyer,cid,rid,vid});
 }finally{
 await query('DELETE FROM editor_sessions WHERE review_id=$1',[rid]);await query('DELETE FROM reviews WHERE id=$1',[rid]);await query('DELETE FROM contracts WHERE id=$1',[cid]);await query('DELETE FROM users WHERE id=ANY($1::text[])',[[owner.id,lawyer.id]]);
 }
}
async function due(cid:string){await query("UPDATE contracts SET updated_at=now()-interval '31 days' WHERE id=$1",[cid]);await query("UPDATE deletion_requests SET requested_at=now()-interval '32 days',delete_after=now()-interval '2 days' WHERE contract_id=$1",[cid]);}
test('expired contract with editor is purged and file/session GC references survive',{skip:!enabled},()=>fixture(async({owner,cid,rid,vid})=>{
 await query('INSERT INTO editor_sessions(id,review_id,base_version_id,document_key,scratch_file_key,assigned_user_id) VALUES($1,$2,$3,$1,$1,$4)',[randomUUID(),rid,vid,owner.id]);
 await deletionRequest(owner,cid);await due(cid);
 assert.equal(await purgeDueContracts(),1);
 assert.equal((await query('SELECT id FROM contracts WHERE id=$1',[cid])).rowCount,0);
 assert.equal((await query('SELECT file_key FROM object_gc WHERE file_key=$1',[vid])).rowCount,1);
}));
test('post-request communication extends retention; later expiry purges without manual reapplication',{skip:!enabled},()=>fixture(async({owner,cid,rid})=>{
 await deletionRequest(owner,cid);await due(cid);
 await addReviewMessage(owner,cid,rid,{content:'Synthetic follow-up',requestId:randomUUID()});
 const deadline=(await deletionState(owner,cid))!.delete_after;
 assert.ok(new Date(deadline).getTime()>Date.now()+29*86400000);
 assert.equal(await purgeDueContracts(),0);
 assert.equal(new Date((await deletionRequest(owner,cid)).deleteAfter).getTime(),new Date(deadline).getTime());
 await query("UPDATE contracts SET updated_at=now()-interval '31 days' WHERE id=$1",[cid]);
 assert.equal(await purgeDueContracts(),1);
}));
test('a failed deletion does not roll back another contract in the batch',{skip:!enabled},()=>fixture(async(a)=>fixture(async(b)=>{
 await query('CREATE TABLE qa_delete_blocker(contract_id text REFERENCES contracts(id))');
 try{
 await query('INSERT INTO qa_delete_blocker VALUES($1)',[a.cid]);
 for(const f of [a,b]){await deletionRequest(f.owner,f.cid);await due(f.cid)}
 assert.equal(await purgeDueContracts(),1);
 assert.equal((await query('SELECT id FROM contracts WHERE id=$1',[a.cid])).rowCount,1);
 assert.equal((await query('SELECT id FROM contracts WHERE id=$1',[b.cid])).rowCount,0);
 }finally{await query('DROP TABLE qa_delete_blocker')}
})));
test('browser history is bounded, older pages and versions remain authorized, Agent history stays complete',{skip:!enabled},()=>fixture(async({owner,lawyer,cid,rid,vid})=>{
 for(let n=1;n<=120;n++){
 await query("INSERT INTO messages(id,contract_id,role,content) VALUES($1,$2,'user',$3)",[randomUUID(),cid,'Message '+n]);
 await query('INSERT INTO review_messages(id,review_id,author_id,content) VALUES($1,$2,$3,$4)',[randomUUID(),rid,owner.id,'Review '+n]);
 }
 const historical=randomUUID(),latest=randomUUID(),content=contentFixture();
 for(const [id,n] of [[historical,2],[latest,3]] as const)await query("INSERT INTO versions(id,contract_id,number,kind,review_id,file_key,source,content,text_content) VALUES($1,$2,$3,'review',$4,$1,'lawyer',$5::jsonb,'Saved text')",[id,cid,n,rid,JSON.stringify(content)]);
 const token=await contractChangeToken(owner,cid),view=await getContractForRoute(owner,cid);
 assert.equal(view.messages.length,50);assert.equal(view.messagesHasMore,true);assert.equal(view.reviews[0].messages.length,50);
 assert.equal(view.versions.find(v=>v.id===historical)?.bodyLoaded,false);assert.equal(view.versions.find(v=>v.id===historical)?.content,null);
 assert.equal((await versionDetails(lawyer,cid,historical)).content?.title,content.title);
 const older=await messagePage(owner,cid,view.messages[0].id);assert.equal(older.items.length,50);assert.equal(older.items.at(-1)?.content,'Message 70');assert.equal(older.hasMore,true);
 const first=await messagePage(owner,cid,older.items[0].id);assert.equal(first.items.length,20);assert.equal(first.hasMore,false);
 assert.equal((await messagePage(lawyer,cid,view.reviews[0].messages[0].id,rid)).items.length,50);
 await assert.rejects(()=>messagePage(lawyer,cid),{code:'FORBIDDEN'});
 await assert.rejects(()=>versionDetails({...owner,id:randomUUID()},cid,vid),{code:'CONTRACT_NOT_FOUND'});
 const complete=await workflowStore(owner,cid).load();assert.equal(complete.contract.messages.length,120);assert.ok(complete.contract.versions.find(v=>v.id===historical)?.content);
 assert.equal(await contractChangeToken(owner,cid),token);
 await query("UPDATE reviews SET save_status='pending' WHERE id=$1",[rid]);assert.notEqual(await contractChangeToken(owner,cid),token,'callback state changes invalidate cache even without timestamp change');
}));
