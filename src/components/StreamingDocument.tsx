'use client';
import {visibleContractText} from '@/lib/contract-document';
import {useEffect,useRef,useState} from 'react';
import {ArrowDown,FileText} from 'lucide-react';
import type {AgentViewStore} from '@/lib/agent-view-store';
import type {GenerationJob} from '@/lib/types';
import {useAgentView} from './useAgentView';
import {StreamingText} from './StreamingText';
export function StreamingDocument({store,contractId,job}:{store:AgentViewStore;contractId:string;job?:GenerationJob}){
 const view=useAgentView(store,contractId),root=useRef<HTMLDivElement>(null),follow=useRef(true);
 const [atBottom,setAtBottom]=useState(true);
 const saved=job?.content?visibleContractText(job.content):'';
 const text=view?.jobId===job?.id?view?.text||saved:saved;
 useEffect(()=>{const el=root.current;if(el&&follow.current)el.scrollTop=el.scrollHeight;},[text]);
 return <div className="stream-document"><header><FileText size={18}/><strong>合同初稿</strong><span>{job?.status==='failed'||job?.status==='cancelled'?'尚未完成':'生成中'}</span></header><div ref={root} className="stream-document-scroll" onScroll={e=>{const el=e.currentTarget;follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<60;setAtBottom(follow.current);}}><article className="stream-document-paper">{text?<StreamingText text={text}/>:<div className="stream-document-empty"><FileText size={28}/><p>正在组织合同条款</p><small>正文到达后会陆续显示在这里</small></div>}</article></div>{!atBottom&&<button className="document-follow secondary" onClick={()=>{follow.current=true;setAtBottom(true);root.current?.scrollTo({top:root.current.scrollHeight,behavior:'smooth'});}}><ArrowDown size={14}/>查看最新内容</button>}<footer>实时草稿 · 尚未完成核对与保存</footer></div>;
}
