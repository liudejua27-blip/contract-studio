'use client';
import {useEffect,useRef,useState} from 'react';
import {Check,Loader2,FileText,ChevronDown,ChevronUp} from 'lucide-react';
import type {GenerationJob} from '@/lib/types';
const phases=[['understand','整理需求'],['generate','起草条款'],['verify','核对约定'],['export','保存 Word']] as const;
const descriptions={understand:'正在整理你提供的交易信息，只追问会影响合同的事项。',generate:'合同内容会陆续显示在这里，完成后可下载 Word。',verify:'正在检查合同是否与已确认的交易信息一致。',export:'正在排版并保存 Word 文件，保存完成后即可下载。'};
export function AgentProgress({job,streaming}:{job?:GenerationJob;streaming?:{label:string;text:string}}){
 const [clock,setClock]=useState(Date.now()),[expanded,setExpanded]=useState(true);
 const preview=useRef<HTMLPreElement>(null),follow=useRef(true);
 useEffect(()=>{setClock(Date.now());const timer=setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(timer)},[job?.id]);
 const phase=job?.phase||'understand',index=phases.findIndex(p=>p[0]===phase);
 const savedPreview=job?.content?[job.content.title,...job.content.sections.map(s=>s.title+'\n'+s.content)].join('\n\n'):'';
 const text=streaming?.text||savedPreview;
 useEffect(()=>{if(preview.current&&follow.current)preview.current.scrollTop=preview.current.scrollHeight},[text,expanded]);
 const seconds=Math.max(0,Math.floor((clock-(job?Date.parse(job.createdAt):clock))/1000));
 const duration=seconds<60?`${seconds} 秒`:`${Math.floor(seconds/60)} 分 ${seconds%60} 秒`;
 const label=streaming?.label&&!streaming.label.includes('正在连接')?streaming.label:descriptions[phase];
 return <section className="agent-progress" aria-label="合同助手实时进度" aria-busy="true">
  <div className="agent-progress-heading"><span className="agent-progress-icon"><FileText size={19}/></span><div><strong>{phase==='understand'?'正在理解这次交易':'正在生成你的合同'}</strong><span role="timer" className="agent-elapsed">已等待 {duration}</span></div><button type="button" className="icon-button" aria-label={expanded?'收起生成详情':'展开生成详情'} aria-expanded={expanded} onClick={()=>setExpanded(v=>!v)}>{expanded?<ChevronDown size={18}/>:<ChevronUp size={18}/>}</button></div>
  <ol className="agent-steps" aria-label="处理步骤">{phases.map(([id,title],n)=><li key={id} className={n===index?'current':n<index?'done':''} aria-current={n===index?'step':undefined}><span>{n<index?<Check size={12}/>:n===index?<Loader2 size={12} className="spin"/>:n+1}</span>{title}</li>)}</ol>
  <div className="agent-live-status" role="status"><span className="agent-live-dot"/>{label}</div>
  {expanded&&<>{text?<><div className="agent-preview-meta"><span>{phase==='understand'?'回复预览':'合同生成预览'} · 尚未完成校验</span><span>{text.length.toLocaleString()} 字符</span></div><pre ref={preview} onScroll={e=>{const el=e.currentTarget;follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<40}} className="agent-live-preview">{text}<span className="agent-caret" aria-hidden="true"/></pre></>:<div className="agent-skeleton" aria-hidden="true"><span/><span/><span/></div>}<p className="agent-progress-note">{seconds>=30&&!text?'本轮处理时间较长，你提供的信息已保存。可以继续等待或在上方取消；若处理失败，会出现重试入口。':descriptions[phase]}</p></>}
 </section>;
}
