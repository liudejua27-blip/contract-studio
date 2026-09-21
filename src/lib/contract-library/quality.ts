import type {ContractContent} from '../types';
/** Business completeness applies to every contract family. Never supplies missing facts. */
export const GENERAL_QUALITY_RULES=`通用合同质量审查适用于任何交易，不要求匹配某个专项模板。
逐项核对所有已确认事实（包括特殊约定、否定和例外）在正文或实际附件中有明确落点，不得只保留金额而遗漏工作内容。
判断核心约定是否实质完整：不得正文引用附件、附件又推回未来确认；附件必须写实际事项，不以标题存在视为完整。
按实际交易核对各方义务、履行时间、交付或持续服务、核对或验收、支付或交换、终止后处理的衔接。无偿、保密及持续合作不得强套价款或实物交付。
已有明确约定即使不符合常见方式也不能擅自改写；例如明确约定交付前付款不能强制改为验收后付款。只对确有矛盾或执行触发条件缺失提出问题。
区分原始交易范围与后续变更：允许新增工作另行书面确认，禁止把原始核心范围推给未来约定。
缺交易事实不得靠模型填空；只在缺项实际妨碍起草时提出具体缺项。法律措辞、权利配置风险及专业审定意见记入reviewNotes，不转成对用户的法律问题。
检查角色、正文和附件一致性，明确期限的起点、费用承担和付款条件；不要擅自把用户模糊的日期变成具体承诺。
对既有知识产权、账号、设备和数据，区分交付、使用、所有权及返还；不得仅因交付推定权利转让。只对交易实际涉及的事项检查。
交易事实遗漏、核心内容空泛及条款矛盾必须列为issues，不得降级为reviewNotes；专业法律审定事项也不得冒充用户未回答的生意事实。
这是AI初稿质量检查，不是律师最终审核或法律有效性结论。`;
export function substantiveProblems(c:ContractContent):string[]{
 const problems:string[]=[];
 for(const part of [...c.sections,...c.attachments||[]]){
  for(const sentence of part.content.split(/[。；;\n]/)){
   if(/新增|变更|增加.*(?:功能|服务|工作)/.test(sentence))continue;
   const core=/(?:具体|实际|详细)?(?:功能(?:项|范围)?|服务内容|工作内容|合作事项|交付(?:内容|范围|清单)|采购(?:数量|标的)|标的|价款|付款(?:节点|条件)|履行期限)/;
   const future=/(?:另行|后续|开发过程中|履行过程中|以后|届时).{0,20}(?:确认|确定|约定|协商)/;
   if(core.test(sentence)&&future.test(sentence))problems.push(`《${part.title}》把核心约定推迟到以后确认：${sentence.trim()}。请使用已确认事实写实，不能编造。`);
  }
 }
 return [...new Set(problems)];
}
