import {GENERAL_CORE,MODULES,selectedModules} from './general';
import {EXTENDED} from './extended';
import type {Intake} from '../types';
export const GUIDED_POLICY_VERSION='guided-2026.09.21.2';
export const CORE_FIELDS:Record<string,string[]>={general:GENERAL_CORE,software:['partyA','partyB','scope','price','payment','term','deliverables'],service:['partyA','partyB','scope','price','payment','term','deliverables'],purchase:['partyA','partyB','goods','price','payment','term','delivery']};
for(const [id,p] of Object.entries(EXTENDED))CORE_FIELDS[id]=['partyA','partyB',...p.facts.map(f=>f[0])];
export const PLAIN_QUESTIONS:Record<string,string>={partyA:'买东西或委托做事的一方，完整名称是什么？',partyB:'卖东西或提供服务的一方，完整名称是什么？',scope:'具体要做哪些东西？可以直接列出你想要的功能或工作。',price:'这次一共多少钱？',payment:'准备怎么付款？例如先付多少，剩下的什么时候付。',term:'准备什么时候开始、什么时候交付？',deliverables:'做完后，对方要交给你哪些东西？',goods:'要买什么、多少件，有没有型号或质量要求？',delivery:'货送到哪里，运费由谁出？'};
export const PROFESSIONAL_DEFAULTS:Record<string,string>={
 tax:'双方各自依法承担应由其承担的税费，不擅自增加已明确的合同价款。',
 invoice:'收款方应依法就实际交易开具合法有效的发票。',
 acceptance:'按照合同所载工作、成果或商品清单逐项核对。发现不符合约定的，应说明具体问题，由提供方修正后重新提交核对；沉默不视为验收通过。',
 breach:'一方未按约定履行，另一方可通知其补救；经催告后仍不履行致使合同目的不能实现的，可依法解除。已履行部分据实结算，未履行部分退还对应款项，损失赔偿依法处理。不预设固定违约金或责任上限。',
 disputes:'适用中国大陆法律。争议先由双方协商，协商不成，向依法有管辖权的人民法院起诉。',
};
const SCENE_DEFAULTS:Record<string,Record<string,string>>={
 software:{ip:'甲方可为本合同约定的业务目的使用交付成果；源码及修改需求以交付清单明确的约定为准。已有代码及第三方组件依其权利和许可证使用，本合同不因交付行为自动转让全部知识产权。',maintenance:'乙方应修复交付成果中不符合本合同约定的缺陷。新增功能不属于原工作范围，应经双方书面确认。项目资料和约定账号应随交付移交，双方依法保护业务数据。'},
 service:{rights:'委托方可为本次约定业务目的使用交付成果。提供方应保密所接触的非公开业务资料，并在履约结束后返还或依法处理，不因交付自动转让全部知识产权。'},
 purchase:{warranty:'商品不符合合同约定的，买方可以依法要求修理、更换、退货或其他适当补救，具体处理与商品问题相适应。'},
};
export function defaultsFor(i:Intake){return Object.fromEntries(Object.entries({...Object.fromEntries(Object.entries(PROFESSIONAL_DEFAULTS).filter(([id])=>i.templateId==='general'?!['tax','invoice','acceptance'].includes(id):i.templateId!=='nda'||!['tax','invoice','acceptance','breach'].includes(id))),...SCENE_DEFAULTS[i.templateId],...EXTENDED[i.templateId]?.defaults}).filter(([id])=>!i.facts[id]&&!i.withdrawnFields?.includes(id)));}
export function effectiveTerms(i:Intake){return {...(i.policyVersion?i.defaults||{}:{}),...Object.fromEntries(Object.entries(i.facts).map(([k,v])=>[k,v.value]))};}
export function lawyerChecklist(i:Intake){return [...new Set([...(i.reviewNotes||[]),...Object.keys(i.defaults||{}).map(id=>`复核系统起草条款：${id}`),...(i.withdrawnFields||[]).map(id=>`用户撤回了 ${id}，不得沿用旧约定`)])];}

/** Ask business questions only when the transaction itself makes them material. */
export function sceneQuestions(i:Intake):{fieldId:string;question:string}[]{
 const text=Object.values(i.facts).map(f=>f.value).join('；');
 const questions:{fieldId:string;question:string}[]=[];
 if(i.templateId==='general')for(const id of selectedModules(i)){const m=MODULES[id];if(!i.facts[m.field])questions.push({fieldId:m.field,question:m.question});}
 if(i.templateId==='software'&&!/源码|源代码/.test(i.facts.deliverables?.value||'')&&!i.facts.sourceDelivery)questions.push({fieldId:'sourceDelivery',question:'软件做完后，源代码需要一起交付吗？'});
 if(i.templateId==='software'&&/维护|运维|持续支持/.test(text)&&(!i.facts.maintenance||!/[天月年]|长期|持续到|截止|仅修复|不需要|不用/.test(i.facts.maintenance.value)))questions.push({fieldId:'maintenance',question:'上线后需要对方继续做哪些维护，持续多久？'});
 if(i.templateId==='purchase'&&/安装|调试/.test(text)&&(!i.facts.installation||!/(负责|由|包安装)/.test(i.facts.installation.value)||!/(含|免费|另付|费用|自理)/.test(i.facts.installation.value)))questions.push({fieldId:'installation',question:'安装和调试由谁负责，费用包含在总价里吗？'});
 if(i.templateId==='service'&&/拍摄|视频|广告|宣传/.test(text)&&(!i.facts.usage||!/(用于|用在|投放|发布|平台|抖音|小红书|内部|门店播放)/.test(i.facts.usage.value)))questions.push({fieldId:'usage',question:'做好的内容准备用在哪些地方？需要用于广告投放吗？'});
 return questions;
}
