'use client';
import {useEffect,useState} from 'react';
import {Paperclip,Loader2} from 'lucide-react';
import {api,dateLabel} from '@/lib/api';
import type {MaterialInfo} from '@/lib/materials';
import type {Contract} from '@/lib/types';
export function ReviewMaterials({contractId,reviewId,revision,canUpload,busy,onUpdate}:{contractId:string;reviewId:string;revision:string;canUpload:boolean;busy:boolean;onUpdate:(c:Contract)=>void}){
 const [items,setItems]=useState<MaterialInfo[]>([]),[working,setWorking]=useState(false),[error,setError]=useState('');
 const path=`contracts/${contractId}/reviews/${reviewId}/materials`;
 useEffect(()=>{let active=true;void api<MaterialInfo[]>(path).then(v=>{if(active)setItems(v)}).catch(e=>{if(active)setError(e.message)});return()=>{active=false}},[path,revision]);
 async function upload(file?:File){if(!file)return;setWorking(true);setError('');try{const form=new FormData();form.set('file',file);setItems(await api(path,form));onUpdate(await api<Contract>(`contracts/${contractId}`));}catch(e){setError((e as Error).message)}finally{setWorking(false)}}
 return <section className="context-section"><h3><Paperclip size={16}/>补充材料</h3><p className="muted small">提供报价单、交货清单等资料，供负责律师核对。原送审合同保持不变。</p>
 {items.map(item=><p key={item.id}><a href={`/api/contracts/${contractId}/materials/${item.id}`}>{item.name}</a><small className="muted"> · {dateLabel(item.createdAt)}</small></p>)}
 {canUpload&&<label className="secondary upload-button">{working?<Loader2 size={15} className="spin"/>:<Paperclip size={15}/>}添加补充材料<input type="file" aria-label="上传沟通补充材料" accept=".docx,.pdf,.txt,.md" disabled={busy||working} onChange={e=>{void upload(e.target.files?.[0]);e.target.value=''}}/></label>}
 <p className="muted small">DOCX、PDF、TXT / Markdown · 单份不超过 10 MB。扫描 PDF 可供律师下载核对。</p>{error&&<p className="error" role="alert">{error}</p>}</section>;
}
