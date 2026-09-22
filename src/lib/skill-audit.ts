export type SkillStage='intake'|'draft'|'verify';
export interface SkillReceipt {
 id:string; path:string; stage:SkillStage; method:'injected'|'tool';
 source:{repository:string;commit:string;license:string};
 sha256:string; offset:number; end:number; reason:string;
}
export interface RuleApplication {path:string;ruleQuote:string;location:string;quote:string}
export interface SkillAudit {
 version:1; contentSha256:string; receipts:SkillReceipt[];
 applications:(RuleApplication & {receiptId?:string;status:'located'|'unverified';reason?:string})[];
 // A model consistency check is not legal review or proof of every application.
 consistency?:{contentSha256:string;status:'consistent';checkedAt:string};
}
export function documentBody(c:{title:string;parties:unknown;sections:unknown;attachments?:unknown;signing:string;documentProfile?:string}){
 // PostgreSQL JSONB reorders object keys. A stable digest must survive persistence.
 const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>[key,canonical(v)])):value;
 return JSON.stringify(canonical({title:c.title,parties:c.parties,sections:c.sections,attachments:c.attachments||[],signing:c.signing,...(c.documentProfile?{documentProfile:c.documentProfile}:{})}));
}
export async function sha256(value:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(n=>n.toString(16).padStart(2,'0')).join('');}
