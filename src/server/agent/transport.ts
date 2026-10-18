import {estimateInputTokens,TaskBudgetError,type ModelBudgetGate} from '../../lib/task-budget';
import {thinkingParameters} from './thinking';
import {readModelResponse} from './model-stream';
import type {AgentEventSink} from '../../lib/agent-stream';
import type {StreamFn} from '@earendil-works/pi-agent-core';
import type {AssistantMessage,JsonObject} from '@earendil-works/pi-ai';
import {AgentFailure,type Environment} from './types';
const textOf=(content:unknown):string=>typeof content==='string'?content:Array.isArray(content)?content.filter(c=>c.type==='text').map(c=>c.text).join('\n'):'';
function parse(text:string):unknown {try{return JSON.parse(text?.trim()||'{}')}catch{throw new AgentFailure('AI_INVALID_ROUTING','模型返回的内容不完整，请重试。')}}
/** Compatibility adapter. Session lifecycle and compaction belong to the complete Pi SDK.
 * Reasoning is retained privately for provider continuity, never emitted as public preview. */
export function transport(env:Environment, deadline:number,stage:'intake'|'draft'|'verify',emit?:AgentEventSink,onRateLimit?:(retryAfterMs:number)=>Promise<void>,onModelCall?:(call:import('../operations').ModelCall)=>Promise<void>,budget?:ModelBudgetGate,recovery?:{outputTokens:number;resultTool?:string;progress?:()=>import('./stage-progress').StageProgress;onTruncated:(nextOutputTokens:number)=>Promise<void>}):StreamFn {
 let outputTokens=recovery?.outputTokens||Number(env.CONTRACT_AI_MAX_OUTPUT_TOKENS)||(stage==='draft'?24576:16384);
 const ceiling=Math.max(outputTokens,Number(env.CONTRACT_AI_MAX_RECOVERY_TOKENS)||65536);
 return async (model,context,options)=>{
  const {createAssistantMessageEventStream}=await import('@earendil-works/pi-ai/utils/event-stream');
  const {getCurrentSystemPrompt,resolveTranscriptTools}=await import('@earendil-works/pi-ai/utils/transcript');
  const stream=createAssistantMessageEventStream();
  const message:AssistantMessage={role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[],stopReason:'stop',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  void(async()=>{
   try{
    const tools=resolveTranscriptTools(context.messages,false).requestTools;
    const progress=recovery?.progress?.();
    const recentError=context.messages.findLast(m=>m.role==='toolResult'&&m.toolName===recovery?.resultTool);
    const toolError=recentError?.role==='toolResult'&&recentError.isError?textOf(recentError.content).split('\n\nReceived arguments:')[0]:'';
    const progressText=progress?'\n本阶段已暂存的候选结果（尚未整体校验，不是已确认事实；只补充或修正变化部分）：'+JSON.stringify(progress.value)+(toolError||progress.feedback?'\n待修复问题：'+(toolError||progress.feedback):''):'';
    const messages:unknown[]=[{role:'system',content:getCurrentSystemPrompt(context.messages)+progressText}];
    // Result-tool mutations have been materialized in the private candidate above. Drop
    // their old arguments AND matching results together. Keep the latest receipt so the
    // model continues after the tool instead of repeatedly restarting its first step.
    const omitted=new Set(context.messages.flatMap(m=>m.role==='assistant'?m.content.filter(c=>c.type==='toolCall'&&c.name===recovery?.resultTool&&c.id!==(recentError?.role==='toolResult'?recentError.toolCallId:undefined)).map(c=>(c as {id:string}).id):[]));
    for(const m of context.messages){
     if(m.role==='system')continue;
     if(m.role==='user')messages.push({role:'user',content:textOf(m.content)});
     if(m.role==='toolResult'&&!omitted.has(m.toolCallId))messages.push({role:'tool',tool_call_id:m.toolCallId,content:textOf(m.content)});
     if(m.role==='assistant'){
      const calls=m.content.filter(c=>c.type==='toolCall').filter(c=>!omitted.has(c.id));
      if(m.content.some(c=>c.type==='toolCall'&&omitted.has(c.id))&&!calls.length)continue;
      messages.push({role:'assistant',content:textOf(m.content)||(new URL(model.baseUrl).hostname==='api.deepseek.com'?'':null),...((m.content.some(c=>c.type==='thinking')||(tools.length&&new URL(model.baseUrl).hostname==='api.deepseek.com'))?{reasoning_content:m.content.filter(c=>c.type==='thinking').map(c=>c.thinking).join('')}:{ }),...(calls.length?{tool_calls:calls.map(c=>({id:c.id,type:'function',function:{name:c.name,arguments:JSON.stringify(c.arguments)}}))}:{})});
     }
    }
    let payload:any;
    for(let attempt=0;attempt<3;attempt++){
     const remaining=deadline-Date.now();if(remaining<=0)throw new AgentFailure('AI_TIMEOUT','本次处理超时，信息已保存，请重试。');
     let reservation;try{reservation=await budget?.reserve(estimateInputTokens({messages,tools}),outputTokens);}catch(error){throw new AgentFailure(error instanceof TaskBudgetError?error.code:'AI_BUDGET_RECORD_FAILED','任务预算检查未通过。');}
     const callStarted=Date.now();let callStatus='failed',callUsage:any;
     try{
      const signal=AbortSignal.any([AbortSignal.timeout(Math.min(remaining,reservation?.timeoutMs??remaining)),...(options?.signal?[options.signal]:[])]);
      const response=await fetch(model.baseUrl+'/chat/completions',{method:'POST',signal,headers:{'content-type':'application/json',authorization:'Bearer '+(env.CONTRACT_AI_API_KEY||env.OPENAI_API_KEY)},body:JSON.stringify({model:model.id,messages,stream:true,stream_options:{include_usage:true},max_tokens:reservation?.maxOutputTokens??outputTokens,...thinkingParameters(model.baseUrl,env,options?options.reasoning??'off':undefined),...(tools.length?{tools:tools.map(t=>({type:'function',function:{name:t.name,description:t.description,parameters:t.parameters}})),tool_choice:'auto'}:{})})});
      if(response.status===429){const raw=response.headers.get('retry-after');const seconds=Number(raw);const delay=raw?(Number.isFinite(seconds)?seconds*1000:Date.parse(raw)-Date.now()):30000;await onRateLimit?.(Number.isFinite(delay)?Math.min(600000,Math.max(1000,delay)):30000);throw new AgentFailure('AI_PROVIDER_RATE_LIMITED','模型服务繁忙，已保存进度，稍后自动继续。');}
      if(!response.ok){console.warn(JSON.stringify({event:'pi_provider_error',status:response.status}));throw new AgentFailure(response.status===429||response.status>=500?'AI_PROVIDER_ERROR':'AI_PROVIDER_REJECTED','模型服务暂时未能处理，请重试。');}
      payload=await readModelResponse(response,stage,tools.length?emit:undefined);callUsage=payload.usage;const choice=payload.choices?.[0];
      if(choice?.finish_reason==='length')throw new AgentFailure('AI_OUTPUT_TRUNCATED','模型输出不完整，未保存新版本。');
      if(!choice?.message?.content?.trim()&&!choice?.message?.tool_calls?.length)throw new AgentFailure('AI_EMPTY_RESPONSE','模型未返回有效内容，信息已保存。');
      for(const call of choice.message.tool_calls||[])parse(call.function.arguments);
      callStatus='ok';break;
     }catch(e){
      callStatus=e instanceof AgentFailure?e.code:'network_error';
      if(options?.signal?.aborted||Date.now()>=deadline)throw new AgentFailure('AI_TIMEOUT','处理已中断，信息已保存。');
      if(e instanceof AgentFailure&&e.code==='AI_OUTPUT_TRUNCATED'){
       const next=Math.min(ceiling,outputTokens*2);
       if(next<=outputTokens||attempt===2)throw e;
       outputTokens=next;await recovery?.onTruncated(next);
       messages.push({role:'user',content:'上一响应被输出长度限制截断，未执行其中任何工具或保存其不完整内容。输出空间已扩大。请继续已完成的工作；复杂结果分段调用结果工具 complete=false 保存本次部分，最后 complete=true 校验。不要重新复述全部材料或已保存内容。'});
       emit?.({type:'preview',text:''});emit?.({type:'activity',label:'内容较长，正在扩大输出空间并分段继续'});continue;
      }
      if(attempt>=1||e instanceof AgentFailure&&!['AI_EMPTY_RESPONSE','AI_PROVIDER_ERROR','AI_INVALID_ROUTING'].includes(e.code))throw e;
      emit?.({type:'preview',text:''});emit?.({type:'activity',label:'回答未完整返回，正在自动恢复本轮处理'});
     }finally{
      const call={model:model.id,stage,status:callStatus,durationMs:Date.now()-callStarted,inputTokens:Number.isFinite(callUsage?.prompt_tokens)?callUsage.prompt_tokens:null,outputTokens:Number.isFinite(callUsage?.completion_tokens)?callUsage.completion_tokens:null};
      await onModelCall?.(call).catch(()=>console.error('model_usage_record_failed'));
      if(budget&&reservation)try{await budget.settle(reservation,call);}catch{throw new AgentFailure('AI_BUDGET_RECORD_FAILED','用量未能保存，已停止新的调用。');}
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
