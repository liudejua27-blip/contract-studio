import type {Contract} from './types';
import {PLAYBOOKS,transactionSummary} from './contract-library/playbooks';
export function consultationBrief(c:Pick<Contract,'workflow'>){
 const i=c.workflow?.intake,p=i&&PLAYBOOKS[i.templateId];
 return '【需求咨询：尚未生成合同】\n'+(i?'已记录的交易信息：\n'+transactionSummary(i)+'\n尚需沟通：'+[...new Set([...i.missing,...i.deferredFields||[]])].map(id=>p?.fields.find(f=>f.id===id)?.label||id).join('、')+'\n律师待审事项：\n'+(i.reviewNotes||[]).join('\n'):'需求尚未整理成摘要，请参考以下原始对话。')+'\n以下为原始对话：\n';
}
