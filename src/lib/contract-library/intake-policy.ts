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
