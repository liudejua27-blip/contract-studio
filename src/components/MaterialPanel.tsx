'use client';
import {useEffect,useState} from 'react';
import {Paperclip,Loader2} from 'lucide-react';
import {api} from '@/lib/api';
import type {MaterialInfo,MaterialPurpose} from '@/lib/materials';
export function MaterialPanel({contractId,revision,busy,onUpload,onRefresh}:{contractId?:string;revision?:number;busy:boolean;onUpload:(file:File,purpose:MaterialPurpose)=>Promise<void>;onRefresh:()=>Promise<void>}){
 const [materials,setMaterials]=useState<MaterialInfo[]>([]),[purpose,setPurpose]=useState<MaterialPurpose>('transaction'),[error,setError]=useState(''),[working,setWorking]=useState(false);
 useEffect(()=>{let active=true;setMaterials([]);if(contractId)void api<MaterialInfo[]>(`contracts/${contractId}/materials`).then(v=>{if(active)setMaterials(v)}).catch(e=>{if(active)setError(e.message)});return()=>{active=false}},[contractId,revision]);
 async function upload(file?:File){if(!file)return;setWorking(true);setError('');try{await onUpload(file,purpose)}catch(e){setError((e as Error).message)}finally{setWorking(false)}}
 async function withdraw(id:string){setWorking(true);setError('');try{setMaterials(await api(`contracts/${contractId}/materials/${id}/withdraw`,{}));await onRefresh()}catch(e){setError((e as Error).message)}finally{setWorking(false)}}
 return <details className="context-section material-panel" open={materials.length>0||undefined}><summary><Paperclip size={15}/>合同材料{materials.length?` · ${materials.length} 份`:''}</summary>
  <p className="muted small">可以上传已有合同、报价单或交易说明。上传后直接说你要怎样起草或修改；材料内容会先进入待确认摘要。</p>
  <div className="material-upload"><label>材料用途<select aria-label="材料用途" value={purpose} disabled={busy||working} onChange={e=>setPurpose(e.target.value as MaterialPurpose)}><option value="transaction">本次交易材料</option><option value="reference">参考范本，仅参考写法</option></select></label><label className="secondary upload-button">{working?<Loader2 className="spin" size={15}/>:<Paperclip size={15}/>}{working?'正在读取材料…':'添加材料'}<input type="file" accept=".docx,.pdf,.txt,.md" aria-label="上传合同材料" disabled={busy||working} onChange={e=>{void upload(e.target.files?.[0]);e.target.value=''}}/></label></div>
  <p className="muted small">DOCX、PDF、TXT / Markdown · 单份不超过 10 MB。扫描页是否识别以读取结果为准，识别内容需对照原件。</p>
  {error&&<p className="error" role="alert">{error}</p>}
  {materials.map(m=><section className="material-item" key={m.id}><div><a href={`/api/contracts/${contractId}/materials/${m.id}`}>{m.name}</a><span>{m.purpose==='reference'?'参考范本':'交易材料'} · {{ready:'文字已读取',partial:'部分页面需核对',needs_ocr:'需提供文字版'}[m.status]}</span></div><button type="button" className="text-button" disabled={busy||working} onClick={()=>void withdraw(m.id)}>移出本次起草</button>{m.warnings.map((w,n)=><p className="muted small" key={n}>{w}</p>)}</section>)}
 </details>;
}
