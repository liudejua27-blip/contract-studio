import {configuredThinking,thinkingParameters} from './thinking';
import {resultToolParameters} from './tool-schema';
/** Frozen Sites/Worker compatibility runtime. The Node application uses runtime.ts (full Pi SDK). */
import {readModelResponse} from './model-stream';
import {legalSkillIndex,readLegalSkill,skillReceipt} from './legal-skills';
import type {AgentEventSink} from '../../lib/agent-stream';
import type {AgentTool, StreamFn} from '@earendil-works/pi-agent-core';
import type {AssistantMessage, Model, JsonObject} from '@earendil-works/pi-ai';
import type {ZodType} from 'zod';

export type Environment = Record<string,string|undefined>;
export type AgentTrace = {runtime:'pi-core'; turns:number; tools:string[];skillReads?:import('../../lib/skill-audit').SkillReceipt[]};
export class AgentFailure extends Error {
 constructor(public code:string,message:string){super(message);}
}
const textOf=(content:unknown):string=>typeof content==='string'?content:Array.isArray(content)?content.filter(c=>c.type==='text').map(c=>c.text).join('\n'):'';
function parse(text:string):unknown {
 const clean=(text?.trim()||'{}').replace(/^\s*```(?:json)?\s*/i,'').replace(/\s*```\s*$/,'').trim();
 try{return JSON.parse(clean)}catch{throw new AgentFailure('AI_INVALID_ROUTING','模型返回的内容不完整，请重试。');}
}

/** OpenAI-compatible streaming transport with public preview projection. Pi owns the tool loop.
 * Never forwards provider errors, reasoning content, credentials, or raw traces to the UI. */
