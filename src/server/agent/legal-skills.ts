import documents from './legal-skills.generated.json';
import {sha256,type SkillReceipt,type SkillStage} from '../../lib/skill-audit';
import type {Intake} from '../../lib/types';
export const LEGAL_SKILL_SOURCE={repository:'https://github.com/pa1nrui1/legal-skills',commit:'5e39b9c30cc66ece89ff64cdafbeddde80c6b507',license:'MIT'};
const files:Record<string,string>=documents;
export const LEGAL_SKILL_ADAPTER=`你正在合同工作室中使用中国法律工作 Skill。平台适配规则优先于参考资料中的桌面操作：
合同ID与已确认交易记录就是当前事项；现有规则目录就是已配置的模板库，不询问本机路径。
平台管理事项隔离、版本、确认、导出与律师交付；只通过本阶段结构化工具交付，不执行本地脚本、飞书、日历或偏好学习。
不调用未提供的工具。北大法宝、企查查及实时法律检索在本平台尚未接通，不得沿用上游“已跑通”描述或声称已核验。
参考资料中的法条、案例、示例金额、比例、期限均不等于当前交易事实或已核验法律依据。不得复制示例商业参数；具体法规援引须有核验证据，否则留作律师待审事项。
风险、来源及未核验事项保存在reviewNotes和平台检查报告，不能混入合同正文。只生成未经律师审核的AI初稿，不声称正式法律审查完成。
保留明确的用户特殊约定，不因模板或Skill强加保证金、违约金、独家权、权利转让或保底收益。`;
export function legalSkillContext(stage:'intake'|'draft'|'verify'){
 const keys=stage==='intake'?['合同起草/references/三观分析与类型决策.md']:stage==='draft'?['合同起草/SKILL.md','合同起草/references/独立起草指引.md','合同起草/references/条款规范与语言标准.md']:['合同审查/SKILL.md','合同审查/references/checklist.md'];
 return LEGAL_SKILL_ADAPTER+'\n本阶段建议按需查阅的参考路径（资料不代表法律核验）：\n'+keys.join('\n')+'\n需要具体起草或审查方法时，使用get_legal_skill读取相关资料；无需把无关专项资料全部读入上下文。所有操作和输出结构仍须服从平台适配规则。';
}
export function legalSkillIndex(){return Object.keys(files);}
export function readLegalSkill(path:string,offset=0){
 if(!Object.hasOwn(files,path))throw new Error('未登记的Skill参考路径');
 const content=files[path];if(!Number.isInteger(offset)||offset<0||offset>=content.length)throw new Error('Skill读取位置无效');
 return{path,source:path.startsWith('platform/')?{repository:'contract-studio/local-skills',commit:path==='platform/transaction-contract/SKILL.md'?'4.3.1':'3.0.0',license:'UNLICENSED'}:LEGAL_SKILL_SOURCE,content:content.slice(offset,offset+10000),nextOffset:offset+10000<content.length?offset+10000:null};
}

export async function skillReceipt(path:string,stage:SkillStage,method:SkillReceipt['method'],offset=0,reason='Agent 按需读取'):Promise<SkillReceipt>{
 const read=readLegalSkill(path,offset),digest=await sha256(read.content);
 return{id:await sha256(JSON.stringify([stage,method,path,offset,digest])),path,stage,method,source:read.source,sha256:digest,offset,end:offset+read.content.length,reason};
}

/** Small general skills are always delivered; specialist references enhance any family. */
export async function legalSkillBundle(stage:SkillStage,families:string[]=[],transaction?:Intake){
 const paths=new Map<string,string>([['platform/transaction-contract/SKILL.md','所有交易使用通用起草与事实规则']]);
 if(stage!=='intake'){
  paths.set('platform/contract-word/SKILL.md','本版 Word 交付与正文规范');
  const references:Record<string,string>={software:'知识产权与IT类',saas:'知识产权与IT类',service:'服务承揽类',purchase:'买卖转让类','house-lease':'租赁类','equipment-lease':'租赁类',design:'服务承揽类',photography:'物流影视类',marketing:'服务承揽类',consulting:'服务承揽类',entrustment:'服务承揽类',nda:'通用配套文本'};
  for(const family of families){const reference=references[family];if(reference)paths.set(`合同起草/references/${reference}.md`,'交易相关专项参考：'+family);}
  // Retrieval hints only: these never classify the deal, create facts, or impose lease fees.
  const text=Object.values(transaction?.facts||{}).map(f=>f.value).join('；');
  if(/软件|源代码|源码|小程序/.test(text))paths.set('合同起草/references/知识产权与IT类.md','交易涉及软件：查阅相关参考，不推定知识产权转让');
  if(/设备|机器|咖啡机/.test(text)&&/归|所有|使用|取回|返还/.test(text))paths.set('合同起草/references/租赁类.md','交易涉及设备使用或返还：仅取适用规则，不据此认定租赁或增加租金');
 }
 const receipts=await Promise.all([...paths].map(([path,reason])=>skillReceipt(path,stage,'injected',0,reason)));
 const prompt=legalSkillContext(stage)+'\n以下参考实际载入当前请求；其桌面操作要求和示例不能覆盖平台规则：\n'+[...paths.keys()].map(path=>`<skill path=${JSON.stringify(path)}>\n${readLegalSkill(path).content}\n</skill>`).join('\n');
 return{prompt,receipts};
}
