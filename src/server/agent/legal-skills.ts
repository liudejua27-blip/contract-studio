import documents from './legal-skills.generated.json';
export const LEGAL_SKILL_SOURCE={repository:'https://github.com/pa1nrui1/legal-skills',commit:'5e39b9c30cc66ece89ff64cdafbeddde80c6b507',license:'MIT'};
const files:Record<string,string>=documents;
export const LEGAL_SKILL_ADAPTER=`你正在合同工作室中使用中国法律工作 Skill。平台适配规则优先于参考资料中的桌面操作：
合同ID与已确认交易记录就是当前事项；现有规则目录就是已配置的模板库，不询问本机路径。
用户讲生意，每轮仅追问1—3个实质问题；专业判断交给系统规则与律师。没有模板进入独立起草。
平台管理事项隔离、版本、确认、导出与律师交付；只通过本阶段结构化工具交付，不执行本地脚本、飞书、日历或偏好学习。
不调用未提供的工具。北大法宝、企查查及实时法律检索在本平台尚未接通，不得沿用上游“已跑通”描述或声称已核验。
参考资料中的法条、案例、示例金额、比例、期限均不等于当前交易事实或已核验法律依据。不得复制示例商业参数；具体法规援引须有核验证据，否则留作律师待审事项。
风险、来源及未核验事项保存在reviewNotes和平台检查报告，不能混入合同正文。只生成未经律师审核的AI初稿，不声称正式法律审查完成。
保留明确的用户特殊约定，不因模板或Skill强加保证金、违约金、独家权、权利转让或保底收益。`;
export function legalSkillContext(stage:'intake'|'draft'|'verify'){
 const keys=stage==='intake'?['合同起草/references/三观分析与类型决策.md']:stage==='draft'?['合同起草/SKILL.md','合同起草/references/独立起草指引.md','合同起草/references/条款规范与语言标准.md']:['合同审查/SKILL.md','合同审查/references/checklist.md'];
 return LEGAL_SKILL_ADAPTER+'\n已加载参考资料（不代表法律核验）：\n'+keys.map(key=>key+'\n'+files[key]).join('\n')+'\n可通过get_legal_skill按索引读取需要的参考。所有操作和输出结构仍须服从平台适配规则。';
}
export function legalSkillIndex(){return Object.keys(files);}
export function readLegalSkill(path:string,offset=0){
 if(!Object.hasOwn(files,path))throw new Error('未登记的Skill参考路径');
 const content=files[path];return{path,source:LEGAL_SKILL_SOURCE,content:content.slice(offset,offset+10000),nextOffset:offset+10000<content.length?offset+10000:null};
}
