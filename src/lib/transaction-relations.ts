import {z} from 'zod';
import type {Intake} from './types';

export const referenceId=z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/).max(80);
export const relationSchema=z.object({
 id:referenceId.describe('同一义务沿用稳定 ID，后续按 ID 更新，不按措辞重新编号'),
 from:z.string().regex(/^party[A-T]$/).describe('履行方的 participant.factId'),
 to:z.array(z.string().regex(/^party[A-T]$/)).min(1).max(19).describe('接受履行或享有权利的一方或多方'),
 action:z.string().trim().min(1).max(500).describe('谁向谁提供什么；保留否定、范围和例外，不新增承诺'),
 factIds:z.array(referenceId).min(1).max(30).describe('支持这项关系的当前事实 ID，包含节点和条件的来源'),
 quote:z.string().trim().min(1).max(4000).describe('逐字引用所关联事实的原话'),
 condition:z.string().trim().max(500).optional().describe('已有履行条件；未约定时省略'),
 dependsOn:z.array(referenceId).max(30).default([]).describe('有事实依据的前置履行关系 ID；仅并行发生不表示依赖'),
});
export type TransactionRelation=z.infer<typeof relationSchema>;
export const relationUpdateSchema=z.object({
 upsert:z.array(relationSchema).max(60).default([]),
 remove:z.array(z.object({id:referenceId,quote:z.string().trim().min(1).max(4000)})).max(60).default([]),
}).describe('交易关系的增量整理；省略保留未变化关系，撤回引用本轮原话。结构整理不增加用户必答问题');

export function changedFactIds(previous:Intake|undefined,current:Intake):string[]{
 return [...new Set([...Object.keys(previous?.facts||{}),...Object.keys(current.facts)])].filter(id=>previous?.facts[id]?.value!==current.facts[id]?.value);
}

/** Relationships are a sourced interpretation, never an additional source of commercial facts. */
export function mergeRelations(previous:Intake|undefined,current:Intake,update:z.infer<typeof relationUpdateSchema>|undefined,latest:string){
 const relations=new Map((previous?.relations||[]).map(r=>[r.id,structuredClone(r)]));
 const pending=new Set(previous?.relationReview||[]),changed=new Set(changedFactIds(previous,current));
 const partyIds=new Set(current.participants?.map(p=>p.factId)||['partyA','partyB',...Object.keys(current.facts).filter(id=>/^party[A-T]$/.test(id))]);
 const validParties=(r:TransactionRelation)=>[r.from,...r.to].every(id=>partyIds.has(id));
 const changedRoles=new Set(current.participants?.filter(p=>{const old=previous?.participants?.find(v=>v.factId===p.factId);return old&&old.role!==p.role;}).map(p=>p.factId));
 const edits=update?.upsert||[],removed=update?.remove||[],seen=new Set<string>();
 for(const r of [...edits,...removed]){if(seen.has(r.id))throw new Error('交易关系 ID 重复更新：'+r.id);seen.add(r.id);}
 // Do not silently keep a now-stale interpretation when its source or participating party changes.
 for(const [id,r] of relations)if(!validParties(r)||[r.from,...r.to].some(id=>changedRoles.has(id))||r.factIds.some(f=>changed.has(f)||!current.facts[f])){relations.delete(id);pending.add(id);}
 for(const r of removed){
  if(!latest.includes(r.quote))throw new Error('撤回交易关系须引用本轮原话：'+r.id);
  relations.delete(r.id);pending.delete(r.id);
 }
 for(const r of edits){
  if(!validParties(r))throw new Error('交易关系引用不存在的参与方：'+r.id);
  if(r.to.includes(r.from)||new Set(r.to).size!==r.to.length)throw new Error('交易关系的履行方与接受方重复：'+r.id);
  if(r.factIds.some(id=>!current.facts[id]))throw new Error('交易关系引用不存在或已撤回的事实：'+r.id);
  if(!r.factIds.some(id=>{const f=current.facts[id];return [f.quote,...f.evidence||[]].some(q=>q.includes(r.quote));}))throw new Error('交易关系引用须来自关联的当前事实原话：'+r.id);
  relations.set(r.id,structuredClone(r));pending.delete(r.id);
 }
 // Invalidated prerequisites invalidate their old dependents, including across several steps.
 let removedDependency=true;
 while(removedDependency){removedDependency=false;for(const [id,r] of relations)if(r.dependsOn.some(d=>!relations.has(d))&&!edits.some(e=>e.id===id)){relations.delete(id);pending.add(id);removedDependency=true;}}
 for(const r of relations.values())if(r.dependsOn.some(id=>id===r.id||!relations.has(id)))throw new Error('交易关系引用不存在的前置履行或自身：'+r.id);
 return {relations:[...relations.values()],relationReview:[...pending]};
}

export function transactionStructure(intake:Intake){
 return {participants:intake.participants||[],relations:intake.relations||[],needsReinterpretation:intake.relationReview||[]};
}
