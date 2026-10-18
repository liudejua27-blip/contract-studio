import {z} from 'zod';
import type {ContractContent,Intake} from './types';
import type {ContractPatch} from './contract-patch';
import {documentBody,sha256} from './skill-audit';
import {changedFactIds,referenceId} from './transaction-relations';

export const clauseLinkSchema=z.object({
 target:z.enum(['section','attachment']),index:z.number().int().min(0),
 factIds:z.array(referenceId).max(30).default([]),relationIds:z.array(referenceId).max(60).default([]),
 quote:z.string().trim().min(1).max(1500).describe('对应位置可逐字定位的正文原句；索引指向最终成稿'),
}).refine(link=>link.factIds.length+link.relationIds.length>0,'关联至少一个事实或交易关系');
export const clauseLinksSchema=z.array(clauseLinkSchema).max(200).describe('事实/交易关系在正文和真实附件中的落点；专业通用条款无需硬凑关联');
export type ClauseLink=z.infer<typeof clauseLinkSchema>;
export type ClauseMap={version:1;contentSha256:string;links:ClauseLink[]};
type Location={target:'section'|'attachment';index:number};
export type RevisionPlan={
 version:1;baseSha256:string;changedFacts:string[];changedRelations:string[];affectedRelations:string[];
 intentChanged:boolean;participantsChanged:boolean;reviewAll:boolean;unmappedFacts:string[];reasons:string[];
 candidates:(Location&{title:string;factIds:string[];relationIds:string[]})[];
};
export type RevisionRecord={plan:RevisionPlan;changes:{target:Location['target'];sourceIndex?:number;resultIndex?:number;op:'replace'|'remove'|'append';reason:string}[];outcomes:{target:Location['target'];sourceIndex:number;resultIndex?:number;action:'replace'|'remove'|'unchanged'}[];headerReason?:string};
const parts=(c:ContractContent,target:Location['target'])=>target==='section'?c.sections:c.attachments||[];
const stable=(value:unknown):string=>JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);

export function validateClauseLinks(content:ContractContent,intake:Intake,links:ClauseLink[]){
 const relationIds=new Set(intake.relations?.map(r=>r.id));
 for(const link of links){
  const part=parts(content,link.target)[link.index];
  if(!part||!part.content.includes(link.quote))throw new Error(`条款关联无法在 ${link.target}[${link.index}] 定位原句，请使用最终正文位置和文字`);
  if(link.factIds.some(id=>!intake.facts[id])||link.relationIds.some(id=>!relationIds.has(id)))throw new Error('条款关联引用不存在或已撤回的事实/交易关系');
 }
}
export async function sealClauseMap(content:ContractContent,intake:Intake,links:ClauseLink[]){
 validateClauseLinks(content,intake,links);
 content.clauseMap={version:1,contentSha256:await sha256(documentBody(content)),links:structuredClone(links)};
}

