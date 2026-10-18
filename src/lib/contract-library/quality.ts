import {partText} from '../contract-document';
import type {ContractContent} from '../types';
/** Business completeness applies to every contract family. Never supplies missing facts. */
export function substantiveProblems(c:ContractContent):string[]{
 const problems:string[]=[];
 for(const part of [...c.sections,...c.attachments||[]]){
  for(const sentence of partText(part).split(/[。；;\n]/)){
   if(/新增|变更|增加.*(?:功能|服务|工作)/.test(sentence))continue;
   const core=/(?:具体|实际|详细)?(?:功能(?:项|范围)?|服务内容|工作内容|合作事项|交付(?:内容|范围|清单)|采购(?:数量|标的)|标的|价款|付款(?:节点|条件)|履行期限)/;
   const future=/(?:另行|后续|开发过程中|履行过程中|以后|届时).{0,20}(?:确认|确定|约定|协商)/;
   if(core.test(sentence)&&future.test(sentence))problems.push(`《${part.title}》把核心约定推迟到以后确认：${sentence.trim()}。请使用已确认事实写实，不能编造。`);
  }
 }
 return [...new Set(problems)];
}
