'use client';
import {useMemo,useRef,useState} from 'react';
import {AssistantRuntimeProvider,ThreadPrimitive,MessagePrimitive,useExternalStoreRuntime,useMessage,type ThreadMessageLike} from '@assistant-ui/react';
import {ArrowUp,ArrowDown,Square,FileText,Download} from 'lucide-react';
import {AgentProgress} from './AgentProgress';
import {StreamingText} from './StreamingText';
import {useAgentView} from './useAgentView';
import {phaseLabels,type AgentView,type AgentViewStore} from '@/lib/agent-view-store';
import type {Message,GenerationJob,Version} from '@/lib/types';
type ViewMessage=Message&{progress?:AgentView};
const parts={Text:StreamingText};
function UserMessage(){return <MessagePrimitive.Root className="chat-message user-message"><div className="bubble"><MessagePrimitive.Parts components={parts}/></div></MessagePrimitive.Root>;}
function AssistantMessage(){
 const progress=useMessage(m=>m.metadata.custom?.progress) as AgentView|undefined;
 return <MessagePrimitive.Root className="chat-message assistant-message"><div className="bubble assistant-bubble">{progress&&<AgentProgress view={progress}/>}<MessagePrimitive.Parts components={parts}/></div></MessagePrimitive.Root>;
}
const messageComponents={UserMessage,AssistantMessage};
const convertMessage=(m:ViewMessage):ThreadMessageLike=>({id:m.id,role:m.role,content:[{type:'text',text:(m.content.startsWith('我确认以下交易信息，请按适用规则起草：\n')?'我已确认交易摘要，请按这些约定起草合同。':m.content).replace(/^【起草模板：[a-z-]+@[\d.]+】\n/,'')}],createdAt:new Date(m.createdAt),metadata:{custom:{progress:m.progress}}});
export function Chat({contractId,store,job,messages,busy,onSend,onCancel,onRetry,onViewDocument,onReview,version,disabled,input,onInputChange:setInput}:{contractId:string;store:AgentViewStore;job?:GenerationJob;messages:Message[];busy:boolean;onSend:(text:string,generate?:boolean)=>Promise<void>;onCancel:()=>Promise<void>;onRetry:()=>Promise<void>;onViewDocument:()=>void;onReview?:()=>void;version?:Version;disabled?:boolean;input:string;onInputChange:(value:string)=>void}){
 const view=useAgentView(store,contractId),[sending,setSending]=useState(false),[stopping,setStopping]=useState(false),[optimistic,setOptimistic]=useState<Message|null>(null);
 const sendingRef=useRef(false),inputRef=useRef(input);inputRef.current=input;
 const progress=view?.jobId===job?.id?view:job&&['pending','running'].includes(job.status)?{jobId:job.id,phase:job.phase,status:job.status,label:phaseLabels[job.phase],text:'',activities:[],createdAt:job.createdAt}:undefined;
 const projected=useMemo<ViewMessage[]>(()=>{
  const rows:ViewMessage[]=[...messages];
  if(optimistic&&!messages.some(m=>m.id===optimistic.id||m.role==='user'&&m.content===optimistic.content&&m.createdAt>=optimistic.createdAt))rows.push(optimistic);
  if(progress&&progress.status!=='completed')rows.push({id:progress.jobId+':reply',role:'assistant',createdAt:progress.createdAt,content:progress.phase==='understand'?progress.text:progress.text?'合同条款已在文档区陆续显示。完成核对并保存后，即可下载 Word。':'',progress});
  return rows;
 },[messages,optimistic,progress]);
 async function cancel(){if(stopping)return;setStopping(true);try{await onCancel();}finally{setStopping(false);}}
 async function send(){
  if(disabled||busy||sendingRef.current||!input.trim())return;
  sendingRef.current=true;setSending(true);const text=input.trim();
  setOptimistic({id:'local:'+crypto.randomUUID(),role:'user',content:text,createdAt:new Date().toISOString()});
  try{await onSend(text);if(inputRef.current.trim()===text)setInput('');setOptimistic(null);}catch{setOptimistic(null);if(!inputRef.current)setInput(text);}finally{sendingRef.current=false;setSending(false);}
 }
 const runtime=useExternalStoreRuntime<ViewMessage>({messages:projected,isRunning:busy||sending,isDisabled:disabled,convertMessage,onCancel:cancel,onNew:async m=>{if(!busy&&!disabled)await onSend(m.content.filter(c=>c.type==='text').map(c=>'text'in c?c.text:'').join('\n'));}});
 const working=busy||sending;
 return <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Root className="chat-thread streaming-thread"><ThreadPrimitive.Viewport className="chat-messages" scrollToBottomOnRunStart={false}>
  <ThreadPrimitive.Messages components={messageComponents}/>
  {job&&job.phase!=='understand'&&['pending','running'].includes(job.status)&&<button className="contract-artifact pending-artifact" onClick={onViewDocument}><FileText size={21}/><span><strong>查看合同初稿</strong><small>{progress?.text?`已生成 ${progress.text.length.toLocaleString()} 字符 · 查看实时预览`:'实时预览 · 尚未保存'}</small></span></button>}
  {job?.status==='cancelled'&&<p className="inline-recovery">本次生成已停止，已有合同和约定已保留。</p>}
  {job?.status==='failed'&&<div className="inline-recovery"><p>{job.error||'本轮未完成，已保存的信息仍然保留。'}</p>{job.code!=='LAWYER_REVISION_REQUIRED'&&<button className="secondary" disabled={busy} onClick={()=>void onRetry()}>重试此任务</button>}</div>}
  {version&&!working&&<section className="contract-artifact"><FileText size={22}/><div><strong>{version.content?.title||'合同文档'}</strong><small>第 {version.number} 版 · {version.source==='lawyer'?'律师修改版':'AI 初稿 · 未经律师审核'}</small><div className="artifact-actions"><a href={`/api/files/${version.id}`}><Download size={14}/>下载 Word</a><button onClick={onViewDocument}>查看文档</button>{onReview&&<button onClick={onReview}>提交律师审核</button>}</div></div></section>}
 </ThreadPrimitive.Viewport><ThreadPrimitive.ScrollToBottom className="chat-follow" aria-label="回到最新消息"><ArrowDown size={16}/></ThreadPrimitive.ScrollToBottom>
 <div className="composer-area"><form className="composer" onSubmit={e=>{e.preventDefault();void send();}}><textarea aria-label="合同需求" value={input} onChange={e=>setInput(e.target.value)} placeholder={disabled?'审核期间，请在审核沟通中补充信息。':working?'可以先写下补充内容，停止或完成后发送…':'补充信息，或告诉我你想怎么修改…'} disabled={disabled} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void send();}}}/>{working?<button type="button" className="send-button stop-button" aria-label={stopping?'正在停止':'停止生成'} disabled={stopping||!job||!['pending','running'].includes(job.status)} onClick={()=>void cancel()}><Square size={14} fill="currentColor"/></button>:<button className="send-button" aria-label="发送需求" disabled={disabled||!input.trim()}><ArrowUp size={20}/></button>}</form><p className="composer-note">{working?'内容正在生成，你可以随时停止。':'AI 初稿未经律师审核，请核对所有约定。'}</p></div></ThreadPrimitive.Root></AssistantRuntimeProvider>;
}
