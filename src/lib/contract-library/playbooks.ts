import {TRANSACTION_QUESTIONS} from '../contract-questions';
import {unresolvedTransactionFields} from '../transaction-state';
import {documentStructureProblems,partText} from '../contract-document';
import {substantiveProblems} from './quality';
import {GENERAL_FIELDS} from './general';
import {EXTENDED} from './extended';
import {BUSINESS_FIELDS} from './guided-policy';
import type {Field} from './catalog';
export const PLAYBOOK_VERSION='2026.09.21.3';
const field=(id:string,label:string,question:string):Field=>({id,label,question});
const common=[field('partyA','甲方名称与角色',TRANSACTION_QUESTIONS.partyA),field('partyB','乙方名称与角色',TRANSACTION_QUESTIONS.partyB),field('contacts','双方联系与通知','双方用于合同通知的地址或邮箱分别是什么？'),field('price','合同总价',TRANSACTION_QUESTIONS.price),field('tax','税费安排','总价是否含税？税费由谁承担？'),field('invoice','发票安排','是否开票，开哪类发票？'),field('payment','付款安排',TRANSACTION_QUESTIONS.payment),field('term','期限与地点',TRANSACTION_QUESTIONS.term),field('acceptance','验收与整改','按哪些标准验收，多久反馈，不合格怎样整改？'),field('breach','违约与解除','逾期、不履行或中途终止时，如何补救、结算和承担责任？'),field('disputes','适用地区与争议解决','是否适用中国大陆法律？争议选择哪个有实际联系地点的法院或哪家仲裁机构？')];
export const PLAYBOOKS:Record<string,{fields:Field[];scope:string;exclusions:string;optional:string[];attachments:string[];clauses:string[]}>={
 general:{scope:'未匹配成熟专项规则的一般民商事交易，混合合作按真实分工动态起草',exclusions:'不因无模板阻止起草；特殊行业、跨境交易需先核对适用能力并交律师处理',fields:[...GENERAL_FIELDS],optional:[],attachments:['交易安排清单'],clauses:['合作事项与各方义务','履行期限与协作','费用或交换安排','变更、终止与结算','责任与补救','通知、争议解决与生效']},
 software:{scope:'小微企业网站、小程序和定制软件开发',exclusions:'不自动覆盖科研技术开发、跨境数据处理或金融医疗等专门业务',fields:[...common,field('sourceDelivery','源代码交付','软件做完后，源代码需要一起交付吗？'),field('scope','功能与范围',TRANSACTION_QUESTIONS.scope),field('deliverables','交付物',TRANSACTION_QUESTIONS.deliverables),field('ip','知识产权','定制成果归谁，既有代码和第三方组件如何使用？'),field('maintenance','维护与数据','修复和维护多长时间、包含什么；数据和账号如何交接？')],optional:['第三方接口费用','上线协助','额外迭代服务'],attachments:['功能与交付清单'],clauses:['开发范围与需求变更','期限与双方协作','费用、付款与发票','交付、验收与整改','知识产权与第三方组件','维护与数据交接','违约、解除与结算','通知、争议解决与生效']},
 service:{scope:'一般企业服务及项目合作',exclusions:'不覆盖劳动关系、医疗、金融及建设工程',fields:[...common,field('usage','使用场景','做好的内容准备用在哪些地方？'),field('scope','服务范围',TRANSACTION_QUESTIONS.scope),field('deliverables','服务成果',TRANSACTION_QUESTIONS.deliverables),field('rights','成果与资料','成果使用权归谁，保密资料怎样保管和返还？')],optional:['现场服务','分包限制','差旅费用'],attachments:['服务与成果清单'],clauses:['服务范围与变更','履行期限与协作','费用、付款与发票','成果交付、验收与整改','成果权利与保密','违约、解除与结算','通知、争议解决与生效']},
 purchase:{scope:'普通商品、设备的企业采购',exclusions:'不覆盖房产、药品等特殊标的及跨境贸易',fields:[...common,field('installation','安装调试安排','安装和调试由谁负责，费用是否已包含？'),field('goods','商品与数量',TRANSACTION_QUESTIONS.goods),field('delivery','运输与交货',TRANSACTION_QUESTIONS.delivery),field('warranty','质量与售后','质量问题如何退换、保修，期限多长？')],optional:['安装调试','分批交货','样品封存'],attachments:['商品与交货清单'],clauses:['采购标的与质量标准','交货、运输与风险承担','价款、付款与发票','验收与不合格处理','售后与质量保证','违约、解除与结算','通知、争议解决与生效']}
};
for(const [id,p] of Object.entries(EXTENDED))PLAYBOOKS[id]={scope:p.scope,exclusions:p.exclusions,fields:[...common.filter(f=>!p.facts.some(x=>x[0]===f.id)&&(id!=='nda'||!['price','payment','tax','invoice','acceptance'].includes(f.id))),...p.facts.map(([id,label,question])=>field(id,label,question)),...Object.keys(p.defaults).map(id=>field(id,'系统场景规则',''))],optional:[],attachments:[p.attachment],clauses:p.clauses};
for(const p of Object.values(PLAYBOOKS))p.fields.push(...BUSINESS_FIELDS.filter(f=>!p.fields.some(x=>x.id===f.id)));
export function transactionSummary(intake:import('../types').Intake,includeIds=false){return Object.entries(intake.facts).map(([id,f])=>`${includeIds?'['+id+'] ':''}${PLAYBOOKS[intake.templateId]?.fields.find(x=>x.id===id)?.label||intake.businessChecks?.find(c=>c.fieldId===id)?.label||'补充约定'}：${f.value}`).join('\n');}
export function intakeSummary(intake:import('../types').Intake,includeIds=false){
 const p=PLAYBOOKS[intake.templateId];if(!p)return '';
 const facts=transactionSummary(intake,includeIds)+(intake.participants?.length?'\n已确认参与方：'+JSON.stringify(intake.participants):'');
 const defaults=Object.entries(intake.defaults||{}).map(([id,value])=>`${p.fields.find(f=>f.id===id)?.label||id}：${value}`).join('\n');
 return facts+(defaults?'\n系统起草条款（并非用户已约定，须律师复核）：\n'+defaults:'')+'\n共同条款：变更须双方书面确认；通知以实际到达为准；签署及生效条款须与各方主体类型和已约定签署方式一致；未约定时，不擅自要求个人盖章或所有主体同时签字并盖章。';
}
export const unresolved=/待补充|待确认|待填写|待约定|另行确定|另行协商确定|TBD|TODO|\[.*?(?:填写|补充).*?\]|_{2,}|\{\{.+?\}\}/i;
export function exportProblems(c:import('../types').ContractContent):string[]{
 const errors:string[]=[];if(!c.confirmation?.confirmedAt)errors.push('关键约定尚未确认');
 if(c.missing.length)errors.push(...c.missing);
 const body=[c.title,c.signing,...c.parties.flatMap(p=>Object.values(p).filter(v=>typeof v==='string')),...c.sections.flatMap(s=>[s.title,partText(s)]),...(c.attachments||[]).flatMap(a=>[a.title,partText(a)])].join('\n');
 if(unresolved.test(body))errors.push('正文仍含未决事项或占位符');
 if(/起草参考|GitHub|github\.com|模板版本|由律师核对|不自动填入|未经律师审核|作为AI|作为一个AI/i.test(body))errors.push('正文混入内部起草说明');
 if(c.parties.length<2)errors.push('合同至少需要两个参与方');
 const p=c.confirmation&&PLAYBOOKS[c.confirmation.templateId];
 if(!p)errors.push('该类型尚未开放完整合同生成');
 else {if(unresolvedTransactionFields(c.confirmation!).length)errors.push('必要约定未齐');if(c.confirmation!.missing.length||c.confirmation!.conflicts.length)errors.push('仍有缺项或冲突');
  // Old frozen versions retain their original contract. New drafts choose real attachments.
  if(c.confirmation!.draftingPlan?.version!=='transaction-2')for(const t of p.attachments)if(!c.attachments?.some(a=>a.title===t&&a.content.trim()))errors.push(`缺少附件：${t}`);
 }
 const attachments=c.attachments||[];
 if(attachments.some(a=>!a.title.trim()||!a.content.trim()))errors.push('附件缺少实际内容');
 if(new Set(attachments.map(a=>a.title.trim())).size!==attachments.length)errors.push('附件名称重复');
 for(const match of body.matchAll(/附件(?:[一二三四五六七八九十\d]+)?[：:\s]*《([^》]+)》/g))if(!attachments.some(a=>a.title===match[1]))errors.push(`引用了不存在的附件：${match[1]}`);
 for(const match of body.matchAll(/附件([一二三四五六七八九十]|\d+)/g)){const n=Number(match[1])||'一二三四五六七八九十'.indexOf(match[1])+1;if(n>attachments.length||n<1)errors.push('引用了未登记附件');}
 return [...new Set([...errors,...substantiveProblems(c),...documentStructureProblems(c)])];
}
