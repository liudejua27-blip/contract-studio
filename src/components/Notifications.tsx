'use client';
import {useEffect,useState} from 'react';
import {api,dateLabel} from '@/lib/api';
type Item={id:string;contract_id:string;message:string;created_at:string};
export function Notifications(){
 const [items,setItems]=useState<Item[]>([]),[error,setError]=useState('');
 useEffect(()=>{let active=true;const load=()=>api<Item[]>('notifications').then(r=>{if(active)setItems(r)}).catch(e=>{if(active)setError(e.message)});void load();const timer=setInterval(()=>void load(),20000);return()=>{active=false;clearInterval(timer)}},[]);
 return <section className="page-body"><h1>消息通知</h1><p>审核分配、待补充和交付消息会保存在这里。</p>{error&&<p role="alert">{error}</p>}{items.map(n=><div className="notice" key={n.id}><span>{n.message} · {dateLabel(n.created_at)}</span><a href={'/?contract='+encodeURIComponent(n.contract_id)+'&view=review'}>打开合同</a><button onClick={async()=>{try{await api('notifications',{id:n.id});setItems(old=>old.filter(x=>x.id!==n.id))}catch(e){setError((e as Error).message)}}}>标记已读</button></div>)}{!items.length&&<p>暂无未读通知。</p>}</section>;
}