function transport(env:Environment, deadline:number,stage:'intake'|'draft'|'verify',emit?:AgentEventSink):StreamFn {
 return async (model,context,options)=>{
  const {createAssistantMessageEventStream}=await import('@earendil-works/pi-ai/utils/event-stream');
  const {getCurrentSystemPrompt,resolveTranscriptTools}=await import('@earendil-works/pi-ai/utils/transcript');
  const stream=createAssistantMessageEventStream();
  const message:AssistantMessage={role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[],stopReason:'stop',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  void(async()=>{
   try{
    const tools=resolveTranscriptTools(context.messages,false).requestTools;
    const messages:unknown[]=[{role:'system',content:getCurrentSystemPrompt(context.messages)}];
    for(const m of context.messages){
     if(m.role==='system')continue;
     if(m.role==='user')messages.push({role:'user',content:textOf(m.content)});
     if(m.role==='toolResult')messages.push({role:'tool',tool_call_id:m.toolCallId,content:textOf(m.content)});
     if(m.role==='assistant'){
      const calls=m.content.filter(c=>c.type==='toolCall');
      messages.push({role:'assistant',content:textOf(m.content)||(new URL(model.baseUrl).hostname==='api.deepseek.com'?'':null),...((m.content.some(c=>c.type==='thinking')||new URL(model.baseUrl).hostname==='api.deepseek.com')?{reasoning_content:m.content.filter(c=>c.type==='thinking').map(c=>c.thinking).join('')}:{}),...(calls.length?{tool_calls:calls.map(c=>({id:c.id,type:'function',function:{name:c.name,arguments:JSON.stringify(c.arguments)}}))}:{})});
     }
    }
    let payload:any;
    for(let attempt=0;attempt<2;attempt++){
     const remaining=deadline-Date.now();if(remaining<=0)throw new AgentFailure('AI_TIMEOUT','本次处理超时，信息已保存，请重试。');
     try{
      const signal=AbortSignal.any([AbortSignal.timeout(remaining),...(options?.signal?[options.signal]:[])]);
      const response=await fetch(model.baseUrl+'/chat/completions',{method:'POST',signal,headers:{'content-type':'application/json',authorization:'Bearer '+(env.CONTRACT_AI_API_KEY||env.OPENAI_API_KEY)},body:JSON.stringify({model:model.id,messages,stream:true,max_tokens:8000,...thinkingParameters(model.baseUrl,env,options?options.reasoning??'off':undefined),tools:tools.map(t=>({type:'function',function:{name:t.name,description:t.description,parameters:t.parameters}})),tool_choice:new URL(model.baseUrl).hostname==='api.deepseek.com'&&configuredThinking(env)!=='off'?'auto':'required'})});
      if(!response.ok){console.warn(JSON.stringify({event:'pi_provider_error',status:response.status}));throw new AgentFailure(response.status===429||response.status>=500?'AI_PROVIDER_ERROR':'AI_PROVIDER_REJECTED','模型服务暂时未能处理，请重试。');}
      payload=await readModelResponse(response,stage,emit);const choice=payload.choices?.[0];
      if(choice?.finish_reason==='length')throw new AgentFailure('AI_OUTPUT_TRUNCATED','模型输出不完整，未保存新版本。');
      if(!choice?.message?.content?.trim()&&!choice?.message?.tool_calls?.length)throw new AgentFailure('AI_EMPTY_RESPONSE','模型未返回有效内容，信息已保存。');
      for(const call of choice.message.tool_calls||[])parse(call.function.arguments);
      break;
     }catch(e){
      if(options?.signal?.aborted||Date.now()>=deadline)throw new AgentFailure('AI_TIMEOUT','处理已中断，信息已保存。');
      if(attempt||e instanceof AgentFailure&&!['AI_EMPTY_RESPONSE','AI_PROVIDER_ERROR','AI_OUTPUT_TRUNCATED','AI_INVALID_ROUTING'].includes(e.code))throw e;
      emit?.({type:'preview',text:''});emit?.({type:'activity',label:'回答未完整返回，正在自动恢复本轮处理'});
     }
    }
    const answer=payload.choices[0].message;
    if(answer.reasoning_content)message.content.push({type:'thinking',thinking:answer.reasoning_content});
    if(answer.content)message.content.push({type:'text',text:answer.content});
    for(const c of answer.tool_calls||[])message.content.push({type:'toolCall',id:c.id,name:c.function.name,arguments:parse(c.function.arguments) as JsonObject});
    message.stopReason=answer.tool_calls?.length?'toolUse':'stop';
    message.usage.input=payload.usage?.prompt_tokens||0;message.usage.output=payload.usage?.completion_tokens||0;message.usage.totalTokens=message.usage.input+message.usage.output;
    stream.push({type:'start',partial:message});stream.push({type:'done',reason:message.stopReason,message});
   }catch(e){
    message.stopReason='error';message.errorMessage=e instanceof AgentFailure?e.code:'AI_PROVIDER_UNAVAILABLE';
    stream.push({type:'error',reason:'error',error:message});
   }
  })();return stream;
 };
}

export async function runStructuredAgent<T>(input:{prompt:string;messages:Array<{role:'user'|'assistant';content:string}>;schema:ZodType<T,any,any>;toolName:string;environment?:Environment;rules?:unknown;onEvent?:AgentEventSink;stage?:'intake'|'draft'|'verify';validate?:(value:T)=>void}):Promise<{value:T;trace:AgentTrace}>{
 const {Agent}=await import('@earendil-works/pi-agent-core');
 const {Type}=await import('typebox');
 const env=input.environment||process.env;
 const thinkingLevel=configuredThinking(env);
 if(!(env.CONTRACT_AI_API_KEY||env.OPENAI_API_KEY))throw new AgentFailure('AI_NOT_CONFIGURED','模型服务尚未配置。');
 const model:Model<'openai-completions'>={id:env.CONTRACT_AI_MODEL||env.OPENAI_MODEL||'deepseek-flash',name:'Contract model',api:'openai-completions',provider:'contract',baseUrl:(env.CONTRACT_AI_BASE_URL||env.OPENAI_BASE_URL||'https://api.deepseek.com').replace(/\/+$/,''),reasoning:thinkingLevel!=='off',input:['text'],contextWindow:64000,maxTokens:8000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
 let result:T|undefined;
 const trace:AgentTrace={runtime:'pi-core',turns:0,tools:[]};
 const terminal:AgentTool={name:input.toolName,label:'整理合同结果',description:'提交本阶段结构化结果。result 必须符合系统提示指定的 JSON 结构。检查失败时根据工具错误修正，不能编造事实。',parameters:resultToolParameters(input.schema),execute:async(_id,args)=>{
  const value=input.schema.parse((args as {result:unknown}).result);input.validate?.(value);result=value;
  return{content:[{type:'text',text:'已接收此阶段结果。文件保存和最终完成状态由业务系统确认。'}],details:{accepted:true},terminate:true};
 }};
 const tools:AgentTool[]=[terminal];
 if(input.stage)tools.unshift({name:'get_legal_skill',label:'读取中国合同规则',description:'按需读取中国法律Skill参考。路径索引：'+JSON.stringify(legalSkillIndex()),parameters:Type.Object({path:Type.String(),offset:Type.Optional(Type.Integer({minimum:0}))}),execute:async(_id,args)=>{const {path,offset=0}=args as {path:string;offset?:number};const read=readLegalSkill(path,offset);(trace.skillReads??=[]).push(await skillReceipt(path,input.stage!,'tool',offset));return{content:[{type:'text',text:JSON.stringify(read)}],details:{}};}});
 if(input.rules)tools.unshift({name:'get_contract_rules',label:'读取合同规则',description:'读取合同类型的字段与规则。已知类型时传templateId，仅返回对应规则，避免读取整个规则库。',parameters:Type.Object({templateId:Type.Optional(Type.String())}),execute:async(_id,args)=>({content:[{type:'text',text:JSON.stringify((args as {templateId?:string}).templateId?(input.rules as Record<string,unknown>)[(args as {templateId:string}).templateId]||{error:'未知类型，请按通用交易整理'}:Object.fromEntries(Object.entries(input.rules as Record<string,any>).map(([id,p])=>[id,{scope:p.scope,fields:p.fields}])))}],details:{}})});
 const agent=new Agent({initialState:{model,thinkingLevel,systemPrompt:input.prompt+'\n请使用 '+input.toolName+' 工具提交结果（放在 result 中），不要只描述你准备做什么。',tools},streamFn:transport(env,Date.now()+Math.min(65000,Math.max(1000,Number(env.CONTRACT_AI_TIMEOUT_MS)||65000)),input.stage||'draft',input.onEvent),toolExecution:'sequential',shouldStopAfterTurn:()=>result!==undefined||trace.turns>=(input.stage?8:4),beforeToolCall:async()=>result!==undefined?{block:true,reason:'本阶段已提交',terminate:true}:undefined});
 agent.subscribe(event=>{if(event.type==='turn_start')trace.turns++;if(event.type==='tool_execution_start'){trace.tools.push(event.toolName);input.onEvent?.({type:'activity',label:event.toolName==='get_legal_skill'?'正在查阅中国合同起草与审查规则':event.toolName==='get_contract_rules'?'正在匹配交易规则':'正在核对本阶段结果'});}});
 await agent.prompt(input.messages.slice(-24).map(m=>m.role==='user'?{role:'user' as const,content:m.content,timestamp:Date.now()}:{role:'assistant' as const,content:[{type:'text' as const,text:m.content}],api:model.api,provider:model.provider,model:model.id,stopReason:'stop' as const,timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}));
 if(result===undefined){
  const last=agent.state.messages.at(-1);
  if(last?.role==='assistant'&&last.stopReason==='error')throw new AgentFailure(last.errorMessage||'AI_PROVIDER_UNAVAILABLE','模型处理未完成，信息已保存，请重试。');
  // Some compatible models emit JSON directly. Apply exactly the same validation.
  if(last?.role==='assistant'&&last.stopReason==='stop'){result=input.schema.parse(parse(textOf(last.content)));input.validate?.(result);}
 }
 if(result===undefined)throw new AgentFailure('AI_AGENT_LIMIT','本次整理未完成，信息已保存，请重试或补充说明。');
 return{value:result,trace};
}
