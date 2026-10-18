import type {Contract} from './types';
const cache=new Map<string,{tag:string;value:Contract}>();let generation=0;
export function clearContractReadCache(){generation++;cache.clear();}
/** Cache lives only in memory; the server authorizes every conditional request. */
export async function readContract(id:string):Promise<Contract>{
 const previous=cache.get(id),started=generation;
 const response=await fetch(`/api/contracts/${id}`,{credentials:'same-origin',cache:'no-store',headers:previous?{'If-None-Match':previous.tag}:{},signal:AbortSignal.timeout(20000)});
 if(started!==generation)throw new Error('账户已变化，请重新打开合同。');
 if(response.status===304&&previous)return previous.value;
 if(!response.ok){if(response.status===401){clearContractReadCache();window.dispatchEvent(new Event('contract-session-expired'));}throw new Error(`合同暂时无法读取（${response.status}），请重试。`);}
 const {data}=await response.json();if(started!==generation)throw new Error('账户已变化，请重新打开合同。');
 const tag=response.headers.get('etag');if(tag){if(cache.size>=20&&!cache.has(id))cache.delete(cache.keys().next().value!);cache.set(id,{tag,value:data});}
 return data;
}
