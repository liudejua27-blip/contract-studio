'use client';
import {useState} from 'react';
/** Tab-local, account-scoped drafts. Storage writes are user actions, never render effects. */
export function useComposerDraft(userId:string|undefined,contractId:string|null){
 const [drafts,setDrafts]=useState<Record<string,string>>({});
 const key=`contract-composer:${userId||'anonymous'}:${contractId||'new'}`;
 const read=()=>{try{return typeof window==='undefined'?'':sessionStorage.getItem(key)||'';}catch{return '';}};
 const input=drafts[key]??read();
 function setInput(value:string|((old:string)=>string)){
  setDrafts(old=>{const next=typeof value==='function'?value(old[key]??read()):value;try{if(next)sessionStorage.setItem(key,next);else sessionStorage.removeItem(key);}catch{}return {...old,[key]:next};});
 }
 function clear(){setDrafts({});try{for(const k of Object.keys(sessionStorage))if(k.startsWith(`contract-composer:${userId}:`))sessionStorage.removeItem(k);}catch{}}
 return {input,setInput,clear};
}
