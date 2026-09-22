'use client';
import {useEffect,useState} from 'react';
import {Loader2,ChevronDown,Check, CircleAlert} from 'lucide-react';
import type {AgentView} from '@/lib/agent-view-store';
export function AgentProgress({view}:{view:AgentView}){
 const [clock,setClock]=useState(Date.now());
 const active=['pending','running'].includes(view.status);
 useEffect(()=>{if(!active)return;const timer=setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(timer);},[active,view.jobId]);
 const seconds=Math.max(0,Math.floor((clock-Date.parse(view.createdAt))/1000));
 const label=active?view.label:view.status==='cancelled'?'已停止 · 内容尚未完成':view.status==='failed'?'本轮未完成':'已完成';
 return <details className="agent-activity"><summary><span className="activity-indicator">{active?<Loader2 size={14} className="spin"/>:view.status==='completed'?<Check size={14}/>:<CircleAlert size={14}/>}</span><span role="status">{label}</span>{active&&<small>{seconds<60?`${seconds} 秒`:`${Math.floor(seconds/60)} 分 ${seconds%60} 秒`}</small>}<ChevronDown size={13}/></summary><ul>{view.activities.map((text,i)=><li key={text}>{i===view.activities.length-1&&active?'◦':'·'} {text}</li>)}</ul>{view.error&&<p>{view.error}</p>}</details>;
}
