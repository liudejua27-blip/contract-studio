import {TRANSACTION_QUESTIONS} from '../contract-questions';
import {unresolvedBusiness,businessCheckProblems} from '../business-checks';
import {GENERAL_CORE,MODULES,selectedModules} from './general';
import {EXTENDED} from './extended';
import type {Intake} from '../types';
import {PROFESSIONAL_DEFAULTS} from '../standard-terms';
export {PROFESSIONAL_DEFAULTS} from '../standard-terms';
export const GUIDED_POLICY_VERSION='guided-2026.09.22.3';
export const BUSINESS_FIELDS=[
 {id:'collection',label:'顾客付款收取方',question:'顾客付的钱先收进哪一方的账户？'},
 {id:'settlement',label:'分成款支付路径',question:'对账后，由哪一方向哪一方支付分成款？'},
 {id:'revenueAdjustments',label:'退款与折扣口径',question:'分成按打折后实际收到的钱算吗？退款要从收入里扣掉吗？'},
];
export const CORE_FIELDS:Record<string,string[]>={general:GENERAL_CORE,software:['partyA','partyB','scope','price','payment','term','deliverables'],service:['partyA','partyB','scope','price','payment','term','deliverables'],purchase:['partyA','partyB','goods','price','payment','term','delivery']};
for(const [id,p] of Object.entries(EXTENDED))CORE_FIELDS[id]=['partyA','partyB',...p.facts.map(f=>f[0])];
export const PLAIN_QUESTIONS=TRANSACTION_QUESTIONS;
const SCENE_DEFAULTS:Record<string,Record<string,string>>={
 software:{ip:'甲方可为本合同约定的业务目的使用交付成果；源码及修改需求以交付清单明确的约定为准。已有代码及第三方组件依其权利和许可证使用，本合同不因交付行为自动转让全部知识产权。',maintenance:'乙方应修复交付成果中不符合本合同约定的缺陷。新增功能不属于原工作范围，应经双方书面确认。项目资料和约定账号应随交付移交，双方依法保护业务数据。'},
 service:{rights:'委托方可为本次约定业务目的使用交付成果。提供方应保密所接触的非公开业务资料，并在履约结束后返还或依法处理，不因交付自动转让全部知识产权。'},
 purchase:{warranty:'商品不符合合同约定的，买方可以依法要求修理、更换、退货或其他适当补救，具体处理与商品问题相适应。'},
};
export function defaultsFor(i:Intake){return Object.fromEntries(Object.entries({...Object.fromEntries(Object.entries(PROFESSIONAL_DEFAULTS).filter(([id])=>id!=='ip'&&(i.templateId==='general'?!['tax','invoice','acceptance'].includes(id):i.templateId!=='nda'||!['tax','invoice','acceptance','breach'].includes(id)))),...SCENE_DEFAULTS[i.templateId],...EXTENDED[i.templateId]?.defaults,...Object.fromEntries((i.businessChecks||[]).filter(c=>c.status==='standard'&&!businessCheckProblems([c],i.facts,[]).length).map(c=>[c.defaultRule!,PROFESSIONAL_DEFAULTS[c.defaultRule!]]))}).filter(([id])=>!i.facts[id]&&!i.withdrawnFields?.includes(id)));}
export function effectiveTerms(i:Intake){return {...(i.policyVersion?i.defaults||{}:{}),...Object.fromEntries(Object.entries(i.facts).map(([k,v])=>[k,v.value]))};}
export function lawyerChecklist(i:Intake){return [...new Set([...(i.reviewNotes||[]),...Object.keys(i.defaults||{}).map(id=>`复核系统起草条款：${id}`),...(i.withdrawnFields||[]).map(id=>`用户撤回了 ${id}，不得沿用旧约定`)])];}

