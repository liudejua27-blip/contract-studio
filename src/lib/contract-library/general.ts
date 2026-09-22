import type {Field} from './catalog';
import type {Intake} from '../types';
const field=(id:string,label:string,question:string):Field=>({id,label,question});
export const GENERAL_FIELDS:Field[]=[
 field('partyA','第一方名称与角色','第一方的完整名称是什么，在合作中负责什么？'),
 field('partyB','另一方名称与角色','另一方的完整名称是什么，在合作中负责什么？'),
 field('scope','合作事项','双方具体合作做什么，各自提供什么？'),
 field('exchange','费用与交换安排','双方怎么收费或分配收入、何时结算？如果没有费用，也请直接说明。'),
 field('term','合作期限','准备从什么时候开始，持续多久或到什么事情完成？'),
 field('equipment','设备安排','设备归谁，谁负责维护，合作结束后怎么处理？'),
 field('revenue','收入分配','按销售收入还是扣除哪些成本后分钱，双方各占多少、多久结算一次？'),
 field('operations','运营分工','日常经营、供货和费用分别由谁负责？'),
 field('deliverables','交付安排','需要交付哪些东西，怎样交给对方？'),
 field('specialTerms','其他约定','这次合作还有哪些特别约定？'),
];
export const GENERAL_CORE=['partyA','partyB','scope','exchange','term'];
export const MODULES={
 equipment:{title:'设备交付、使用与返还',field:'equipment',question:GENERAL_FIELDS[5].question,rule:'区分所有权与使用权；保留已确认的维护、损坏处理及返还安排，不因交付推断所有权转移。'},
 revenue:{title:'收入分配与结算核对',field:'revenue',question:GENERAL_FIELDS[6].question,rule:'明确分配口径、比例及结算周期；不得把销售收入写成利润，不预设成本扣除项目。'},
 operations:{title:'运营分工与费用承担',field:'operations',question:GENERAL_FIELDS[7].question,rule:'按实际分工记录供货、经营和费用，不新增保底收益、独家合作或免费维护。'},
} as const;
export type DraftingPlan={version:string;mode:'general'|'specialized';familyId?:string;ruleFamilies?:string[];modules:(keyof typeof MODULES)[];clauses:string[];rules:string[];reason:string};
export function selectedModules(i:Intake):(keyof typeof MODULES)[]{
 if(i.assessmentVersion==='transaction-v1'){
  // Modern plans follow the agent's sourced decisions; mentioning "没有分成" is not a revenue module.
  const active=(id:string)=>{const check=i.businessChecks?.find(c=>c.fieldId===id);return check?check.status!=='not_applicable':!!i.facts[id];};
  return (Object.keys(MODULES) as (keyof typeof MODULES)[]).filter(id=>active(id)||(id==='revenue'&&active('revenueAdjustments')));
 }
 const text=Object.values(i.facts).map(f=>f.value).join('；');
 const ids:(keyof typeof MODULES)[]=[];
 // Broad transaction evidence selects questions, never supplies their answers.
 if(/设备|机器|咖啡机|器材/.test(text)&&/放|提供|投放|使用|返还|归|维护/.test(text))ids.push('equipment');
 if(/分成|分红|分配收入|收入分配|利润分配/.test(text))ids.push('revenue');
 if(/运营|经营|补货|供货/.test(text))ids.push('operations');
 return ids;
}
export function draftingPlan(i:Intake,clauses:string[]):DraftingPlan{
 const modules=selectedModules(i);
 return {version:'transaction-2',mode:i.templateId==='general'?'general':'specialized',familyId:i.templateId==='general'?undefined:i.templateId,ruleFamilies:[...new Set([i.templateId,...i.ruleFamilies||[]])],modules,
 clauses:[...new Set([...clauses,...modules.map(id=>MODULES[id].title)])],rules:modules.map(id=>MODULES[id].rule),
 reason:'以已确认交易为依据独立组织条款。clauses仅为参考，可合并、改名或增删；多个适用专项规则按需增强，不限制特殊约定和实际附件。'};
}

/** Equivalent commercial evidence satisfies the same business question without duplicating facts. */
export function hasTransactionFact(facts:Intake['facts'],id:string){return !!facts[id]||(id==='exchange'&&(!!facts.revenue||!!facts.price&&!!facts.payment));}
