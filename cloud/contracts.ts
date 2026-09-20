import {startWorkflow,controlWorkflow,activeJob,type WorkflowStore} from '../src/server/workflow';
import {getTemplate} from '../src/lib/contract-library/catalog';
import {annotateMessage} from '../src/lib/contract-library/engine';
import {z} from 'zod';
import type {Contract,Review,User,Version} from '../src/lib/types';
import type {Env} from './runtime';
import {AppError} from './error';
import {generateContractReply} from '../src/server/ai';
import {renderContract,extractDocxText,validateDocxBuffer,DOCX_CONTENT_TYPE,sha256Hex} from '../src/server/documents';
import {limit} from './auth';
type CloudVersion=Version&{reviewId?:string};
type Stored=Omit<Contract,'versions'>&{versions:CloudVersion[]};
type Row={id:string;owner_id:string;state:string;revision:number;updated_at:string};
const stamp=()=>new Date().toISOString();
const fail=(code:string,message='操作未完成，请刷新后重试。',status=409):never=>{throw new AppError(status,message,code)};
export function view(c:Stored,u:User):Stored{
 if(u.role==='admin'||c.ownerId===u.id)return c;
 const reviews=c.reviews.filter(r=>r.lawyerId===u.id);
 if(!reviews.length)fail('CONTRACT_NOT_FOUND','合同不存在或无权访问。',404);
 const ids=new Set(reviews.flatMap(r=>[r.submittedVersionId,r.editingVersionId,r.finalVersionId]));
 return {...c,workflow:undefined,messages:[],reviews,versions:c.versions.filter(v=>ids.has(v.id)||reviews.some(r=>r.id===v.reviewId))};
}
export async function load(env:Env,id:string,u:User){const row=await env.DB.prepare('SELECT * FROM contracts WHERE id=?').bind(id).first<Row>();if(!row)fail('CONTRACT_NOT_FOUND','合同不存在。',404);const contract=JSON.parse(row!.state) as Stored;view(contract,u);return{row:row!,contract};}
export async function list(env:Env,u:User){
 const sql=u.role==='admin'?'SELECT * FROM contracts ORDER BY updated_at DESC LIMIT 100':u.role==='client'?'SELECT * FROM contracts WHERE owner_id=? ORDER BY updated_at DESC LIMIT 100':"SELECT * FROM contracts WHERE EXISTS(SELECT 1 FROM json_each(state,'$.reviews') WHERE json_extract(value,'$.lawyerId')=?) ORDER BY updated_at DESC LIMIT 100";
 const rows=await(u.role==='admin'?env.DB.prepare(sql):env.DB.prepare(sql).bind(u.id)).all<Row>();return rows.results.map(r=>view(JSON.parse(r.state),u));
}
export async function save(env:Env,row:Row,c:Stored,u:User){
 c.updatedAt=stamp();const serialized=JSON.stringify(c);if(new TextEncoder().encode(serialized).length>1500000)fail('CONTRACT_TOO_LARGE','此合同历史记录较多，请另建合同继续起草。');
 const r=await env.DB.prepare('UPDATE contracts SET state=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND EXISTS(SELECT 1 FROM users WHERE id=? AND disabled=0 AND role=?)').bind(serialized,c.updatedAt,c.id,row.revision,u.id,u.role).run();
 if(r.meta.changes!==1)fail('CONFLICT','合同已被更新或账号状态改变，请刷新后重试。');return view(c,u);
}
export async function create(env:Env,u:User,input:unknown){
 if(u.role!=='client')fail('FORBIDDEN','仅客户可以创建合同。',403);
 const v=z.object({title:z.string().trim().min(1).max(240).default('未命名合同')}).parse(input);const date=stamp();const c:Stored={id:crypto.randomUUID(),ownerId:u.id,ownerName:u.name,title:v.title,createdAt:date,updatedAt:date,messages:[],versions:[],reviews:[]};
 await env.DB.prepare('INSERT INTO contracts(id,owner_id,state,revision,updated_at) VALUES(?,?,?,0,?)').bind(c.id,u.id,JSON.stringify(c),date).run();return c;
}
export function workflowStore(env:Env,u:User,id:string):WorkflowStore{return{
 load:async()=>{const {row,contract}=await load(env,id,u);return{contract,revision:row.revision}},
 save:async(c,revision)=>save(env,{id,owner_id:c.ownerId,state:'',revision:Number(revision),updated_at:c.updatedAt},c,u),
 put:async(key,content)=>{const bytes=await renderContract(content);await env.BUCKET.put(key,bytes,{httpMetadata:{contentType:DOCX_CONTENT_TYPE}});return sha256Hex(bytes)},
 limit:()=>limit(env,`ai:${u.id}`,40,3600000),
 environment:{CONTRACT_AI_API_KEY:env.CONTRACT_AI_API_KEY,CONTRACT_AI_BASE_URL:env.CONTRACT_AI_BASE_URL||'https://api.deepseek.com',CONTRACT_AI_MODEL:env.CONTRACT_AI_MODEL||'deepseek-v4-pro',CONTRACT_AI_TIMEOUT_MS:env.CONTRACT_AI_TIMEOUT_MS}
};}
export async function chat(env:Env,u:User,id:string,input:unknown){return startWorkflow(workflowStore(env,u,id),u,input);}
export async function jobAction(env:Env,u:User,id:string,jobId:string,action:'run'|'retry'|'cancel'){return controlWorkflow(workflowStore(env,u,id),u,jobId,action);}
export async function submit(env:Env,u:User,id:string,input:unknown){
 const v=z.object({versionId:z.string().uuid(),stance:z.string().trim().min(1).max(100),concerns:z.string().trim().max(3000).default('')}).parse(input);
 const {row,contract:c}=await load(env,id,u);if(c.ownerId!==u.id||u.role!=='client')fail('FORBIDDEN','仅合同所有者可送审。',403);
 if(activeJob(c))fail('JOB_ACTIVE','请等待当前起草完成。');
 if(c.reviews.some(r=>r.status!=='completed'))fail('REVIEW_ALREADY_OPEN');
 if(!c.versions.some(x=>x.id===v.versionId))fail('VERSION_NOT_FOUND','版本不存在。',404);
 c.reviews.push({id:crypto.randomUUID(),submittedVersionId:v.versionId,lawyerId:null,status:'waiting',stance:v.stance,concerns:v.concerns,requirements:c.messages.map(m=>`${m.role==='user'?'用户':'AI'}：${m.content}`).join('\n'),submittedAt:stamp(),messages:[]});return save(env,row,c,u);
}
export async function reviewAction(env:Env,u:User,id:string,reviewId:string,action:string,input:any){
 const {row,contract:c}=await load(env,id,u);const r=c.reviews.find(r=>r.id===reviewId);if(!r)fail('REVIEW_NOT_FOUND','审核不存在。',404);const review=r!;
 if(review.status==='completed')fail('REVIEW_COMPLETED');
 if(action==='assign'){
  if(u.role!=='admin')fail('FORBIDDEN','仅管理员可分配律师。',403);
  const target=await env.DB.prepare("SELECT id FROM users WHERE id=? AND role='lawyer' AND disabled=0").bind(String(input.lawyerId||'')).first();if(!target)fail('INVALID_INPUT','请选择正常的律师账号。',400);review.lawyerId=String(target!.id);
 }else if(action==='messages'){
  if(u.id!==review.lawyerId&&u.id!==c.ownerId)fail('FORBIDDEN','无权参与此审核沟通。',403);
  const v=z.object({content:z.string().trim().min(1).max(6000),requestInfo:z.boolean().optional()}).parse(input);review.messages.push({id:crypto.randomUUID(),authorId:u.id,authorName:u.name,content:v.content,createdAt:stamp()});if(u.id===review.lawyerId&&v.requestInfo)review.status='need_info';else if(u.id===c.ownerId&&review.status==='need_info')review.status='reviewing';
 }else{
  if(u.role!=='lawyer'||u.id!==review.lawyerId)fail('FORBIDDEN','仅被分配的律师可执行此操作。',403);
  if(action==='start'){review.status='reviewing';}
  else if(action==='complete'){
   const v=z.object({versionId:z.string().uuid(),deliveryNote:z.string().trim().min(1).max(6000)}).parse(input);
   if(v.versionId!==review.editingVersionId||review.saveStatus!=='saved')fail('VERSION_NOT_CURRENT');
   const version=c.versions.find(x=>x.id===v.versionId&&x.reviewId===review.id);if(!version)fail('VERSION_NOT_CURRENT');const stored=await env.BUCKET.get(version!.fileKey);if(!stored||sha256Hex(Buffer.from(await stored.arrayBuffer()))!==version!.sha256)fail('FILE_NOT_FOUND','交付文件暂时不可用，请重试。',503);
   review.status='completed';review.finalVersionId=v.versionId;review.deliveryNote=v.deliveryNote;review.completedAt=stamp();
  }else fail('NOT_FOUND','接口不存在。',404);
 }
 return save(env,row,c,u);
}
export async function upload(env:Env,u:User,id:string,reviewId:string,file:File){
 const {row,contract:c}=await load(env,id,u);const review=c.reviews.find(r=>r.id===reviewId);if(!review)fail('REVIEW_NOT_FOUND','审核不存在。',404);
 if(u.role!=='lawyer'||review!.lawyerId!==u.id)fail('FORBIDDEN','仅被分配的律师可上传审阅版。',403);if(review!.status==='completed')fail('REVIEW_COMPLETED');
 if(!file||!file.name.toLowerCase().endsWith('.docx'))fail('INVALID_FILE_TYPE','请上传 Word DOCX。',400);
 const bytes=Buffer.from(await file.arrayBuffer());try{validateDocxBuffer(bytes,{maxCompressedBytes:10*1024*1024,maxUncompressedBytes:24*1024*1024,maxEntryBytes:12*1024*1024,maxEntries:512});}catch{fail('INVALID_DOCX','文件无效或解压后超过大小限制。',400);}
 const versionId=crypto.randomUUID(),fileKey=`contracts/${id}/${versionId}.docx`;
 await env.BUCKET.put(fileKey,bytes,{httpMetadata:{contentType:DOCX_CONTENT_TYPE}});c.versions.push({id:versionId,number:c.versions.length+1,kind:'review',reviewId,fileKey,content:null,source:'lawyer',text:extractDocxText(bytes).slice(0,100000),createdAt:stamp(),sha256:sha256Hex(bytes)});review!.editingVersionId=versionId;review!.saveStatus='saved';review!.status='reviewing';
 try{return await save(env,row,c,u);}catch(e){await env.BUCKET.delete(fileKey).catch(()=>{});throw e;}
}
export async function download(env:Env,u:User,id:string){
 const row=await env.DB.prepare("SELECT * FROM contracts WHERE EXISTS(SELECT 1 FROM json_each(state,'$.versions') WHERE json_extract(value,'$.id')=?) LIMIT 1").bind(id).first<Row>();if(!row)fail('VERSION_NOT_FOUND','文件不存在。',404);const c=view(JSON.parse(row!.state),u);const v=c.versions.find(x=>x.id===id);if(!v)fail('VERSION_NOT_FOUND','文件不存在。',404);const file=await env.BUCKET.get(v!.fileKey);if(!file)fail('FILE_NOT_FOUND','文件暂时不可用。',503);
 return new Response(file!.body,{headers:{'Content-Type':DOCX_CONTENT_TYPE,'Cache-Control':'private, no-store','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(c.title.replace(/[\r\n]/g,'').slice(0,100)+'-v'+v!.number+'.docx')}`}});
}
