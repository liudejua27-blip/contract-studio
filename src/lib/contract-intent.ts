import {z} from 'zod';
import type {Contract,Intake,Version} from './types';

const statement=(max:number)=>z.object({
 value:z.string().trim().max(max).describe('概括用户明确表达的内容；用户明确撤回时填空字符串。'),
 quote:z.string().trim().min(1).max(4000).describe('逐字引用用户原话，说明来源或本次更正、撤回。'),
});
export const intentUpdateSchema=z.object({goal:statement(3000).optional(),stance:statement(100).optional()})
 .describe('用户的核心诉求与代表立场，区别于双方已谈妥的事实。只更新有依据的项目，未提供则省略，不作为起草必填项。');
export type ContractIntent=z.infer<typeof intentUpdateSchema>;

/** Preserve unmentioned intent; changed/withdrawn intent must come from the latest user turn. */
export function mergeIntent(previous:ContractIntent|undefined,update:ContractIntent|undefined,userTexts:string[]):ContractIntent|undefined{
 if(!update)return previous?structuredClone(previous):undefined;
 const next=structuredClone(previous||{}),latest=userTexts.at(-1)||'';
 for(const key of ['goal','stance'] as const){
  const value=update[key];if(!value)continue;
  const unchanged=previous?.[key]?.value===value.value&&previous[key]?.quote===value.quote;
  const sources=previous?.[key]||!value.value?[latest]:userTexts;
  if(!unchanged&&!sources.some(text=>text.includes(value.quote)))throw new Error(`${key}的诉求或立场缺少用户原话依据；更正和撤回须引用本轮原话，请内部核对，不要让用户重说。`);
  // Keep an empty, sourced tombstone so an older goal cannot be restored on a later turn.
  next[key]=value;
 }
 return next;
}

export function intentValues(intake?:Intake){return {concerns:intake?.intent?.goal?.value||'',stance:intake?.intent?.stance?.value||''};}

/** The selected Word's snapshot owns its brief; never silently borrow another version's intent. */
export function reviewBrief(contract:Contract,version:Version|undefined,consultation:boolean){
 return intentValues(consultation?contract.workflow?.intake:version?.content?.confirmation);
}
