import type {Intake,ContractContent} from '../types';
const yuan=/([0-9]+(?:\.[0-9]+)?)\s*(万元|元)/g;
function chineseNumber(s:string){const digits:Record<string,number>={'零':0,'〇':0,'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};if(!/[十百千万]/.test(s))return Number([...s].map(c=>digits[c]).join(''));let total=0,part=0,n=0;for(const c of s){if(c in digits)n=digits[c];else if(c==='万'){total+=(part+n)*10000;part=0;n=0}else{part+=(n||1)*({'十':10,'百':100,'千':1000}[c]||0);n=0}}return total+part+n;}
function clean(s:string){return s.replace(/(\d+(?:\.\d+)?)\s*(万|千)(?=元)/g,(_,n,u)=>String(Number(n)*(u==='万'?10000:1000))).replace(/[零〇一二两三四五六七八九十百千万]+(?=元|年|月|日|天|个|%)/g,m=>String(chineseNumber(m))).replace(/百分之([零一二两三四五六七八九十百]+)/g,(_,n)=>chineseNumber(n)+'%').replace(/[,，](?=\d{3}(?:\D|$))/g,'').replace(/％/g,'%');}
export function amounts(s:string){return [...clean(s).matchAll(yuan)].map(m=>Math.round(Number(m[1])*(m[2]==='万元'?10000:1)*100));}
function numericTokens(s:string){return clean(s).replace(yuan,(_,n,u)=>String(Number(n)*(u==='万元'?10000:1))+'元').match(/\d+(?:\.\d+)?/g)?.map(n=>String(Number(n)))||[];}
/** The evidence must support numbers in an extracted value, not merely exist. */
export function unsupportedFactNumbers(value:string,evidence:string){const source=new Set(numericTokens(evidence));return numericTokens(value).some(n=>!source.has(n));}
function dates(s:string){return [...s.matchAll(/(20\d{2})[年/\-](\d{1,2})[月/\-](\d{1,2})日?/g)].map(m=>({text:m[0],value:Date.UTC(+m[1],+m[2]-1,+m[3]),valid:new Date(Date.UTC(+m[1],+m[2]-1,+m[3])).getUTCMonth()===+m[2]-1}));}
function scheduleIssues(term:string){const ds=dates(term),issues:string[]=[];if(ds.some(d=>!d.valid))issues.push('日期不是有效的日历日期，请核对。');if(ds.length===2&&ds[0].value>ds[1].value)issues.push('起止日期顺序不一致，请说明开始与结束时间。');return issues;}
function periodicPrice(i:Intake){const price=i.facts.price?.value||'';return ['house-lease','equipment-lease','saas'].includes(i.templateId)&&/(每|按|\/)(天|日|月|年|次)|元.{0,2}(一个月|一月|一年|每天|每月|每年)/.test(price);}
export function intakeFactIssues(i:Intake){
 const f=i.facts,issues:string[]=[];const price=f.price?.value||'',payment=f.payment?.value||'';
 const periodic=periodicPrice(i);
 const total=periodic?[]:amounts(price),parts=amounts(payment.replace(/(?:总价|总金额|合同金额)[^，,。；;]*/g,'')),ratios=[...clean(payment).matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map(m=>+m[1]);
 if(price&&!periodic&&total.length!==1)issues.push('请明确一个合同总价，使用“金额＋元”，费用明细另行说明。');
 if(total.length===1&&parts.length>=2&&parts.reduce((a,b)=>a+b,0)!==total[0])issues.push('各笔付款金额合计与合同总价不一致，请核对。');
 if(total.length===1&&parts.length===1&&parts[0]>total[0])issues.push('付款金额超过合同总价，请核对。');
 if(ratios.length>=2&&Math.abs(ratios.reduce((a,b)=>a+b,0)-100)>.001)issues.push('分期付款比例合计不为100%，请核对。');
 if(ratios.some(r=>r<0||r>100))issues.push('付款比例超出0—100%，请核对。');
 if(parts.length===ratios.length&&parts.length&&total.length===1&&parts.some((p,n)=>Math.abs(p-total[0]*ratios[n]/100)>1))issues.push('付款金额与对应比例不一致，请核对。');
 if(f.term)issues.push(...scheduleIssues(f.term.value));
 return [...new Set(issues)];
}
/** Checks known numeric roles; semantic verification still handles prose and exceptions. */
export function draftFactIssues(c:ContractContent){
 const i=c.confirmation;if(!i)return[];const issues=intakeFactIssues(i),referenceTotal=periodicPrice(i)?undefined:amounts(i.facts.price?.value||'')[0];
 for(const section of c.sections){
  const s=section.content;
  for(const m of s.matchAll(/(?:总价|总金额|合同价款|合同金额|项目总价)(?:为|是|合计|：|:)?\s*(?:人民币)?\s*([\d,.，]+)\s*(万元|元)/g)){
   if(referenceTotal!==undefined&&amounts(m[1]+m[2])[0]!==referenceTotal)issues.push('正文中的合同总价与确认信息不一致。');
  }
  if(/期限|履行|工期/.test(section.title))issues.push(...scheduleIssues(s));
  if(/付款|价款|费用/.test(section.title)){
   const chunks=s.split(/[。；;\n]/).filter(t=>/首款|尾款|预付款|验收.*(?:付|款)|签署.*支付|第.+期|分期|首期|尾期/.test(t));
   const parts=chunks.flatMap(t=>amounts(t.replace(/(?:总价|总金额|合同金额)[^，,。；;]*/g,'')));
   if(referenceTotal!==undefined&&parts.length>=2&&parts.reduce((a,b)=>a+b,0)!==referenceTotal)issues.push('正文分期付款合计与合同总价不一致。');
  }
 }
 return [...new Set(issues)];
}
