import {z} from 'zod';
export type LegalSource={id:string;title:string;url:string;excerpt:string;retrievedAt:string;publishedDate?:string;contentType:'page_excerpt'|'search_snippet';validity:'not_verified';parentSourceId?:string;extraction?:{status:'retrieved'|'truncated';characters:number}};
export function legalSourcePage(source:LegalSource,offset=0){
 if(!Number.isSafeInteger(offset)||offset<0||offset>source.excerpt.length)throw new Error('来源读取位置无效');
 return {...source,excerpt:source.excerpt.slice(offset,offset+7000),offset,nextOffset:offset+7000<source.excerpt.length?offset+7000:null,totalCharacters:source.excerpt.length};
}
export type LegalSearch={query:string;searchedAt:string;status:'available'|'unavailable'|'no_results'|'failed';sources:LegalSource[];note:string};
export const legalCitationSchema=z.object({sourceId:z.string().max(80),quote:z.string().min(8).max(1200),use:z.string().min(1).max(600)});
export const legalCitationsSchema=z.array(legalCitationSchema).max(20).optional();
export type LegalCitation=z.infer<typeof legalCitationSchema>;
export function retainLegalResearch(research:LegalSearch[],citations:LegalCitation[]=[]){
 const ids=new Set(citations.map(c=>c.sourceId));
 return research.filter((r,n)=>n>=research.length-12||r.sources.some(s=>ids.has(s.id)));
}
export function validateLegalCitations(value:unknown,research:LegalSearch[]){
 const citations=(value as {legalCitations?:LegalCitation[]})?.legalCitations||[];
 for(const c of citations){const source=research.flatMap(r=>r.sources).find(s=>s.id===c.sourceId);if(!source||!source.excerpt.includes(c.quote))throw new Error('法律引用无法在已检索来源中逐字定位，请先检索或删除无依据引用');}
}
