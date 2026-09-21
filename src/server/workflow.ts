import {acceptSuggestions,requiredFields} from '../lib/contract-library/intake-policy';
import {intakeFactIssues} from '../lib/contract-library/fact-checks';
import {PLAYBOOKS} from '../lib/contract-library/playbooks';
import {intakeIsCurrent} from '../lib/intake-state';
import {z} from 'zod';
import type {Contract,User} from '../lib/types';
import {collectIntake,draftConfirmed,verifyConfirmedDraft} from './ai';
import {intakeSummary,transactionSummary} from '../lib/contract-library/playbooks';
import {AppError} from './db';
export interface WorkflowStore {
 load():Promise<{contract:Contract;revision:string|number}>;
 save(contract:Contract,revision:string|number):Promise<Contract>;
 put(key:string,content:import('../lib/types').ContractContent):Promise<string>;
 limit():Promise<void>;
 environment?:Record<string,string|undefined>;
}
const now=()=>new Date().toISOString();
const fail=(code:string,message:string,status=409):never=>{throw new AppError(status,message,code)};
function owner(c:Contract,u:User){if(u.role!=='client'||c.ownerId!==u.id)fail('FORBIDDEN','仅合同所有者可以起草。',403);}
export function activeJob(c:Contract){return ['pending','running'].includes(c.workflow?.job?.status||'');}
export async function startWorkflow(store:WorkflowStore,u:User,input:unknown){
 const v=z.object({requestId:z.string().uuid(),message:z.string().trim().max(16000).default(''),confirmId:z.string().uuid().optional()}).parse(input);
 const {contract:c,revision}=await store.load();owner(c,u);c.workflow??={};
 const old=c.workflow.receipts?.find(r=>r.id===v.requestId);if(old){if(old.message!==v.message||old.confirmId!==v.confirmId)fail('IDEMPOTENCY_CONFLICT','重复请求的内容不一致。');return c;}
 if(c.reviews.some(r=>r.status!=='completed'))fail('REVIEW_VERSION_FROZEN','请在律师审核沟通中补充信息。');
 if(activeJob(c))fail('JOB_ACTIVE','当前任务仍在处理，请等待或取消。');
 let phase:'understand'|'generate'='understand';
 if(v.confirmId){if(c.versions.some(version=>version.content?.confirmation?.summaryId===v.confirmId))return c;const i=c.workflow.intake;if(!i||!intakeIsCurrent(c)||i.summaryId!==v.confirmId||i.missing.length||i.conflicts.length)fail('CONFIRMATION_REQUIRED','约定摘要已变化，请重新核对。');const issues=intakeFactIssues(i!);if(issues.length||requiredFields(i!.templateId).some(f=>!i!.facts[f.id]&&!i!.suggestions?.[f.id]))fail('CONFIRMATION_REQUIRED',issues.join('；')||'起草规则已更新，请补充关键交易信息后重新确认。');c.workflow.intake=acceptSuggestions(i!);c.workflow.intake.confirmedAt=now();phase='generate';}
 else if(!v.message)fail('INVALID_INPUT','请输入合作需求。',400);
 await store.limit();
 if(phase==='understand'){c.workflow.inputRevision=(c.workflow.inputRevision||0)+1;if(c.workflow.intake)delete c.workflow.intake.confirmedAt;}
 const messageId=crypto.randomUUID();c.messages.push({id:messageId,role:'user',content:v.confirmId?'我确认以下交易信息，请按适用规则起草：\n'+transactionSummary(c.workflow.intake!):v.message,createdAt:now()});
 c.workflow.receipts=[...(c.workflow.receipts||[]),{id:v.requestId,message:v.message,confirmId:v.confirmId}];
 c.workflow.job={id:v.requestId,messageId,phase,status:'pending',attempt:0,createdAt:now(),updatedAt:now(),versionId:crypto.randomUUID()};
 return store.save(c,revision);
}
export async function controlWorkflow(store:WorkflowStore,u:User,id:string,action:'run'|'retry'|'cancel'){
 const snapshot=await store.load(),c=snapshot.contract;owner(c,u);const job=c.workflow?.job;
 if(!job||job.id!==id)fail('JOB_NOT_FOUND','任务不存在。',404);
 const j=job!;
 if(action==='cancel'){if(activeJob(c)){j.status='cancelled';j.updatedAt=now();delete j.content;return store.save(c,snapshot.revision);}return c;}
 if(action==='retry'){if(j.status!=='failed')return c;await store.limit();if(j.code==='DRAFT_MISMATCH'||j.code==='EXPORT_NOT_READY'){j.phase='generate';delete j.content;}j.status='pending';j.error=undefined;j.code=undefined;j.updatedAt=now();return store.save(c,snapshot.revision);}
 if(j.status==='running'){
  if(Date.parse(j.leaseUntil||'')>Date.now())return c;
  j.status='failed';j.error='处理连接已中断，信息已保存，请重试继续。';j.code='JOB_INTERRUPTED';j.updatedAt=now();return store.save(c,snapshot.revision);
 }
 if(j.status!=='pending')return c;
 const lease=crypto.randomUUID();j.status='running';j.lease=lease;j.leaseUntil=new Date(Date.now()+90000).toISOString();j.attempt++;j.updatedAt=now();await store.save(c,snapshot.revision);
 const started=Date.now();
 try{
  let intakeResult:Awaited<ReturnType<typeof collectIntake>>|undefined;
  let content=j.content,sha:string|undefined,key:string|undefined;
  if(j.phase==='understand')intakeResult=await collectIntake(c.messages,c.workflow?.intake,store.environment);
  if(j.phase==='generate')content=await draftConfirmed(c.workflow!.intake!,store.environment,j.repairFeedback);
  if(j.phase==='verify'){if(!content)fail('JOB_INVALID','生成内容丢失。');await verifyConfirmedDraft(content!,store.environment);}
  if(j.phase==='export'){if(!content)fail('JOB_INVALID','生成内容丢失，请重新确认约定。');key=`contracts/${c.id}/${j.versionId}-${lease}.docx`;sha=await store.put(key,content!);}
  const fresh=await store.load(),current=fresh.contract,currentJob=current.workflow?.job;
  if(currentJob?.id!==id||currentJob.lease!==lease||currentJob.status!=='running')return current;
  if(current.reviews.some(r=>r.status!=='completed'))fail('REVIEW_VERSION_FROZEN','合同已送审，本次起草已停止。');
  if(intakeResult){if(intakeResult.intake)intakeResult.intake.inputRevision=current.workflow!.inputRevision||0;current.workflow!.intake=intakeResult.intake;current.messages.push({id:crypto.randomUUID(),role:'assistant',content:intakeResult.reply,createdAt:now()});currentJob.status='completed';}
  else if(j.phase==='generate'){currentJob.content=content;currentJob.phase='verify';currentJob.status='pending';}
  else if(j.phase==='verify'){currentJob.phase='export';currentJob.status='pending';}
  else if(content&&key&&sha){if(!current.versions.some(v=>v.id===j.versionId))current.versions.push({id:j.versionId,number:current.versions.length+1,kind:'draft',fileKey:key,content,source:'ai',sha256:sha,createdAt:now()});current.title=content.title;current.messages.push({id:crypto.randomUUID(),role:'assistant',content:'合同 Word 已生成，包含已确认的约定和附件。你可以下载，或提交律师审核。',createdAt:now()});currentJob.status='completed';delete currentJob.content;}
  currentJob.updatedAt=now();delete currentJob.leaseUntil;const result=await store.save(current,fresh.revision);console.info(JSON.stringify({event:'contract_task',job:id,phase:j.phase,result:currentJob.status,elapsedMs:Date.now()-started}));return result;
 }catch(e){
  const fresh=await store.load(),currentJob=fresh.contract.workflow?.job;
  if(currentJob?.id===id&&currentJob.lease===lease&&currentJob.status==='running'){
   if(e instanceof AppError&&e.code==='DRAFT_MISMATCH'&&(currentJob.repairCount||0)<2){
    currentJob.repairCount=(currentJob.repairCount||0)+1;currentJob.repairFeedback=e.message;
    currentJob.phase='generate';currentJob.status='pending';delete currentJob.content;delete currentJob.leaseUntil;
    currentJob.updatedAt=now();return store.save(fresh.contract,fresh.revision);
   }
   currentJob.status='failed';currentJob.code=e instanceof AppError?e.code:'TASK_FAILED';const messages:Record<string,string>={AI_PROVIDER_ERROR:'模型服务返回错误，需求已保存，请重试。',AI_PROVIDER_UNAVAILABLE:'暂时无法连接模型服务，需求已保存，请重试。',AI_NOT_CONFIGURED:'模型服务尚未配置，请联系管理员。',AI_INVALID_CONTRACT:'模型返回的合同结构不完整，请重试。',AI_EMPTY_RESPONSE:'模型连续未返回有效回答，已自动重试一次。你的消息和已确认信息均已保存，可以重试继续，无需重新填写。'};currentJob.error=messages[currentJob.code]||(e instanceof AppError?e.message:'本次处理未完成，信息已保存，请重试。');currentJob.updatedAt=now();delete currentJob.leaseUntil;
   console.error(JSON.stringify({event:'contract_task',job:id,phase:j.phase,code:currentJob.code,elapsedMs:Date.now()-started}));return store.save(fresh.contract,fresh.revision);
  }return fresh.contract;
 }
}
