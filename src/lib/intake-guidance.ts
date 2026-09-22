import type {IntakeFact} from './types';

/** Keep source spans intact without counting a short quote again inside a longer quote. */
export function evidenceValue(f:{value:string;quote:string;evidence?:string[]}){
 const evidence=[...new Set([f.quote,...f.evidence||[]])];
 return evidence.includes(f.value)?f.value:evidence.filter(q=>!evidence.some(other=>other!==q&&other.includes(q))).join('；');
}

/** Reject unsupported changes before a proposal becomes a selectable user-facing card. */
export function proposalProblems(proposals:{fieldId:string;value:string}[],facts:Record<string,IntakeFact>){
 const problems:string[]=[];
 for(const p of proposals){
  if(/(?:逾期|未.{0,12}(?:异议|回复|反馈|提出)|沉默).{0,30}(?<!不)视为.{0,12}(?:验收|合格|通过|完成)/.test(p.value))problems.push('建议不得用沉默或逾期未反对视为验收通过。使用已知验收方式与普通补救，不增加此商业约定。');
  const known=Object.values(facts).map(f=>f.value).join('；');
  if(/月底.{0,5}(?:付|结算)|(?:付|结算).{0,5}月底/.test(known)&&/月底后|次月.{0,8}(?:支付|付清|付款)/.test(p.value))problems.push('用户已经明确月底付款，建议不能把该节点延后；保留原约定，不另设付款期限。');
 }
 return problems;
}