/** Legacy diagnostic only. Production intake uses transaction-state and model businessChecks. */
export function sceneQuestions(i:Intake):{fieldId:string;question:string}[]{
 const text=Object.values(i.facts).map(f=>f.value).join('；');
 const questions:{fieldId:string;question:string}[]=[];
 const answeredInOtherFacts={
  operations:/(?:负责|承担|由).{0,20}(?:运营|经营)|(?:运营|经营).{0,20}(?:负责|承担)/.test(text)&&/(?:供货|补货|供豆|采购).{0,20}(?:费用|成本)|(?:费用|成本).{0,20}(?:供货|补货|供豆|采购)/.test(text)&&/水电|场地费|运营费|经营费/.test(text),
  equipment:/(?:设备|机器|咖啡机).{0,12}(?:归|所有)|(?:所有权).{0,12}(?:归|属于)/.test(text)&&/维修|维护|保养/.test(text)&&/取回|返还|归还|收回/.test(text),
  revenue:/(?:收入|利润|实收).{0,40}(?:%|％|比例|分成)/.test(text)&&/每月|月底|每周|每季|每年|每日|按月|按季|结算周期/.test(text),
 };
 if(i.templateId==='general')for(const id of selectedModules(i)){const m=MODULES[id];if(!i.facts[m.field]&&!answeredInOtherFacts[id])questions.push({fieldId:m.field,question:m.question});}
 if(selectedModules(i).includes('revenue')){
  // Search the entire retained evidence, not a single field: users may answer in one sentence.
  const collecting=!!i.facts.collection||/(?:甲方|乙方|丙方|门店|平台|我们|对方).{0,12}(?:统一收款|收取顾客|收取货款|收款账户|代收)|(?:顾客|客户|消费者).{0,18}(?:付给|支付给|转给|打入)|(?:收入|货款|款项).{0,8}(?:进入|打入|汇入)|由.{1,15}(?:收款|收取)|(?:款|钱).{0,12}(?:由|归).{0,12}(?:收|保管)/.test(text);
  const settling=!!i.facts.settlement||/(?:甲方|乙方|丙方|门店|平台).{0,12}(?:支付给|转给|付给|转付|划给)|(?:各自|分别|直接).{0,8}(?:收取|收款|分账)|自动分账|向.{1,15}(?:支付|转账|转付|付清)|(?:结算|转账|划款).{0,8}给/.test(text);
  const consumer=/顾客|消费者|门店|零售|销售收入/.test(text);
  if(consumer&&!collecting)questions.push({fieldId:'collection',question:BUSINESS_FIELDS[0].question});
  if(!settling)questions.push({fieldId:'settlement',question:BUSINESS_FIELDS[1].question});
  const adjustments=i.facts.revenueAdjustments?.value||text;
  const refundsResolved=/退款|退货/.test(adjustments)&&/扣除|扣减|不扣|冲减|冲回|抵扣|承担|不计入|不影响|退回/.test(adjustments)&&!unresolvedBusiness.test(adjustments);
  const discountsResolved=/折扣|优惠|打折|实收|实际收到|原价/.test(adjustments);
  if(consumer&&!(refundsResolved&&discountsResolved))questions.push({fieldId:'revenueAdjustments',question:BUSINESS_FIELDS[2].question});
 }
 if(i.templateId==='software'&&!/源码|源代码/.test(i.facts.deliverables?.value||'')&&!i.facts.sourceDelivery)questions.push({fieldId:'sourceDelivery',question:'软件做完后，源代码需要一起交付吗？'});
 if(i.templateId==='software'&&/维护|运维|持续支持/.test(text)&&(!i.facts.maintenance||!/[天月年]|长期|持续到|截止|仅修复|不需要|不用/.test(i.facts.maintenance.value)))questions.push({fieldId:'maintenance',question:'上线后需要对方继续做哪些维护，持续多久？'});
 if(i.templateId==='purchase'&&/安装|调试/.test(text)&&(!i.facts.installation||!/(负责|由|包安装)/.test(i.facts.installation.value)||!/(含|免费|另付|费用|自理)/.test(i.facts.installation.value)))questions.push({fieldId:'installation',question:'安装和调试由谁负责，费用包含在总价里吗？'});
 if(i.templateId==='service'&&/拍摄|视频|广告|宣传/.test(text)&&(!i.facts.usage||!/(用于|用在|投放|发布|平台|抖音|小红书|内部|门店播放)/.test(i.facts.usage.value)))questions.push({fieldId:'usage',question:'做好的内容准备用在哪些地方？需要用于广告投放吗？'});
 // Valid semantic decisions take precedence over legacy scene heuristics.
 return questions.filter(q=>!i.businessChecks?.some(c=>c.fieldId===q.fieldId&&c.status==='answered'&&!businessCheckProblems([c],i.facts,[]).length));
}
