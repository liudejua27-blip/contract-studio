import {createHash} from 'node:crypto';
import type {LegalSearch,LegalSource} from '../../lib/legal-research';
import type {Environment} from './types';
import {LEGAL_DOMAINS,officialLegalUrl} from '../../lib/source-url';
export {officialLegalUrl};
export function assertPublicLegalQuery(query:string,privateNames:string[]=[]){
 if(query.length<2||query.length>160||/https?:|@|\d{7,}|[\d一二三四五六七八九十百千万]+\s*(?:元|万元)|有限公司|股份公司|统一社会信用代码|身份证|银行账号|联系电话/.test(query)||privateNames.some(n=>n.trim().length>=2&&query.includes(n.trim())))throw new Error('检索词只写抽象法律问题或法规名称，不包含合同原文、姓名、企业名、金额或联系方式');
}
async function boundedJson(response:Response){
 const reader=response.body?.getReader();if(!reader)throw new Error('empty');let size=0;const chunks:Uint8Array[]=[];
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1500000){void reader.cancel();throw new Error('large');}chunks.push(value);}}finally{reader.releaseLock();}
 return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function searchLegalSources(query:string,env:Environment,privateNames:string[]=[]):Promise<LegalSearch>{
 query=query.trim();assertPublicLegalQuery(query,privateNames);
 const base={query,searchedAt:new Date().toISOString(),sources:[] as LegalSource[]};
 const key=env.CONTRACT_LEGAL_SEARCH_API_KEY||env.TAVILY_API_KEY;
 if(!key)return {...base,status:'unavailable',note:'法律检索未配置，不能声称已核验现行法律。可继续整理交易，把需核对的专业事项留给律师。'};
 try{
  const response=await fetch('https://api.tavily.com/search',{method:'POST',redirect:'error',signal:AbortSignal.timeout(12000),headers:{Authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify({query,topic:'general',search_depth:'basic',max_results:5,include_domains:LEGAL_DOMAINS,include_answer:false,include_raw_content:'text',include_images:false,auto_parameters:false})});
  if(!response.ok){void response.body?.cancel();throw new Error('provider');}
  const payload=await boundedJson(response),results=Array.isArray(payload.results)?payload.results:[];
  const sources:LegalSource[]=results.slice(0,10).flatMap((r:any)=>{
   if(typeof r.url!=='string'||!officialLegalUrl(r.url))return [];
   const raw=typeof r.raw_content==='string'&&r.raw_content.trim(),snippet=typeof r.content==='string'?r.content:'';
   const excerpt=(raw||snippet).slice(0,7000);if(!excerpt)return [];
   return [{id:createHash('sha256').update(r.url+'\n'+excerpt+'\n'+base.searchedAt).digest('hex'),title:String(r.title||'官方来源').slice(0,240),url:r.url,excerpt,retrievedAt:base.searchedAt,...(typeof r.published_date==='string'?{publishedDate:r.published_date.slice(0,100)}:{}),contentType:raw?'page_excerpt' as const:'search_snippet' as const,validity:'not_verified' as const}];
  }).slice(0,5);
  return {...base,sources,status:sources.length?'available':'no_results',note:'官方站点来源经检索服务返回；片段可能不完整。检索时间不等于施行日期，效力状态及适用范围尚需核对，不是律师法律意见。'};
 }catch{return {...base,status:'failed',note:'法律检索暂时失败，本次未取得可核对的新来源。不得补造法条、链接或效力结论。'};}
}

/** Fetch only an already retrieved official URL via the configured extraction service.
 * Never issue arbitrary URL requests from the application host, or replace historical snippets. */
export async function expandLegalSource(source:LegalSource,env:Environment):Promise<LegalSearch>{
 const base={query:'进一步读取：'+source.title,searchedAt:new Date().toISOString(),sources:[] as LegalSource[]};
 if(!officialLegalUrl(source.url))throw new Error('只允许读取已检索的官方来源');
 const key=env.CONTRACT_LEGAL_SEARCH_API_KEY||env.TAVILY_API_KEY;
 if(!key)return {...base,status:'unavailable',note:'法律网页读取未配置，原摘要仍可查看；不能声称已阅读全文。'};
 try{
  const response=await fetch('https://api.tavily.com/extract',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify({urls:[source.url],extract_depth:'basic',format:'text',include_images:false,timeout:10})});
  if(!response.ok){void response.body?.cancel();throw new Error('provider');}
  const payload=await boundedJson(response);
  const result=(Array.isArray(payload.results)?payload.results:[]).find((r:any)=>r.url===source.url&&typeof r.raw_content==='string'&&r.raw_content.trim());
  if(!result)throw new Error('no_matching_source');
  const excerpt=result.raw_content.slice(0,50000),truncated=result.raw_content.length>excerpt.length;
  const expanded:LegalSource={...source,id:createHash('sha256').update(source.url+'\n'+excerpt+'\n'+base.searchedAt).digest('hex'),excerpt,retrievedAt:base.searchedAt,contentType:'page_excerpt',validity:'not_verified',parentSourceId:source.id,extraction:{status:truncated?'truncated':'retrieved',characters:excerpt.length}};
  return {...base,status:'available',sources:[expanded],note:truncated?'网页提取内容过长，已截取前5万字；效力及适用范围仍待核对。':'已取得网页提取文本，可分页核对；这不保证附件完整或法律现行有效。'};
 }catch{return {...base,status:'failed',note:'本次未能读取该官方网页，保留原摘要；不能声称已阅读全文或已核实现行效力。'};}
}
