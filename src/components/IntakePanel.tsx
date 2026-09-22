import {transactionFieldLabel} from '@/lib/transaction-state';
import {intakeIsCurrent} from '@/lib/intake-state';
import type {Contract} from '@/lib/types';
import {PLAYBOOKS} from '@/lib/contract-library/playbooks';
export function IntakePanel({contract,busy,onConfirm,onControl,onSuggestion,onAssist}:{contract:Contract;busy:boolean;onAssist:()=>void;onConfirm:(id:string)=>void;onControl:(action:'retry'|'cancel')=>void;onSuggestion:(text:string)=>void}){
 const i=contract.workflow?.intake,j=contract.workflow?.job,p=i&&PLAYBOOKS[i.templateId];
 const current=intakeIsCurrent(contract);
 const active=j&&['running','pending'].includes(j.status);
 return <div className="intake-panel">
 {!!i?.deferredFields?.length&&<button className="secondary" disabled={busy||!!active} onClick={onAssist}>请律师协助确认未定约定</button>}
 {i?.businessProposals?.map(proposal=><section className="context-section" key={proposal.id}><strong>可选的商业安排 · 尚未采用</strong><p>{proposal.value}</p><button className="secondary" disabled={busy||!!active||!current} onClick={()=>onSuggestion(`采用建议：${proposal.value}`)}>采用这个建议</button><p>也可以直接告诉我你的修改。</p></section>)}
 {i&&p&&<details open={!active&&!i.missing.length&&!i.conflicts.length&&!i.confirmedAt}><summary>这次合作的交易摘要{i.missing.length?` · 还需补充 ${i.missing.length} 项`:''}</summary><dl>{Object.entries(i.facts).map(([id,f])=><div key={id}><dt>{transactionFieldLabel(i,id)}</dt><dd>{f.value}</dd></div>)}</dl>{!i.policyVersion&&!i.confirmedAt&&Object.keys(i.suggestions||{}).length>0&&<section><h3>建议条款 · 等你确认</h3><p>以下是系统提供的起草建议，不代表双方已约定。可直接在对话中修改；点击生成时一并确认。</p><dl>{p.fields.filter(f=>i.suggestions?.[f.id]).map(f=><div key={f.id}><dt>{f.label}</dt><dd>{i.suggestions![f.id]}</dd></div>)}</dl></section>}{!!i.deferredFields?.length&&<p>尚未确定：{i.deferredFields.map(id=>transactionFieldLabel(i,id)).join('、')}。这些事项已保留供后续沟通，不会被当作已确认约定。</p>}{i.conflicts.length>0&&<p className="error">{i.conflicts.join('；')}</p>}{i.missing.length>0&&<p>还需确认：{i.missing.map(id=>transactionFieldLabel(i,id)).join('、')}。可以在对话中补充。</p>}{!current&&<p role="status">有新信息尚未整理完成，旧摘要暂不能确认。请重试处理或继续补充。</p>}{current&&!i.missing.length&&!i.conflicts.length&&!i.confirmedAt&&<><p>专业条款由系统按适用规则起草，后续由律师审核，不需要你逐项选择。</p><p>请核对上述约定，确认后生成合同；需要调整可直接继续对话。</p><button className="primary" disabled={busy||!!active} onClick={()=>onConfirm(i.summaryId)}>按这些约定起草</button></>}{i.confirmedAt&&<p>交易信息已于 {new Date(i.confirmedAt).toLocaleString('zh-CN')} 确认。</p>}</details>}
 </div>;
}
