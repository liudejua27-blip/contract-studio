'use client';
import {reviewBrief} from '@/lib/contract-intent';
import {useEffect,useRef,useState} from 'react';
import {ArrowRight,FileText,Loader2,X} from 'lucide-react';
import {api} from '@/lib/api';
import type {Contract,Version} from '@/lib/types';

export function ReviewRequestDialog({contract,version,consultation,onClose,onSubmitted}:{contract:Contract;version?:Version;consultation:boolean;onClose:()=>void;onSubmitted:(contract:Contract)=>void}){
 const initial=reviewBrief(contract,version,consultation);
 const responsible=contract.reviews.find(r=>r.lawyerId);
 const dialog=useRef<HTMLDialogElement>(null),goalInput=useRef<HTMLTextAreaElement>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[concerns,setConcerns]=useState(initial.concerns),[stance,setStance]=useState(initial.stance);
 const [lawyers,setLawyers]=useState<{id:string;name:string}[]>([]),[loading,setLoading]=useState(true),[lawyersError,setLawyersError]=useState(false),[retry,setRetry]=useState(0);
 useEffect(()=>{const previous=document.activeElement as HTMLElement|null;dialog.current?.showModal();goalInput.current?.focus({preventScroll:true});return()=>{dialog.current?.close();previous?.focus()}},[]);
 useEffect(()=>{let active=true;setLoading(true);setLawyersError(false);api<{id:string;name:string}[]>('lawyers').then(rows=>{if(active)setLawyers(rows)}).catch(()=>{if(active)setLawyersError(true)}).finally(()=>{if(active)setLoading(false)});return()=>{active=false}},[retry]);
 return <dialog ref={dialog} className="modal review-request" aria-labelledby="review-title" aria-describedby="review-description" onCancel={e=>{e.preventDefault();if(!busy)onClose()}} onClick={e=>{if(e.target===e.currentTarget&&!busy){const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)onClose()}}}>
  <button className="modal-close icon-button" aria-label="取消提交" disabled={busy} onClick={onClose}><X size={20}/></button>
  <span className="eyebrow">{consultation?'约定协助':'交给律师 · 最后把关'}</span>
  <h2 id="review-title">你的核心诉求是什么？</h2>
  <p id="review-description" className="muted">{consultation?'告诉律师你最想解决的未定安排，沟通后再继续起草。':'让律师先了解你最想保障的结果，再逐条审阅合同。'}</p>
  {!consultation&&version&&<div className="review-file"><FileText size={20}/><div><strong>{contract.title}</strong><small>第 {version.number} 版 Word · 提交后保留此版本</small></div></div>}
  {(initial.concerns||initial.stance)&&<p className="muted small">已带入{consultation?'对话中':'本版起草时'}记录的诉求与立场，可在下方补充或更正。送审说明不会自动改写 Word 正文。</p>}
  <form onSubmit={async e=>{e.preventDefault();if(busy||!concerns.trim()||!stance.trim())return;const data=Object.fromEntries(new FormData(e.currentTarget));setBusy(true);setError('');try{const result=await api<Contract>(`contracts/${contract.id}/reviews`,{...data,concerns:concerns.trim(),stance:stance.trim(),lawyerId:data.lawyerId||undefined,versionId:consultation?undefined:version?.id,consultation});onSubmitted(result)}catch(e){setError((e as Error).message);setBusy(false)}}}>
   <label className="request-goal">核心诉求<textarea ref={goalInput} name="concerns" required maxLength={3000} value={concerns} disabled={busy} onChange={e=>setConcerns(e.target.value)} placeholder="例如：我最担心付了钱却拿不到成果，希望把交付、整改和退款写清楚。"/></label>
   <p className="field-hint">用自己的话说即可，不需要法律术语。<span>{concerns.length}/3000</span></p>
   <label>你代表哪一方？<input name="stance" required maxLength={100} value={stance} disabled={busy} onChange={e=>setStance(e.target.value)} placeholder="例如：甲方，委托开发的一方"/></label>
   <div className="stance-shortcuts" aria-label="快速选择立场">{(version?.content?.parties.map(p=>p.role)||['甲方','乙方']).map(role=><button key={role} type="button" aria-pressed={stance===role} disabled={busy} onClick={()=>setStance(role)}>{role}</button>)}</div>
   {responsible?<p className="muted small">负责律师：{responsible.lawyerName||'已确定律师'}，由这位律师持续沟通、完善和交付合同。</p>:<details className="review-options"><summary>律师安排 <span>默认由平台分配</span></summary><label>选择审核律师<select name="lawyerId" disabled={busy||loading} defaultValue=""><option value="">由平台分配律师</option>{lawyers.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select></label>{loading?<p className="muted small">正在加载可选律师…</p>:lawyersError?<p className="muted small">律师列表暂不可用，仍可提交后由平台分配。<button type="button" className="text-button" disabled={busy} onClick={()=>setRetry(n=>n+1)}>重新加载</button></p>:<p className="muted small">{lawyers.length?'也可以选择熟悉的律师。':'提交后由平台安排律师。'}</p>}</details>}
   {version?.source==='demo'&&<p className="notice">当前为示例文件，仅供流程体验。</p>}
   {error&&<p className="error" role="alert">{error}</p>}
   <footer className="dialog-actions"><button className="secondary" type="button" disabled={busy} onClick={onClose}>取消</button><button className="primary" disabled={busy||!concerns.trim()||!stance.trim()}>{busy?<Loader2 size={16} className="spin"/>:<ArrowRight size={16}/>} {busy?'正在提交…':consultation?'请求约定协助':'提交律师审核'}</button></footer>
  </form>
 </dialog>;
}
