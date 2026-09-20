import {z} from 'zod';
import type {Contract,Review} from './types';
export interface ContractSummary {id:string;title:string;ownerName:string;updatedAt:string;displayStatus:string;reviews:Pick<Review,'id'|'status'|'lawyerId'|'lawyerName'>[]}
export interface ContractPage {items:ContractSummary[];page:number;total:number;hasMore:boolean}
export const listQuery=z.object({q:z.string().trim().max(240).default(''),page:z.coerce.number().int().min(1).max(1000000).default(1),filter:z.enum(['all','active','completed']).default('all')});
export function summary(c:Contract):ContractSummary{
 const r=c.reviews.at(-1),v=c.versions.at(-1),j=c.workflow?.job;
 const displayStatus=r&&(!v||v.kind==='review'||r.status!=='completed')?({waiting:r.lawyerId?'待律师接收':'待分配',reviewing:'律师审核中',need_info:'待补充信息',completed:'律师已交付'}[r.status]):j?.status==='failed'?'处理未完成':['pending','running'].includes(j?.status||'')?'处理中':c.workflow?.intake&&!c.workflow.intake.confirmedAt?(c.workflow.intake.missing.length?'待补充信息':'待确认约定'):v?'合同草稿':'起草中';
 return{id:c.id,title:c.title,ownerName:c.ownerName,updatedAt:c.updatedAt,displayStatus,reviews:c.reviews.map(({id,status,lawyerId,lawyerName})=>({id,status,lawyerId,lawyerName}))};
}
