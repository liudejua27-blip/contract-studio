'use client';
import {useEffect,useState} from 'react';
import {api} from '@/lib/api';
import type {operationsReport} from '@/server/operations';
type Report=Awaited<ReturnType<typeof operationsReport>>;
export function Operations(){
 const [report,setReport]=useState<Report|null>(null),[error,setError]=useState('');
 useEffect(()=>{let active=true;const load=()=>api<Report>('operations/generation').then(r=>{if(active){setReport(r);setError('')}}).catch(e=>{if(active)setError(e.message)});void load();const timer=setInterval(()=>void load(),30000);return()=>{active=false;clearInterval(timer)}},[]);
 return <section className="page-body"><h1>运行状态</h1>{error&&<p role="alert">{error}</p>}{report&&<><p>等待任务 {report.queue.pending} · 正在处理 {report.queue.running} · 最长等待 {Math.ceil(report.queue.oldest_wait_seconds)} 秒</p><p>近 24 小时模型调用 {report.model.calls} 次 · 失败 {report.model.failures} 次</p><p>模型费用估算：{report.model.estimatedCost===null?'尚未配置单价':report.model.estimatedCost.toFixed(4)}（按管理员配置的币种和单价；{report.model.costComplete?'已有用量汇总':'用量不完整，不作为账单'}）</p><p>审核超时 {report.reviews.overdue} · 待补充 {report.reviews.need_info} · 近 24 小时交付 {report.reviews.delivered}</p>{report.tasks?.length>0&&<section><h2>最近任务用量</h2><p className="muted small">预算占用含未报告用量时的保守估算和在途预留，不作为账单。</p><ul>{report.tasks.map(t=><li key={t.job_id}>{t.title} · 模型调用 {t.budget.calls}/{t.budget.policy.maxCalls} 次 · 预算占用 {t.budget.accountedTokens.toLocaleString()}/{t.budget.policy.maxTokens.toLocaleString()} tokens · 模型耗时 {Math.ceil(t.budget.modelMs/1000)} 秒{t.budget.unknownCalls||t.budget.pending?' · 部分用量未确认':''}</li>)}</ul></section>}{report.alerts.length?<ul role="status">{report.alerts.map(x=><li key={x}>{x}</li>)}</ul>:<p>当前未触发告警。</p>}</>}</section>;
}
