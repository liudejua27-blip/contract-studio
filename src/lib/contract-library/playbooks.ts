import type {Field} from './catalog';
export const PLAYBOOK_VERSION='2026.09.21.1';
const field=(id:string,label:string,question:string):Field=>({id,label,question});
const common=[field('partyA','甲方名称与角色','委托方或买方的完整名称是什么？'),field('partyB','乙方名称与角色','承接方或卖方的完整名称是什么？'),field('contacts','双方联系与通知','双方用于合同通知的地址或邮箱分别是什么？'),field('price','合同总价','合同总价多少元？'),field('tax','税费安排','总价是否含税？税费由谁承担？'),field('invoice','发票安排','是否开票，开哪类发票？'),field('payment','付款安排','分几次付款，各在什么条件下支付多少？'),field('term','期限与地点','从什么事件或日期起算，到何时、在哪里完成？'),field('acceptance','验收与整改','按哪些标准验收，多久反馈，不合格怎样整改？'),field('breach','违约与解除','逾期、不履行或中途终止时，如何补救、结算和承担责任？'),field('disputes','适用地区与争议解决','是否适用中国大陆法律？争议选择哪个有实际联系地点的法院或哪家仲裁机构？')];
export const PLAYBOOKS:Record<string,{fields:Field[];scope:string;exclusions:string;optional:string[];attachments:string[];clauses:string[]}>={
 software:{scope:'小微企业网站、小程序和定制软件开发',exclusions:'不自动覆盖科研技术开发、跨境数据处理或金融医疗等专门业务',fields:[...common,field('scope','功能与范围','具体功能、运行平台及不包含的工作是什么？'),field('deliverables','交付物','是否交源码、部署资料、文档和账号，怎样交付？'),field('ip','知识产权','定制成果归谁，既有代码和第三方组件如何使用？'),field('maintenance','维护与数据','修复和维护多长时间、包含什么；数据和账号如何交接？')],optional:['第三方接口费用','上线协助','额外迭代服务'],attachments:['功能与交付清单'],clauses:['开发范围与需求变更','期限与双方协作','费用、付款与发票','交付、验收与整改','知识产权与第三方组件','维护与数据交接','违约、解除与结算','通知、争议解决与生效']},
 service:{scope:'一般企业服务及项目合作',exclusions:'不覆盖劳动关系、医疗、金融及建设工程',fields:[...common,field('scope','服务范围','具体做哪些工作，哪些不包含？'),field('deliverables','服务成果','交付哪些成果，以什么形式交付？'),field('rights','成果与资料','成果使用权归谁，保密资料怎样保管和返还？')],optional:['现场服务','分包限制','差旅费用'],attachments:['服务与成果清单'],clauses:['服务范围与变更','履行期限与协作','费用、付款与发票','成果交付、验收与整改','成果权利与保密','违约、解除与结算','通知、争议解决与生效']},
 purchase:{scope:'普通商品、设备的企业采购',exclusions:'不覆盖房产、药品等特殊标的及跨境贸易',fields:[...common,field('goods','商品与数量','品名、规格、数量及质量标准是什么？'),field('delivery','运输与交货','在哪里交货，谁承担运费、运输风险？'),field('warranty','质量与售后','质量问题如何退换、保修，期限多长？')],optional:['安装调试','分批交货','样品封存'],attachments:['商品与交货清单'],clauses:['采购标的与质量标准','交货、运输与风险承担','价款、付款与发票','验收与不合格处理','售后与质量保证','违约、解除与结算','通知、争议解决与生效']}
};
export function intakeSummary(intake:import('../types').Intake){const p=PLAYBOOKS[intake.templateId];return p?.fields.filter(f=>intake.facts[f.id]).map(f=>`${f.label}：${intake.facts[f.id].value}`).join('\n')+'\n共同条款：变更须双方书面确认；通知以实际到达为准；合同经双方签字盖章后生效。'||'';}
export const unresolved=/待补充|待确认|待填写|待约定|另行确定|另行协商确定|TBD|TODO|\[.*?(?:填写|补充).*?\]|_{2,}|\{\{.+?\}\}/i;
export function exportProblems(c:import('../types').ContractContent):string[]{
 const errors:string[]=[];if(!c.confirmation?.confirmedAt)errors.push('关键约定尚未确认');
 if(c.missing.length)errors.push(...c.missing);
 const body=[c.title,...c.parties.flatMap(p=>[p.name,p.details||'']),...c.sections.flatMap(s=>[s.title,s.content]),...(c.attachments||[]).flatMap(a=>[a.title,a.content])].join('\n');
 if(unresolved.test(body))errors.push('正文仍含未决事项或占位符');
 if(/起草参考|GitHub|github\.com|模板版本|由律师核对|不自动填入|未经律师审核|作为AI|作为一个AI/i.test(body))errors.push('正文混入内部起草说明');
 if(c.parties.length!==2||c.parties.some(p=>!p.name.trim()))errors.push('双方名称不完整');
 const p=c.confirmation&&PLAYBOOKS[c.confirmation.templateId];
 if(!p)errors.push('该类型尚未开放完整合同生成');
 else {if(p.fields.filter(f=>f.id!=='contacts').some(f=>!c.confirmation?.facts[f.id]?.value))errors.push('必要约定未齐');if(c.confirmation!.missing.length||c.confirmation!.conflicts.length)errors.push('仍有缺项或冲突');for(const t of p.attachments)if(!c.attachments?.some(a=>a.title===t&&a.content.trim()))errors.push(`缺少附件：${t}`);}
 if(/附件[二三四五六七八九十2-9]/.test(body))errors.push('引用了未登记附件');
 return [...new Set(errors)];
}
