import type {ContractContent,Intake} from './types';
import type {ContractParty,ContractPart,DocumentBlock,Participant} from './contract-document-schema';
export type {ContractParty,ContractPart,DocumentBlock,Participant} from './contract-document-schema';

/** One canonical readable body is used by checks, previews and Word. */
export function blocksText(blocks:DocumentBlock[]):string{return blocks.map(b=>b.kind==='table'?[b.columns.join('｜'),...b.rows.map(r=>r.join('｜'))].join('\n'):b.kind==='list'?b.items.map((t,i)=>`${i+1}. ${t}`).join('\n'):b.text).join('\n\n');}
export function partText(part:ContractPart){return part.blocks?.length?blocksText(part.blocks):part.content;}
export function normalizeParts<T extends ContractContent>(c:T):T{
 for(const p of [...c.sections,...c.attachments||[]])if(p.blocks?.length)p.content=blocksText(p.blocks);
 return c;
}
export function visibleContractText(c:ContractContent){return [c.title,...c.parties.map(p=>`${p.role}：${p.name}`),...c.sections.flatMap(p=>[p.title,partText(p)]),...(c.attachments||[]).flatMap(p=>[p.title,partText(p)]),c.signing].filter(Boolean).join('\n\n');}

const compact=(s:string)=>s.replace(/\s/g,'');
/** Scope administrative evidence to its owner, including legacy combined contact facts. */
function partyEvidence(c:ContractContent,p:ContractParty){
 const participants=c.confirmation?.participants||[];
 const factId=participants.find(x=>x.role===p.role&&x.name===p.name)?.factId||Object.entries(c.confirmation?.facts||{}).find(([id,f])=>/^party[A-T]$/.test(id)&&compact(f.value).includes(compact(p.name)))?.[0];
 const aliases=c.parties.flatMap(x=>[x.role,x.name]).sort((a,b)=>b.length-a.length);
 const escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 const boundary=new RegExp('(?='+aliases.map(escape).join('|')+')','g');
 const own=[p.role,p.name];
 const other=c.parties.filter(x=>x!==p).flatMap(x=>[x.role,x.name]);
 const parts:string[]=[];
 for(const [id,f] of Object.entries(c.confirmation?.facts||{})){
  const text=compact(f.value),scoped=!!factId&&(id===factId||id.startsWith(factId+'_'));
  // An explicitly different owner's field cannot be reused, even if it names this party.
  if(/^party[A-T](?:_|$)/.test(id)&&!scoped)continue;
  for(const segment of text.split(boundary)){
   if(other.some(a=>segment.startsWith(compact(a))))continue;
   if(scoped||own.some(a=>segment.startsWith(compact(a))))parts.push(segment);
  }
 }
 return parts;
}
export function documentStructureProblems(c:ContractContent):string[]{
 const errors:string[]=[];
 for(const p of [...c.sections,...c.attachments||[]]){
  if(p.blocks?.length&&p.content!==blocksText(p.blocks))errors.push(`《${p.title}》结构化内容与核对正文不一致`);
  let parentHeading=false;
  for(const b of p.blocks||[]){
   if(b.kind==='table'&&b.rows.some(r=>r.length!==b.columns.length))errors.push(`《${p.title}》表格列数不一致`);
   if(b.kind==='heading'){if(b.level===2)parentHeading=true;else if(!parentHeading)errors.push(`《${p.title}》三级标题缺少二级父标题`);}
  }
 }
 if(c.parties.length<2||c.parties.length>20||c.parties.some(p=>!p.name.trim()))errors.push('合同参与方名称不完整');
 if(new Set(c.parties.map(p=>p.role.trim())).size!==c.parties.length)errors.push('参与方角色重复，请分别标明');
 const participants=c.confirmation?.participants||[];
 for(const p of participants)if(!c.parties.some(d=>d.name===p.name&&d.role===p.role))errors.push(`缺少已确认的参与方：${p.role} ${p.name}`);
 if(participants.length&&c.parties.some(p=>!participants.some(d=>d.name===p.name&&d.role===p.role)))errors.push('草稿增加或更改了未确认的参与方');
 // New structured signing fields must be grounded; old versions remain readable.
 if(c.documentProfile==='cn-contract-v2'&&c.confirmation){
  const evidence=compact(Object.values(c.confirmation.facts).map(f=>f.value).join('\n'));
  for(const p of c.parties){
   const owned=partyEvidence(c,p);
   const factId=participants.find(x=>x.role===p.role&&x.name===p.name)?.factId||Object.entries(c.confirmation.facts).find(([id,f])=>/^party[A-T]$/.test(id)&&compact(f.value).includes(compact(p.name)))?.[0];
   for(const key of ['registrationId','address','contactName','phone','email','legalRepresentative','authorizedRepresentative','signatureMethod'] as const){
    const known=factId&&c.confirmation.facts[factId+'_'+key]?.value;
    if(known&&!/不确定|不知道|未定|未约定|不需要|无需|暂不|没有决定/.test(known)&&!p[key])errors.push(`${p.role}已确认的${PARTY_LABELS[key]||'签署方式'}没有写入对应主体字段，不得遗漏`);
   }
   for(const key of ['name','registrationId','address','contactName','phone','email','legalRepresentative','authorizedRepresentative'] as const){
    const value=p[key];if(value&&!(key==='name'?evidence.includes(compact(value)):owned.some(s=>s.includes(compact(value)))))errors.push(`${p.role}的${PARTY_LABELS[key]||key}缺少用户依据或依据属于其他参与方`);
   }
   if(p.details?.trim()&&!p.details.split(/[。；;\n]/).filter(s=>s.trim()).every(s=>owned.some(e=>e.includes(compact(s)))))errors.push(`${p.role}的其他主体说明缺少归属于该方的用户依据，请使用独立主体字段`);
   if(p.signatureMethod){const patterns={signature:/签名|签字|电子签/,seal:/盖章|用印/,signature_and_seal:/签[名字].{0,6}(?:并|和|同时).{0,6}盖章|签[名字]盖章/};if(!owned.some(s=>patterns[p.signatureMethod!].test(s)&&!/(?:不|无须|无需|未约定).{0,6}(?:签字|签名|盖章|用印)/.test(s)))errors.push(`${p.role}的签署方式缺少用户依据或依据属于其他参与方`);}
  }
  for(const [id,fact] of Object.entries(c.confirmation.facts))if(/^party[A-T]$/.test(id)&&!c.parties.some(p=>compact(fact.value).includes(compact(p.name))))errors.push(`参与方事实${id}未对应到合同主体，请核对名称与角色`);
  if(c.signing&& !evidence.includes(compact(c.signing)))errors.push('签署说明缺少用户依据');
 }
 return errors;
}
export const PARTY_LABELS:Record<string,string>={name:'主体名称',subjectType:'主体类型',registrationId:'主体证件或登记号码',address:'住所或联系地址',contactName:'联系人',phone:'联系电话',email:'电子邮箱',legalRepresentative:'法定代表人',authorizedRepresentative:'授权签署人'};

