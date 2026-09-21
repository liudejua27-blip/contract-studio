import {CORE_FIELDS} from './guided-policy';
import type {Intake,IntakeFact} from '../types';
import {PLAYBOOKS} from './playbooks';
// These are proposed terms, never silently treated as user-provided facts.
export const TERM_SUGGESTIONS:Record<string,string>={
 acceptance:'按本合同所附功能、成果或商品清单逐项验收。发现不符合约定的，买方或委托方应说明具体问题，承接方或卖方应整改后提交复验；沉默不视为验收通过。',
 breach:'一方不履行约定，另一方应通知其补救；经催告后仍不履行、致使合同目的不能实现的，守约方可依法解除合同。已履行部分据实结算，未履行部分退还对应款项，损失赔偿依法处理。不预设固定违约金或责任上限。',
 disputes:'适用中国大陆法律。争议先由双方协商，协商不成，向依法有管辖权的人民法院起诉。'
};
export function requiredFields(templateId:string){return (PLAYBOOKS[templateId]?.fields||[]).filter(f=>(CORE_FIELDS[templateId]||[]).includes(f.id));}
export function suggestedTerms(i:Intake):Record<string,IntakeFact>{return Object.fromEntries(Object.entries(i.suggestions||{}).map(([k,value])=>[k,{value,quote:'用户在约定摘要中确认的系统建议'}]));}
export function acceptSuggestions(i:Intake){const next=structuredClone(i);if(i.policyVersion)return next;next.facts={...suggestedTerms(i),...next.facts};return next;}

/** Explicit installment edits must not keep a stale model extraction. */
export function paymentEditUnresolved(latest:string,value:string|undefined){
 const match=latest.match(/([两二三四五六七八九十1-9])次(?:付款|支付)/);if(!match)return false;
 const n=Number(match[1])||({'两':2,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10} as Record<string,number>)[match[1]];
 if(/(?:比例|金额|节点).{0,5}(?:未定|没想好|未确定|不知道|不确定)/.test(latest))return true;
 if(!value)return true;
 const ratios=[...value.matchAll(/\d+(?:\.\d+)?\s*[%％]/g)].length;
 const amounts=[...value.matchAll(/\d+(?:\.\d+)?\s*(?:万)?元/g)].length;
 return ratios!==n&&amounts!==n;
}

/** Preserve an explicit standalone installment schedule verbatim, without model paraphrasing. */
export function explicitPaymentSchedule(text:string):IntakeFact|undefined {
 if(text.length>2500||/(?:改成|改为).{0,12}(?:未定|不确定|没想好)|不要|取消|例如|假设|是否|可以吗|怎么办|[？?]/.test(text))return;
 const lines=text.trim().split(/[；;\n]+/).map(s=>s.trim()).filter(Boolean);
 if(lines.length<2||lines.length>10)return;
 if(!lines.every(s=>/(?:支付|付款|再付|先付)/.test(s)&&/\d[\d,，.]*\s*(?:[%％]|元)/.test(s)&&/(?:后|前|时|首款|尾款|首期|尾期)/.test(s)))return;
 return {value:text.trim(),quote:text.trim()};
}
