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
export function transport(env:Environment, deadline:number,stage:'intake'|'draft'|'verify',emit?:AgentEventSink):StreamFn {
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
      messages.push({role:'assistant',content:textOf(m.content)||(new URL(model.baseUrl).hostname==='api.deepseek.com'?'':null),...((m.content.some(c=>c.type==='thinking')||(tools.length&&new URL(model.baseUrl).hostname==='api.deepseek.com'))?{reasoning_content:m.content.filter(c=>c.type==='thinking').map(c=>c.thinking).join('')}:{ }),...(calls.length?{tool_calls:calls.map(c=>({id:c.id,type:'function',function:{name:c.name,arguments:JSON.stringify(c.arguments)}}))}:{})});
     }
    }
    let payload:any;
    for(let attempt=0;attempt<2;attempt++){
     const remaining=deadline-Date.now();if(remaining<=0)throw new AgentFailure('AI_TIMEOUT','本次处理超时，信息已保存，请重试。');
     try{
      const signal=AbortSignal.any([AbortSignal.timeout(remaining),...(options?.signal?[options.signal]:[])]);
      const response=await fetch(model.baseUrl+'/chat/completions',{method:'POST',signal,headers:{'content-type':'application/json',authorization:'Bearer '+(env.CONTRACT_AI_API_KEY||env.OPENAI_API_KEY)},body:JSON.stringify({model:model.id,messages,stream:true,max_tokens:8000,...thinkingParameters(model.baseUrl,env,options?options.reasoning??'off':undefined),...(tools.length?{tools:tools.map(t=>({type:'function',function:{name:t.name,description:t.description,parameters:t.parameters}})),tool_choice:'auto'}:{})})});
      if(!response.ok){console.warn(JSON.stringify({event:'pi_provider_error',status:response.status}));throw new AgentFailure(response.status===429||response.status>=500?'AI_PROVIDER_ERROR':'AI_PROVIDER_REJECTED','模型服务暂时未能处理，请重试。');}
      payload=await readModelResponse(response,stage,tools.length?emit:undefined);const choice=payload.choices?.[0];
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