/** This checklist never blocks draft download or lawyer handoff and is not legal clearance. */
export function signingChecklist(c:ContractContent){return c.parties.map(p=>({role:p.role,name:p.name,items:[
 ...(!p.subjectType||p.subjectType==='unknown'?['确认是企业、个人还是其他组织']:[]),
 ...(!p.address?['补充住所或联系地址']:[]),
 ...(!p.phone&&!p.email?['补充有效联系方式']:[]),
 ...(p.subjectType==='organization'&&!p.registrationId?['核对主体登记信息']:[]),
 ...(p.subjectType==='organization'&&!p.legalRepresentative&&!p.authorizedRepresentative?['确认实际签署人及授权']:[]),
 ...(p.authorizedRepresentative?['由律师核对代理授权']:[]),
 ]}));}
export function participantProblems(participants:Participant[],facts:Intake['facts']){
 const problems:string[]=[];
 for(const p of participants)if(!facts[p.factId]||!compact(facts[p.factId].value).includes(compact(p.name)))problems.push(`${p.role}名称必须来自${p.factId}的用户原文`);
 if(new Set(participants.map(p=>p.role)).size!==participants.length||new Set(participants.map(p=>p.factId)).size!==participants.length)problems.push('每个参与方应使用独立角色和事实字段');
 return problems;
}
