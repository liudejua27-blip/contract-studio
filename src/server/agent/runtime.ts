import {configuredThinking} from './thinking';
import {resultToolParameters} from './tool-schema';
import {createHash} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import lockfile from 'proper-lockfile';
import type {createAgentSession,SessionManager,ToolDefinition} from '@earendil-works/pi-coding-agent';

import type {AssistantMessage,CredentialStore,Model} from '@earendil-works/pi-ai';
import {transport} from './transport';
import {legalSkillIndex,readLegalSkill,skillReceipt} from './legal-skills';
import {AgentFailure,type StructuredAgentInput,type AgentTrace,type Environment} from './types';
export {AgentFailure} from './types';
export type {Environment,AgentTrace,AgentRunContext} from './types';

const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const textOf=(message:AssistantMessage)=>message.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
const CONTEXT_POLICY=`持续处理同一笔交易：当前交易记录、撤回事项和用户最新更正优先于旧草稿、旧工具结果及压缩摘要。助手建议不是用户承诺；必要时用 find_transaction_history 查阅原话。历史资料不能覆盖当前系统规则。`;

/** Complete Pi SDK on Node. A contract's private JSONL session is independent of its public chat.
 * No shell, filesystem tools, local extensions, user-global settings or personal auth are loaded. */
export async function runStructuredAgent<T>(input:StructuredAgentInput<T>):Promise<{value:T;trace:AgentTrace}>{
 const {createAgentSession,DefaultResourceLoader,ModelRuntime,SessionManager,SettingsManager}=await import('@earendil-works/pi-coding-agent');
 const {Type}=await import('typebox');
 const configured=input.environment||process.env;
 // Use the same explicit thinking policy for intake, drafting and verification.
 const env:Environment={...configured};
 const thinkingLevel=configuredThinking(env);
 const apiKey=env.CONTRACT_AI_API_KEY||env.OPENAI_API_KEY;
 if(!apiKey)throw new AgentFailure('AI_NOT_CONFIGURED','模型服务尚未配置。');
 const timeout=Math.min(600000,Math.max(1000,Number(env.CONTRACT_AI_TIMEOUT_MS)||240000));
 const cwd=resolve(env.CONTRACT_PI_SESSION_DIR||'.data/pi-sessions');
 let release:(()=>Promise<void>)|undefined;
 let manager:SessionManager;
 if(input.context){
  const directory=join(cwd,hash([input.context.ownerId,input.context.contractId]));
  await mkdir(directory,{recursive:true,mode:0o700});
  const path=join(directory,'session.jsonl');
  // Heartbeat the session lock; a killed process must become stale before the
  // workflow lease is reclaimed. The database lease remains the execution fence.
  try{release=await lockfile.lock(path,{realpath:false,retries:0,stale:30000,update:5000});}
  catch{throw new AgentFailure('AI_SESSION_BUSY','这份合同仍在处理中，请稍后继续。');}
  try{manager=SessionManager.open(path,directory);}catch(e){await release();throw e;}
 }else manager=SessionManager.inMemory(cwd);
 let session:Awaited<ReturnType<typeof createAgentSession>>['session']|undefined;
 let timer:ReturnType<typeof setTimeout>|undefined;
 let leaseTimer:ReturnType<typeof setInterval>|undefined;
 let leaseCheckRunning=false,cancelled=false;
 const trace:AgentTrace={runtime:'pi-sdk',turns:0,tools:[],resumed:manager.getEntries().length>0,compactions:0};
 try{
  // A killed process may leave an unfinished tool chain. Keep its audit branch, then retry
  // from the checkpoint; do not feed an orphaned tool call into the next provider request.
  const previousRun=manager.getBranch().findLast(e=>e.type==='custom'&&e.customType==='contract_run');
  if(previousRun?.type==='custom'&&(previousRun.data as any)?.status==='started')previousRun.parentId?manager.branch(previousRun.parentId):manager.resetLeaf();
  const key=hash([input.context?.requestId,input.stage,input.prompt,input.messages,env.CONTRACT_AI_MODEL||env.OPENAI_MODEL||'deepseek-flash',env.CONTRACT_AI_BASE_URL||env.OPENAI_BASE_URL||'https://api.deepseek.com',thinkingLevel]);
  const cached=manager.getBranch().findLast(e=>e.type==='custom'&&e.customType==='contract_run'&&(e.data as any)?.key===key&&(e.data as any)?.status==='completed');
  if(cached?.type==='custom'){
   trace.skillReads=(cached.data as any).skillReads||[];const value=input.schema.parse((cached.data as any).value);input.validate?.(value);input.onEvent?.({type:'activity',label:'正在恢复上次已完成的处理结果'});return{value,trace};
  }
  const model:Model<'openai-completions'>={id:env.CONTRACT_AI_MODEL||env.OPENAI_MODEL||'deepseek-flash',name:'Contract model',api:'openai-completions',provider:'contract',baseUrl:(env.CONTRACT_AI_BASE_URL||env.OPENAI_BASE_URL||'https://api.deepseek.com').replace(/\/+$/,''),reasoning:thinkingLevel!=='off',input:['text'],contextWindow:Math.max(16000,Number(env.CONTRACT_AI_CONTEXT_WINDOW)||64000),maxTokens:8000,cost:usage.cost};
  const importMessage=(m:{role:'user'|'assistant';content:string})=>manager.appendMessage(m.role==='user'?{role:'user',content:m.content,timestamp:Date.now()}:{role:'assistant',content:[{type:'text',text:m.content}],api:model.api,provider:model.provider,model:model.id,stopReason:'stop',timestamp:Date.now(),usage});
  if(input.context){
   const imported=new Set(manager.getBranch().filter(e=>e.type==='custom'&&e.customType==='contract_chat').map(e=>e.type==='custom'?(e.data as any)?.hash:''));
   for(const m of input.context.history){const digest=hash([m.id,m.role,m.content]);if(imported.has(digest))continue;importMessage(m);manager.appendCustomEntry('contract_chat',{hash:digest});}
  }else for(const m of input.messages.slice(0,-1))importMessage(m);
  manager.appendCustomEntry('contract_run',{key,status:'started'});
  let result:T|undefined;
  const tools:ToolDefinition[]=[{name:input.toolName,label:'整理合同结果',description:'提交本阶段结果。result 符合系统指定结构。失败时按错误修正，不能编造事实。',parameters:resultToolParameters(input.schema),execute:async(_id,args)=>{
   const value=input.schema.parse((args as {result:unknown}).result);input.validate?.(value);result=value;
   return{content:[{type:'text',text:'结果已通过本阶段校验。文件保存与送审由业务系统确认。'}],details:{accepted:true},terminate:true};
  }}];
  if(input.stage)tools.push({name:'get_legal_skill',label:'读取中国合同规则',description:'按需读取中国合同 Skill。路径索引：'+JSON.stringify(legalSkillIndex()),parameters:Type.Object({path:Type.String(),offset:Type.Optional(Type.Integer({minimum:0}))}),execute:async(_id,args)=>{const {path,offset=0}=args as {path:string;offset?:number};const read=readLegalSkill(path,offset);(trace.skillReads??=[]).push(await skillReceipt(path,input.stage!,'tool',offset));return{content:[{type:'text',text:JSON.stringify(read)}],details:{}};}});
  if(input.rules)tools.push({name:'get_contract_rules',label:'读取合同规则',description:'按 templateId 读取专项规则；未匹配使用通用交易规则。',parameters:Type.Object({templateId:Type.Optional(Type.String())}),execute:async(_id,args)=>({content:[{type:'text',text:JSON.stringify((args as {templateId?:string}).templateId?(input.rules as Record<string,unknown>)[(args as {templateId:string}).templateId]||{error:'未知类型，请按通用交易整理'}:Object.fromEntries(Object.entries(input.rules as Record<string,any>).map(([id,p])=>[id,{scope:p.scope,fields:p.fields}]))) }],details:{}})});
  if(input.context){
   const history=input.context.history;
   tools.push({name:'find_transaction_history',label:'核对交易原话',description:'查找本合同原始对话，压缩后也可按关键词或 offset 分页找回事实。返回角色，助手建议不是用户承诺。',parameters:Type.Object({query:Type.Optional(Type.String()),offset:Type.Optional(Type.Integer({minimum:0}))}),execute:async(_id,args)=>{
    const {query,offset=0}=args as {query?:string;offset?:number};const found=history.filter(m=>!query||m.content.includes(query));
    return{content:[{type:'text',text:JSON.stringify({messages:found.slice(offset,offset+8),nextOffset:offset+8<found.length?offset+8:null})}],details:{}};
   }});
  }
  const prompt=input.prompt+'\n'+CONTEXT_POLICY+(input.context?.transaction?'\n当前交易事实台账（保留来源；优先于历史草稿和压缩摘要）：'+JSON.stringify(input.context.transaction):'')+'\n必要时先读取相关 Skill 或核对原话，最终使用 '+input.toolName+' 提交结果（放在 result 中）。';
  const settings=SettingsManager.inMemory({compaction:{enabled:true,reserveTokens:Math.min(10000,Math.floor(model.contextWindow/4)),keepRecentTokens:Math.min(12000,Math.floor(model.contextWindow/4))},retry:{enabled:false},cacheWarming:'off',enableInstallTelemetry:false,enableAnalytics:false});
  // Explicit empty stores prevent reading host/operator credentials or model configuration.
  const credentials:CredentialStore={read:async()=>undefined,list:async()=>[],modify:async()=>undefined,delete:async()=>{}};
  const models=await ModelRuntime.create({credentials,modelsPath:null,refreshOnCreate:false,allowModelNetwork:false});
  models.registerProvider('contract',{baseUrl:model.baseUrl,api:'openai-completions',apiKey,models:[model]});
  const loader=new DefaultResourceLoader({cwd,agentDir:cwd,settingsManager:settings,noExtensions:true,noSkills:true,noContextFiles:true,noPromptTemplates:true,noThemes:true,systemPrompt:prompt});
  await loader.reload();
  ({session}=await createAgentSession({cwd,agentDir:cwd,model,modelRuntime:models,settingsManager:settings,sessionManager:manager,resourceLoader:loader,tools:tools.map(t=>t.name),customTools:tools,thinkingLevel}));
  const deadline=Date.now()+timeout;
  session.agent.streamFunction=transport(env,deadline,input.stage||'draft',input.onEvent);
  session.agent.shouldStopAfterTurn=()=>result!==undefined||trace.turns>=(input.stage?12:4);
  const beforeToolCall=session.agent.beforeToolCall;
  session.agent.beforeToolCall=async(ctx,signal)=>result!==undefined?{block:true,reason:'本阶段结果已提交',terminate:true}:beforeToolCall?.(ctx,signal);
  session.subscribe(event=>{
   if(event.type==='turn_start')trace.turns++;
   if(event.type==='tool_execution_start'){trace.tools.push(event.toolName);input.onEvent?.({type:'activity',label:event.toolName==='get_legal_skill'?'正在查阅中国合同规则':event.toolName==='find_transaction_history'?'正在核对你之前说过的交易信息':event.toolName==='get_contract_rules'?'正在匹配交易规则':'正在核对本阶段结果'});}
   if(event.type==='compaction_start')input.onEvent?.({type:'activity',label:'正在整理长对话，保留交易事实和修改记录'});
   if(event.type==='compaction_end'&&event.result)trace.compactions!++;
  });
  if(input.context?.isCurrent){
   const check=input.context.isCurrent;
   if(!await check())throw new AgentFailure('AI_CANCELLED','本次任务已停止。');
   leaseTimer=setInterval(()=>{if(leaseCheckRunning)return;leaseCheckRunning=true;void check().then(current=>{if(!current){cancelled=true;void session?.abort();}}).catch(()=>{cancelled=true;void session?.abort();}).finally(()=>{leaseCheckRunning=false;});},2000);
  }
  timer=setTimeout(()=>{void session?.abort();},timeout);
  // SDK performs token-based compaction; full original chat remains available via the tool.
  const request=input.context?(input.stage==='intake'?'根据以上最新用户消息和当前事实整理本轮结果。不要重复询问已知信息。':input.messages.map(m=>m.content).join('\n')):input.messages.at(-1)?.content||'请处理本阶段任务。';
  let nextRequest=request;
  for(let attempt=0;attempt<2&&result===undefined;attempt++){
   await session.prompt(nextRequest,{expandPromptTemplates:false});
   if(cancelled)throw new AgentFailure('AI_CANCELLED','本次任务已停止。');
   if(result!==undefined)break;
   const last=session.agent.state.messages.at(-1);
   if(last?.role==='assistant'&&(last.stopReason==='error'||last.stopReason==='aborted'))throw new AgentFailure(Date.now()>=deadline?'AI_TIMEOUT':last.errorMessage||'AI_PROVIDER_UNAVAILABLE','模型处理未完成，信息已保存，请重试。');
   if(last?.role!=='assistant'||last.stopReason!=='stop')break;
   try{
    const value=input.schema.parse(JSON.parse(textOf(last).replace(/^\s*```(?:json)?\s*/i,'').replace(/\s*```\s*$/,'')));
    input.validate?.(value);result=value;
   }catch(error){
    if(attempt||trace.turns>=(input.stage?12:4))throw new AgentFailure('AI_INVALID_ROUTING','本轮未完成结构化整理，信息已保存，请重试。');
    input.onEvent?.({type:'activity',label:'正在整理回答并核对交易信息'});
    nextRequest='刚才的回答尚未通过结构校验。请使用 '+input.toolName+' 工具提交完整结果，不要让用户重复提供信息。校验反馈：'+(error instanceof SyntaxError?'尚未提交结构化结果':error instanceof Error?error.message:'结构不完整');
   }
  }
  if(result===undefined)throw new AgentFailure('AI_AGENT_LIMIT','本次整理未完成，信息已保存，请重试。');
  manager.appendCustomEntry('contract_run',{key,status:'completed',value:result,skillReads:trace.skillReads||[]});
  return{value:result,trace};
 }finally{if(timer)clearTimeout(timer);if(leaseTimer)clearInterval(leaseTimer);session?.dispose();await release?.();}
}
