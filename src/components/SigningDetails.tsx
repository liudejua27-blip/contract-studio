'use client';
import {useState} from 'react';
import type {ContractContent} from '@/lib/types';
import {signingChecklist,PARTY_LABELS} from '@/lib/contract-document';

export function SigningDetails({content,onSupplement,disabled=false}:{content:ContractContent;onSupplement?:(message:string)=>Promise<void>;disabled?:boolean}){
 const checklist=signingChecklist(content),[editing,setEditing]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState('');
 const missing=checklist.reduce((n,p)=>n+p.items.length,0);
 return <details className="signing-details"><summary>签署资料 · {missing?'签署前还需核对':'已记录，待律师核验'}</summary>
  <p>可先下载初稿并送审。以下资料在签署前核对，不代表主体或授权已经核验。</p>
  {checklist.map(p=><div key={p.role}><strong>{p.role} · {p.name}</strong><p>{p.items.length?p.items.join('；'):'已有基础资料，请律师核对原件与实际签署权限。'}</p></div>)}
  {onSupplement&&!editing&&<button className="secondary" disabled={disabled} onClick={()=>setEditing(true)}>补充已知资料</button>}
  {editing&&onSupplement&&<form onSubmit={async e=>{e.preventDefault();const data=new FormData(e.currentTarget);const lines:string[]=[];
   content.parties.forEach((p,i)=>{const entries=Array.from(data.entries()).filter(([key,value])=>key.startsWith(i+':')&&String(value).trim()).map(([key,value])=>`${PARTY_LABELS[key.split(':')[1]]}：${String(value).trim()}`);if(entries.length)lines.push(`${p.role}（${p.name}）：${entries.join('；')}`);});
   if(!lines.length){setError('填写你已经知道的资料即可，其余可以稍后补充。');return;}setSaving(true);setError('');
   try{await onSupplement('补充以下签署资料，其他交易约定保持不变，请整理后供我确认新版本：\n'+lines.join('\n'));setEditing(false);}catch(e){setError((e as Error).message);}finally{setSaving(false);}
  }}><p>仅提交本次填写的信息；资料将进入对话确认，已保存和已送审的版本不会被直接修改。</p>
   {content.parties.map((p,i)=><fieldset key={p.role} disabled={saving||disabled}><legend>{p.role} · {p.name}</legend>
    <label>主体类型<select name={i+':subjectType'} defaultValue=""><option value="">暂不补充</option><option value="企业或其他组织">企业或其他组织</option><option value="自然人">自然人</option></select></label>
    {['address','registrationId','contactName','phone','email','legalRepresentative','authorizedRepresentative'].map(key=><label key={key}>{PARTY_LABELS[key]}<input name={i+':'+key} maxLength={key==='address'?500:160} placeholder="已知时填写，可稍后补充"/></label>)}
   </fieldset>)}
   {error&&<p role="alert" className="error">{error}</p>}<div className="signing-actions"><button type="submit" className="primary" disabled={saving||disabled}>{saving?'正在保存…':'在对话中补充'}</button><button type="button" className="secondary" disabled={saving} onClick={()=>setEditing(false)}>收起</button></div>
  </form>}
 </details>;
}
