'use client';
import {useEffect,useState} from 'react';
import {api} from '@/lib/api';
export function DeletionRequest({contractId,revision}:{contractId:string;revision?:string}){
 const [scheduled,setScheduled]=useState(false),[confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[deadline,setDeadline]=useState('');
 useEffect(()=>{let active=true;api<{delete_after:string}|null>(`contracts/${contractId}/deletion`).then(r=>{if(active){setScheduled(!!r);setDeadline(r?.delete_after||'')}}).catch(()=>{});return()=>{active=false}},[contractId,revision]);
 async function submit(cancel=false){setBusy(true);try{const result=await api<{scheduled:boolean;deleteAfter?:string}>(`contracts/${contractId}/deletion`,{cancel});setScheduled(result.scheduled);setDeadline(result.deleteAfter||'');setConfirm(false);setNotice(cancel?'已撤销删除申请。':'已申请删除。继续沟通或修改后，将从最近活动重新计算 30 天保留期。');}catch(e){setNotice((e as Error).message)}finally{setBusy(false)}}
 return <div className="notice"><button className="text-button" disabled={busy} onClick={()=>scheduled?void submit(true):setConfirm(!confirm)}>{scheduled?'撤销合同删除申请':'申请删除此合同'}</button>{confirm&&<><span>将删除合同记录、会话和文件，申请后保留 30 天撤销期。</span><button disabled={busy} onClick={()=>void submit()}>确认申请</button></>}{scheduled&&deadline&&<span>预计删除时间：{new Date(deadline).toLocaleString('zh-CN')}；继续沟通或修改后重新保留 30 天。</span>}{notice&&<span role="status">{notice}</span>}</div>;
}
