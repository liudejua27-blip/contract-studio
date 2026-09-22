'use client';
import {useEffect,useState} from 'react';
import type {Version} from '@/lib/types';
import {documentBody,sha256} from '@/lib/skill-audit';

export function SkillAudit({version}:{version:Version}){
 const audit=version.content?.skillAudit,body=version.content?documentBody(version.content):'';
 const [checked,setChecked]=useState<{body:string;hash:string}>();
 useEffect(()=>{let current=true;void sha256(body).then(hash=>{if(current)setChecked({body,hash});}).catch(()=>{});return()=>{current=false};},[body]);
 if(!audit)return <p className="small muted">此版本未记录 Skill 的实际载入与条款关联，来源目录不能证明已应用。</p>;
 if(checked?.body!==body)return <p className="small muted">正在核对本版规则记录……</p>;
 if(checked.hash!==audit.contentSha256)return <p className="small muted">正文已发生变化，本版规则应用记录已失效，需要重新核对。</p>;
 const located=audit.applications.filter(a=>a.status==='located');
 return <details className="draft-checks"><summary>本版 Skill 使用记录 · {located.length} 处可定位关联</summary>
  <p className="small muted">载入代表资料进入了本次请求；关联代表规则原文和合同文字都能定位，其适用性仍由律师判断。内容一致性检查不等于法律审查。</p>
  {audit.consistency?.contentSha256===audit.contentSha256&&<p className="small">本版已完成 AI 内容一致性检查，待律师审核。</p>}
  <details><summary>实际载入的资料</summary>{audit.receipts.map((r,i)=><div className="finding" key={r.id+':'+i}><strong>{{intake:'交易理解',draft:'起草',verify:'核对'}[r.stage]} · {r.path}</strong><p className="small">{r.method==='injected'?'系统载入':'Agent 工具读取'} · {r.reason}</p><p className="small muted">版本 {r.source.commit.slice(0,12)} · 字符 {r.offset}—{r.end} · SHA-256 {r.sha256.slice(0,16)}</p>{r.source.repository.startsWith('https://github.com/')&&<a href={`${r.source.repository}/blob/${r.source.commit}/skills/legal/${r.path}`} target="_blank" rel="noreferrer">查看固定版本原文 ↗</a>}</div>)}</details>
  {!audit.applications.length&&<p>本次未提供可核对的条款关联，不能仅凭资料载入认定已采用。</p>}
  {audit.applications.map((a,i)=><div className="finding" key={i}><strong>{a.status==='located'?'原文已定位 · 待律师复核':'关联未核实'} · {a.location}</strong><p className="small muted">{a.path}</p><blockquote><small>规则原文</small><p>{a.ruleQuote}</p></blockquote><blockquote><small>合同文字</small><p>{a.quote}</p></blockquote>{a.reason&&<p>{a.reason}</p>}</div>)}
  {version.sha256&&<p className="small muted">对应第 {version.number} 版 Word · 文件校验值 {version.sha256.slice(0,16)}</p>}
 </details>;
}
