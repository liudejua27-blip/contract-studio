import {partText} from '../contract-document';
import type {Intake,ContractContent} from '../types';
import {businessCheckProblems} from '../business-checks';
const yuan=/([0-9]+(?:\.[0-9]+)?)\s*(万元|万块(?:钱)?|千元|千块(?:钱)?|元|块(?:钱)?|万(?=$|[\s，,。；;）)])|千(?=$|[\s，,。；;）)]))/g;
function chineseNumber(s:string){const digits:Record<string,number>={'零':0,'〇':0,'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};if(!/[十百千万]/.test(s))return Number([...s].map(c=>digits[c]).join(''));let total=0,part=0,n=0;for(const c of s){if(c in digits)n=digits[c];else if(c==='万'){total+=(part+n)*10000;part=0;n=0}else{part+=(n||1)*({'十':10,'百':100,'千':1000}[c]||0);n=0}}return total+part+n;}
function clean(s:string){return s.replace(/(\d+(?:\.\d+)?)\s*(万|千)(?=元)/g,(_,n,u)=>String(Number(n)*(u==='万'?10000:1000))).replace(/[零〇一二两三四五六七八九十百千万]+(?=元|年|月|日|天|个|%)/g,m=>String(chineseNumber(m))).replace(/百分之([零一二两三四五六七八九十百]+)/g,(_,n)=>chineseNumber(n)+'%').replace(/[,，](?=\d{3}(?:\D|$))/g,'').replace(/％/g,'%');}
const unitScale=(unit:string)=>unit.startsWith('万')?10000:unit.startsWith('千')?1000:1;
export function amounts(s:string){return [...clean(s).matchAll(yuan)].map(m=>Math.round(Number(m[1])*unitScale(m[2])*100));}
function numericTokens(s:string){return clean(s).replace(yuan,(_,n,u)=>String(Number(n)*unitScale(u))+'元').match(/\d+(?:\.\d+)?/g)?.map(n=>String(Number(n)))||[];}
/** The evidence must support numbers in an extracted value, not merely exist. */
export function unsupportedFactNumbers(value:string,evidence:string){const source=new Set(numericTokens(evidence));return numericTokens(value).some(n=>!source.has(n));}
function dates(s:string){return [...s.matchAll(/(20\d{2})[年/\-](\d{1,2})[月/\-](\d{1,2})日?/g)].map(m=>({text:m[0],value:Date.UTC(+m[1],+m[2]-1,+m[3]),valid:new Date(Date.UTC(+m[1],+m[2]-1,+m[3])).getUTCMonth()===+m[2]-1}));}
function scheduleIssues(term:string){const ds=dates(term),issues:string[]=[];if(ds.some(d=>!d.valid))issues.push('日期不是有效的日历日期，请核对。');if(ds.length===2&&ds[0].value>ds[1].value)issues.push('起止日期顺序不一致，请说明开始与结束时间。');return issues;}
function factValue(i:Intake,id:string){
 if(i.facts[id])return i.facts[id].value;
 const check=i.businessChecks?.find(c=>c.fieldId===id&&c.status==='answered');
 return check&&!businessCheckProblems([check],i.facts,[]).length?[...new Set(check.evidence)].filter(q=>!check.evidence.some(other=>other!==q&&other.includes(q))).join('；'):'';
}
function periodicPrice(i:Intake){const price=factValue(i,'price');return /(?:每|按|\/)(?:个)?(?:天|日|周|月|季|年|次)|(?:一|1)个(?:月|季度)|(?:元|块).{0,2}(?:一月|一年|每天|每月|每年)/.test(price);}
function unitBasedPrice(i:Intake){const price=factValue(i,'price');return /每[台把个件套张只支箱吨米]/.test(price)&&!/(?:总价|总共|总金额|合同金额|一共|合计|总额)/.test(price);}
/** Explicitly free is a price expression, not a missing numeric total. Do not infer it from silence. */
function priceAmounts(price:string){
 const normalized=clean(price);
 // Select the stated total, not unit prices or repeated citations of that total.
 const totals=[...normalized.matchAll(/(?:总价|总共|总金额|合同金额|一共|合计|价格(?:改成|改为)?|总额)\s*(?:为|是|人民币|：|:)?\s*(\d+(?:\.\d+)?)\s*(万元|万块|万|千元|千|元|块)?(?![\d%％])/g)].map(m=>Math.round(+m[1]*unitScale(m[2]||'元')*100));
 const values=totals.length?totals:amounts(price);
 const free=/^(?:本次(?:服务|交易)?(?:为|是)?)?(?:无偿|免费|不收取?任何费用)/.test(price.trim())||/(?:互不收(?:钱|取费用)|谁也不收钱|没有(?:其他)?费用)/.test(price);
 if(!values.length&&free&&!/但|另收|另外|除外|不是|并非|不免费/.test(price))return [0];
 // Bare numbers are amounts only within a dedicated price fact, never arbitrary user text.
 if(!values.length&&/^\s*\d+(?:\.\d+)?\s*$/.test(normalized))values.push(Math.round(Number(normalized)*100));
 if(!values.length){const scoped=normalized.match(/^(?:人民币|(?:(?:每|按)(?:个)?(?:天|日|周|月|季|年|次)|[一1]个(?:月|季度))(?:租金|费用|服务费)?)[：:\s]*(\d+(?:\.\d+)?)(?:\s|$|[，,。；;])/);if(scoped)values.push(Math.round(+scoped[1]*100));}
 return [...new Set(values)];
}
/** Derived interpretation is kept separate from authoritative, verbatim transaction evidence. */
export function priceTerms(i:Intake){
 const raw=factValue(i,'price');let values=priceAmounts(raw);
 const assessment=i.businessChecks?.find(c=>c.fieldId==='price');
 if(!values.length&&assessment?.status==='not_applicable'&&!businessCheckProblems([assessment],i.facts,[]).length)values=[0];
 return {basis:periodicPrice(i)?'periodic':unitBasedPrice(i)?'unit':values.length===1&&values[0]===0?'free':'total',amountsInCents:values};
}
function paymentAmounts(payment:string){return amounts(payment.replace(/((?:支付|付款|付|首款|尾款)[：:\s]*)(\d+(?:\.\d+)?)(?=$|[，,。；;\s])/g,'$1$2元'));}
export function paymentTerms(i:Intake){
 const raw=factValue(i,'payment'),ratios=[...clean(raw).matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map(m=>+m[1]);
 if(!ratios.length&&/各(?:付|支付)?一半|一半.{0,30}(?:另一半|另付一半)/.test(raw))ratios.push(50,50);
 // A leading “8万元分两次付：” is the schedule total, not an additional installment.
 const schedule=clean(raw).replace(/^\s*\d+(?:\.\d+)?\s*(?:万元|元|万|千元|块(?:钱)?)\s*分[^，,。；;：:]{0,12}次(?:支付|付款|付)?\s*[：:，,]/,'').replace(/(?:总价|总金额|合同金额)[^，,。；;]*/g,'');
 return {raw,amountsInCents:paymentAmounts(schedule),ratios};
}
function unitPriceIssues(i:Intake,total:number|undefined){
 if(total===undefined)return [];
 const text=clean(Object.values(i.facts).map(f=>f.value).join('；'));
 // Only one unambiguous item/unit-price pair. Mixed baskets and agreed discounts need semantic review.
 if(/优惠|折扣|打折|折后|减免|折让/.test(text))return [];
 const pairs=[...new Set([...text.matchAll(/每([台把个件套张只支箱吨米])\s*(\d+(?:\.\d+)?)\s*(万|千)?(?:元|块(?:钱)?|(?=$|[，,。；;]))/g)].map(m=>JSON.stringify([m[1],Math.round(+m[2]*unitScale(m[3]||'元')*100)])))].map(s=>JSON.parse(s) as [string,number]);
 if(pairs.length!==1)return [];
 const [unit,price]=pairs[0],quantities=[...new Set([...text.matchAll(new RegExp('(\\d+(?:\\.\\d+)?)\\s*'+unit,'g'))].map(m=>+m[1]))];
 if(quantities.length!==1||quantities[0]<=0||Math.abs(quantities[0]*price-total)<1)return [];
 if(i.conflicts?.some(s=>/单价|×|乘|每[台把个件套张只支箱吨米]|合计.*总价/.test(s)))return [];
 return [`${quantities[0]}${unit}、每${unit}${price/100}元算下来是${Math.round(quantities[0]*price)/100}元。你说一共${total/100}元，是有优惠，还是哪个金额需要调整？`];
}
export function intakeFactIssues(i:Intake){
 const issues:string[]=[];const price=factValue(i,'price'),payment=factValue(i,'payment');
 const periodic=periodicPrice(i)||unitBasedPrice(i);
 const total=periodic?[]:priceTerms(i).amountsInCents,{amountsInCents:parts,ratios}=paymentTerms(i);
 const assessment=i.businessChecks?.find(c=>c.fieldId==='price');
 const assessed=assessment&&(assessment.status==='answered'||assessment.status==='not_applicable')&&!businessCheckProblems([assessment],i.facts,[]).length;
 // A parser's inability to recognize a price is not a new business question.
 if(price&&!periodic&&total.length!==1&&(total.length>1||!assessed))issues.push(total.length>1?'这笔费用有几个不同金额，最后按哪个金额算？':'这笔交易的费用怎么计算？可以直接说总价、每月多少钱，或者不收钱。');
 issues.push(...unitPriceIssues(i,total.length===1?total[0]:undefined));
 if(total.length===1&&parts.length>=2&&parts.reduce((a,b)=>a+b,0)!==total[0])issues.push('各笔付款金额合计与合同总价不一致，请核对。');
 if(total.length===1&&parts.length===1&&parts[0]>total[0])issues.push('付款金额超过合同总价，请核对。');
 if(ratios.length>=2&&Math.abs(ratios.reduce((a,b)=>a+b,0)-100)>.001)issues.push('分期付款比例合计不为100%，请核对。');
 if(ratios.some(r=>r<0||r>100))issues.push('付款比例超出0—100%，请核对。');
 if(parts.length===ratios.length&&parts.length&&total.length===1&&parts.some((p,n)=>Math.abs(p-total[0]*ratios[n]/100)>1))issues.push('付款金额与对应比例不一致，请核对。');
 const term=factValue(i,'term');if(term)issues.push(...scheduleIssues(term));
 return [...new Set(issues)];
}
/** Checks known numeric roles; semantic verification still handles prose and exceptions. */
export function draftFactIssues(c:ContractContent){
 const i=c.confirmation;if(!i)return[];const issues=intakeFactIssues(i),referenceTotal=periodicPrice(i)||unitBasedPrice(i)?undefined:priceTerms(i).amountsInCents[0];
 for(const section of c.sections){
  const s=partText(section);
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
