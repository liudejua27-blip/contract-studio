import type {Contract} from '@/lib/types';
import {PLAYBOOKS} from '@/lib/contract-library/playbooks';
export function IntakePanel({contract,busy,onConfirm,onControl}:{contract:Contract;busy:boolean;onConfirm:(id:string)=>void;onControl:(action:'retry'|'cancel')=>void}){
 const i=contract.workflow?.intake,j=contract.workflow?.job,p=i&&PLAYBOOKS[i.templateId];
 const active=j&&['running','pending'].includes(j.status);
 return <div className="intake-panel">
 {j&&<div className="task-status" role="status" aria-live="polite">{active?<><strong>{{understand:'正在整理你提供的信息',generate:'正在起草合同条款',verify:'正在核对约定与合同的一致性',export:'正在检查并保存 Word'}[j.phase]}</strong><p>信息已保存，刷新页面可恢复任务。若处理失败，会显示重试入口。</p><button className="text-button" onClick={()=>onControl('cancel')}>取消本次处理</button></>:j.status==='failed'?<><strong>本次处理未完成</strong><p>{j.error}</p><button className="secondary" disabled={busy} onClick={()=>onControl('retry')}>重试此任务</button></>:j.status==='cancelled'?<p>本次处理已取消，已输入的信息仍然保留。</p>:null}</div>}
 {i&&p&&<details open={!i.missing.length&&!i.conflicts.length&&!i.confirmedAt}><summary>已整理 {Object.keys(i.facts).length} 项约定{i.missing.length?` · 还需补充 ${i.missing.length} 项`:''}</summary><dl>{p.fields.filter(f=>i.facts[f.id]).map(f=><div key={f.id}><dt>{f.label}</dt><dd>{i.facts[f.id].value}</dd></div>)}</dl>{i.conflicts.length>0&&<p className="error">{i.conflicts.join('；')}</p>}{i.missing.length>0&&<p>还需确认：{p.fields.filter(f=>i.missing.includes(f.id)).map(f=>f.label).join('、')}。可以在对话中补充。</p>}{!i.missing.length&&!i.conflicts.length&&!i.confirmedAt&&<><p>共同条款：变更须双方书面确认；通知以实际到达为准；合同经双方签字盖章后生效。</p><p>请核对上述约定，确认后生成合同；需要调整可直接继续对话。</p><button className="primary" disabled={busy||!!active} onClick={()=>onConfirm(i.summaryId)}>确认约定并生成 Word</button></>}{i.confirmedAt&&<p>以上约定已于 {new Date(i.confirmedAt).toLocaleString('zh-CN')} 确认。</p>}</details>}
 </div>;
}
