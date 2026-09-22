'use client';
import {useCallback,useSyncExternalStore} from 'react';
import type {AgentViewStore} from '@/lib/agent-view-store';
const empty=()=>undefined;
export function useAgentView(store:AgentViewStore,id:string){
 const subscribe=useCallback((fn:()=>void)=>store.subscribe(id,fn),[store,id]);
 const snapshot=useCallback(()=>store.get(id),[store,id]);
 return useSyncExternalStore(subscribe,snapshot,empty);
}
