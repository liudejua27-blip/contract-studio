import {z} from 'zod';
import {partSchema,partySchema} from './contract-document-schema';
import {blocksText} from './contract-document';
import type {ContractContent} from './types';

const target=z.enum(['section','attachment']);
const reason=z.string().trim().min(1).max(600);
const part=partSchema.extend({signatureRequired:z.boolean().optional()});
const change=z.discriminatedUnion('op',[
 z.object({op:z.literal('replace'),target,index:z.number().int().min(0),part,reason}).strict(),
 z.object({op:z.literal('remove'),target,index:z.number().int().min(0),reason}).strict(),
 z.object({op:z.literal('append'),target,part,reason}).strict(),
]);
export const contractPatchSchema=z.object({
 baseSha256:z.string().regex(/^[a-f0-9]{64}$/).describe('原稿指纹，原样复制系统提供的值'),
 changes:z.array(change).max(120).describe('index 是原稿数组下标，从0开始；只列需修改的位置'),
 header:z.object({title:z.string().trim().min(1).max(240).optional(),parties:z.array(partySchema).min(2).max(20).optional(),signing:z.string().max(10000).optional(),reason}).strict().optional(),
 ruleApplications:z.array(z.object({path:z.string().max(240),ruleQuote:z.string().min(8).max(1000),location:z.string().max(240),quote:z.string().min(8).max(1500)})).max(30).default([]),
}).strict();
export type ContractPatch=z.output<typeof contractPatchSchema>;

/** Apply edits against one immutable version. Unmentioned parts stay byte-for-byte equal as JSON. */
export function applyContractPatch(base:ContractContent,patch:ContractPatch,expectedSha256:string):ContractContent{
 if(patch.baseSha256!==expectedSha256)throw new Error('原稿版本不匹配，请使用本轮提供的 baseSha256 和原稿位置');
 const next=structuredClone(base),seen=new Set<string>();
 const normalize=(p:z.output<typeof part>)=>({...structuredClone(p),...(p.blocks?.length?{content:blocksText(p.blocks)}:{})});
 for(const c of patch.changes){
  if(c.op==='append')continue;
  const parts=c.target==='section'?base.sections:base.attachments||[];
  if(c.index>=parts.length)throw new Error(`${c.target}[${c.index}]不存在，不能修改未提供的位置`);
  const key=c.target+':'+c.index;
  if(seen.has(key))throw new Error('同一位置不能重复修改或同时删除：'+key);
  seen.add(key);
 }
 for(const target of ['section','attachment'] as const){
  const source=target==='section'?base.sections:base.attachments||[];
  const edits=patch.changes.filter(c=>c.target===target);
  if(!edits.length)continue;
  const result=source.flatMap((p,index)=>{
   const edit=edits.find(c=>c.op!=='append'&&c.index===index);
   return !edit?[structuredClone(p)]:edit.op==='replace'?[normalize(edit.part)]:[];
  });
  for(const edit of edits)if(edit.op==='append')result.push(normalize(edit.part));
  if(target==='section'){if(!result.length||result.length>100)throw new Error('合同正文须有1至100个部分');next.sections=result;}
  else{if(result.length>20)throw new Error('附件不能超过20项');next.attachments=result;}
 }
 if(patch.header){
  const {title,parties,signing}=patch.header;
  if(title!==undefined)next.title=title;
  if(parties!==undefined)next.parties=structuredClone(parties);
  if(signing!==undefined)next.signing=signing;
 }
 delete next.exportReady;delete next.skillAudit;delete next.drafting;
 return next;
}
