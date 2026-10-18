'use client';
import {useEffect,useState} from 'react';
import {api} from '@/lib/api';
import type {Version} from '@/lib/types';
export function useVersionBody(contractId:string,version?:Version){
 const [loaded,setLoaded]=useState<Version|null>(null),[error,setError]=useState('');
 useEffect(()=>{setError('');if(!version||version.bodyLoaded!==false)return;let stopped=false;api<Version>(`contracts/${contractId}/versions/${version.id}`).then(v=>{if(!stopped)setLoaded(v)}).catch(e=>{if(!stopped)setError(e.message)});return()=>{stopped=true}},[contractId,version?.id,version?.bodyLoaded]);
 return {version:version?.bodyLoaded===false&&loaded?.id===version.id?loaded:version,error};
}
export function useMessageHistory<T extends {id:string}>(path:string,recent:T[],hasMore=false){
 const [history,setHistory]=useState<{path:string;items:T[];more:boolean}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const old=history?.path===path?history:undefined;
 const messages=[...(old?.items||[]),...recent].filter((m,i,a)=>a.findIndex(x=>x.id===m.id)===i);
 async function load(){if(busy)return;setBusy(true);setError('');try{const result=await api<{items:T[];hasMore:boolean}>(`${path}?before=${encodeURIComponent(messages[0]?.id||'')}`);setHistory({path,items:[...result.items,...messages],more:result.hasMore})}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
 return {messages,hasMore:old?old.more:hasMore,busy,error,load};
}
