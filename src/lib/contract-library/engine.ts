import {CONTRACT_TEMPLATES,getTemplate,LIBRARY_VERSION,SOURCES,type ContractTemplate} from './catalog';
import type {ContractContent,Message} from '../types';
export type Finding={id:string;kind:'field'|'clause'|'risk';title:string;status:'REVIEW'|'UNKNOWN';message:string;evidence?:{location:string;quote:string}};
export type DraftingReport={templateId:string;templateName:string;templateVersion:string;ruleVersion:string;createdAt:string;reviewStatus:'pending_lawyer_review';jurisdiction:string;legalBasis:string;selection:'explicit'|'inferred'|'unclassified';sources:{name:string;url:string;license:string;version:string;use:string}[];findings:Finding[]};
const marker=/^【起草模板：([a-z-]+)@([\d.]+)】/;
export function selectedTemplate(messages:Message[]):string|undefined{for(const m of [...messages].reverse()){if(m.role!=='user')continue;const id=m.content.match(marker)?.[1];if(getTemplate(id))return id;}return undefined;}
export function annotateMessage(message:string,id?:string){return id?`【起草模板：${id}@${LIBRARY_VERSION}】\n${message}`:message;}
export function resolveTemplate(messages:Message[],prompt:string,explicit?:string):{template?:ContractTemplate;selection:DraftingReport['selection']}{
 const id=explicit||selectedTemplate(messages);if(id)return{template:getTemplate(id),selection:'explicit'};
 const text=[...messages.filter(m=>m.role==='user').map(m=>m.content),prompt].join('\n').toLowerCase();
 const matches=CONTRACT_TEMPLATES.map(t=>({t,score:Math.max(0,...[t.name,...t.aliases].filter(a=>text.includes(a.toLowerCase())).map(a=>a.length))})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score);
 // Multiple plausible categories need clarification, not an arbitrary rule set.
 if(!matches.length||matches.length>1&&matches[0].score===matches[1].score)return{selection:'unclassified'};
 return{template:matches[0].t,selection:'inferred'};
}
export function templatePrompt(template:ContractTemplate|undefined,selection:DraftingReport['selection']){
 if(!template)return '当前未选择或无法确定合同类型。先确认合同类型、适用地区与用户立场。若用户仍要求起草，可生成通用草稿，但必须将“合同类型与适用规则待确认”列入 missing，不声称已按专业分类审核。劳动、借贷、股权、建设工程、跨境等未覆盖类型须明确提示专项律师审查。';
 return `以下为版本化起草参考，不是律师审核结论。模板：${template.name}；版本：${template.version}；状态：待律师审定；选择方式：${selection==='explicit'?'用户选择':'根据需求推测，先确认是否匹配'}。适用范围：${template.jurisdiction}。参考依据：${template.legalBasis}。
必填信息（签署前应确认，可先生成带占位符草稿）：${template.fields.map(f=>`${f.label}：${f.question}`).join('\n')}
必备条款（是本产品起草清单，不表示缺少即无效；按交易适用性逐项写明）：${template.clauses.map(c=>`${c.title}：${c.text}`).join('\n')}
审查关注点：${template.risks.map(r=>`${r.title}：${r.instruction}`).join('\n')}
每轮仅追问最关键2-3项，保留已经确认的信息。生成时保留条款标题主题，用已确认事实填写占位符，尚未确认的标注[待补充]并列入missing。未确认的价款、期限、比例、管辖、授权及用户立场不得自行决定。不要照搬外国法、美国雇佣作品规则或任何固定市场数值。发现适用地区或业务范围不匹配，应说明并列入missing，不能宣称模板适用。不得声称已取得专业资格、完整法规检索或律师审定。`;
}
export function inspectDraft(content:ContractContent,template:ContractTemplate,reference:string,selection:DraftingReport['selection']):DraftingReport{
 const fragments=[{location:'签约主体',text:content.parties.map(p=>`${p.role}：${p.name} ${p.details||''}`).join('\n')},...content.sections.map((s,i)=>({location:`第${i+1}条 ${s.title}`,text:s.content})),{location:'签署信息',text:content.signing}];
 const evidence=(keywords:string[])=>{for(const f of fragments){for(const k of keywords){const n=f.text.indexOf(k);if(n>=0)return {location:f.location,quote:f.text.slice(Math.max(0,n-35),n+150)};} }return undefined;};
 const findings:Finding[]=template.fields.map(f=>{
  // Only explicitly labelled user answers count as located; no LLM assertions count as confirmed facts.
  const line=reference.split('\n').reverse().find(l=>l.startsWith(`${f.label}：`)||l.startsWith(`${f.label}:`));
  const value=line?.slice(f.label.length+1).trim();const known=!!value&&!/待补充|待确认|不确定|未知|未提供/.test(value);
  return{id:`field:${f.id}`,kind:'field',title:f.label,status:known?'REVIEW':'UNKNOWN',message:known?'已定位用户填写的信息，仍需核实主体、事实与一致性。':`未定位到明确填写的信息；自然语言对话可能已包含，请核对。${f.question}`,...(known?{evidence:{location:'用户提供的信息',quote:line!.slice(0,200)}}:{})};
 });
 for(const c of template.clauses){const e=evidence(c.keywords);findings.push({id:`clause:${c.id}`,kind:'clause',title:c.title,status:e?'REVIEW':'UNKNOWN',message:e?'定位到相关正文，须核对内容是否完整、适用且无矛盾；关键词不代表审查通过。':'未在正文定位到相关关键词，可能缺项或使用了不同表达，请人工核查。',...(e?{evidence:e}:{})});}
 for(const r of template.risks){const e=evidence(r.keywords);findings.push({id:`risk:${r.id}`,kind:'risk',title:r.title,status:e?'REVIEW':'UNKNOWN',message:r.instruction+(e?' 已定位相关文字，是否构成风险需结合上下文。':' 自动检查未能判定，不代表无风险。'),...(e?{evidence:e}:{})});}
 const e=evidence(['[待补充]','待确认','____','TBD']);findings.push({id:'risk:placeholders',kind:'risk',title:'签署前未决事项',status:'UNKNOWN',message:e||content.missing.length?'仍有未决信息，签署前须补齐。':'未发现标准占位符，但无法自动证明信息齐备。',...(e?{evidence:e}:{})});
 return{templateId:template.id,templateName:template.name,templateVersion:template.version,ruleVersion:LIBRARY_VERSION,createdAt:new Date().toISOString(),reviewStatus:'pending_lawyer_review',jurisdiction:template.jurisdiction,legalBasis:template.legalBasis,selection,sources:template.sourceIds.map(id=>({...SOURCES[id]})),findings};
}
export function blankTemplate(t:ContractTemplate):ContractContent{return{title:t.name,parties:[{role:'甲方',name:'[待补充]',details:'住所、联系人及签署授权：[待补充]'},{role:'乙方',name:'[待补充]',details:'住所、联系人及签署授权：[待补充]'}],sections:t.clauses.map(c=>({title:c.title,content:c.text})),signing:'甲方签署：[待补充]；乙方签署：[待补充]；日期及生效条件：[待补充]。',missing:t.fields.map(f=>f.label)};}