/** A conservative review aid, not a semantic coverage certificate or a restriction on valid edits. */
export async function planContractRevision(base:ContractContent,current:Intake):Promise<RevisionPlan>{
 const previous=base.confirmation,baseSha256=await sha256(documentBody(base));
 const changedFacts=changedFactIds(previous,current),changed=new Set(changedFacts);
 const before=new Map(previous?.relations?.map(r=>[r.id,r])),after=new Map(current.relations?.map(r=>[r.id,r]));
 const changedRelations=[...new Set([...before.keys(),...after.keys()])].filter(id=>stable(before.get(id))!==stable(after.get(id)));
 const graph=[...before.values(),...after.values()],affected=new Set(changedRelations);
 for(const r of graph)if(r.factIds.some(id=>changed.has(id)))affected.add(r.id);
 // Include both prerequisites and dependents: a change can affect settlement and its delivery condition.
 let added=true;while(added){added=false;for(const r of graph)if(affected.has(r.id)||r.dependsOn.some(id=>affected.has(id)))for(const id of [r.id,...r.dependsOn])if(!affected.has(id)){affected.add(id);added=true;}}
 const usable=!!base.clauseMap&&base.clauseMap.contentSha256===baseSha256;
 const links=usable?base.clauseMap!.links:[],locations=new Map<string,RevisionPlan['candidates'][number]>();
 for(const link of links)if(link.factIds.some(id=>changed.has(id))||link.relationIds.some(id=>affected.has(id))){
  const part=parts(base,link.target)[link.index];if(!part)continue;
  const key=link.target+':'+link.index,old=locations.get(key);
  locations.set(key,{target:link.target,index:link.index,title:part.title,factIds:[...new Set([...old?.factIds||[],...link.factIds])],relationIds:[...new Set([...old?.relationIds||[],...link.relationIds])]});
 }
 const unmappedFacts=changedFacts.filter(id=>!links.some(l=>l.factIds.includes(id)||l.relationIds.some(rid=>before.get(rid)?.factIds.includes(id))));
 const intentChanged=stable(previous?.intent)!==stable(current.intent),participantsChanged=stable(previous?.participants)!==stable(current.participants)||changedFacts.some(id=>/^party[A-T](?:_|$)/.test(id));
 const reasons=[...(!previous?['原稿没有确认记录']:[]),...(!usable?['原稿缺少有效条款关联']:[]),...(unmappedFacts.length?['变化事实尚无完整落点']:[]),...(intentChanged?['核心诉求或立场变化']:[]),...(participantsChanged?['参与方信息或角色变化']:[]),...(current.relationReview?.length?['部分交易关系需要按新事实重新理解']:[]),...(changedRelations.some(id=>!links.some(l=>l.relationIds.includes(id)))?['变化关系没有原稿落点']:[])];
 return {version:1,baseSha256,changedFacts,changedRelations,affectedRelations:[...affected],intentChanged,participantsChanged,reviewAll:!!reasons.length,unmappedFacts,reasons,candidates:[...locations.values()]};
}

/** Keep links only for untouched parts, rebase their positions, then merge newly declared final positions. */
export function rebaseClauseLinks(base:ContractContent,intake:Intake,patch:ContractPatch,baseSha256:string):ClauseLink[]{
 const changed=new Set(changedFactIds(base.confirmation,intake));
 const previousRelations=new Map(base.confirmation?.relations?.map(r=>[r.id,r]));
 const currentRelations=new Map(intake.relations?.map(r=>[r.id,r]));
 const inherited=(base.clauseMap?.contentSha256===baseSha256?base.clauseMap.links:[]).flatMap(link=>{
  const edits=patch.changes.filter(c=>c.target===link.target&&c.op!=='append');
  if(edits.some(c=>c.op!=='append'&&c.index===link.index))return [];
  const factIds=link.factIds.filter(id=>!!intake.facts[id]&&!changed.has(id));
  const relationIds=link.relationIds.filter(id=>currentRelations.has(id)&&!currentRelations.get(id)!.factIds.some(f=>changed.has(f))&&stable(previousRelations.get(id))===stable(currentRelations.get(id)));
  if(!factIds.length&&!relationIds.length)return [];
  const shift=edits.filter(c=>c.op==='remove'&&c.index<link.index).length;
  return [{...link,index:link.index-shift,factIds,relationIds}];
 });
 return [...new Map([...inherited,...patch.clauseLinks||[]].map(link=>[stable(link),structuredClone(link)])).values()];
}

export function revisionRecord(plan:RevisionPlan,patch:ContractPatch,base:ContractContent):RevisionRecord{
 const appended={section:0,attachment:0};
 const finalIndex=(target:Location['target'],index:number)=>index-patch.changes.filter(e=>e.target===target&&e.op==='remove'&&e.index<index).length;
 return {plan,changes:patch.changes.map(c=>({target:c.target,...(c.op==='append'?{resultIndex:parts(base,c.target).length-patch.changes.filter(e=>e.target===c.target&&e.op==='remove').length+appended[c.target]++}:{sourceIndex:c.index,...(c.op==='replace'?{resultIndex:finalIndex(c.target,c.index)}:{})}),op:c.op,reason:c.reason})),outcomes:plan.candidates.map(c=>{
  const edit=patch.changes.find(e=>e.target===c.target&&e.op!=='append'&&e.index===c.index);
  return {target:c.target,sourceIndex:c.index,...(edit?.op==='remove'?{}:{resultIndex:finalIndex(c.target,c.index)}),action:edit?.op==='remove'?'remove':edit?.op==='replace'?'replace':'unchanged'};
 }),...(patch.header?{headerReason:patch.header.reason}:{})};
}
