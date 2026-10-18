'use client';
import {privateKey,readPrivate,writePrivate,removePrivate,clearPrivateBrowserData} from '@/lib/private-browser-store';
import {useState} from 'react';
/** Tab-local, account-scoped drafts. Storage writes are user actions, never render effects. */
export function useComposerDraft(userId:string|undefined,contractId:string|null){
 const [drafts,setDrafts]=useState<Record<string,string>>({});
 const key=privateKey(userId||'anonymous',contractId||'new');
 const read=()=>{try{return typeof window==='undefined'?'':readPrivate<string>(key)||'';}catch{return '';}};
 const input=drafts[key]??read();
 function setInput(value:string|((old:string)=>string)){
  setDrafts(old=>{const next=typeof value==='function'?value(old[key]??read()):value;try{if(next)writePrivate(key,next);else removePrivate(key);}catch{}return {...old,[key]:next};});
 }
 function clear(){setDrafts({});clearPrivateBrowserData();}
 return {input,setInput,clear};
}
