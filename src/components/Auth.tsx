'use client';
import { useState, type FormEvent } from 'react';
import { FileText, ArrowRight, Check } from 'lucide-react';
import { api } from '@/lib/api';
import type { User } from '@/lib/types';
export function Auth({ onLogin }: { onLogin: (user: User) => void }) {
 const [register,setRegister]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function submit(e:FormEvent<HTMLFormElement>) {e.preventDefault();setBusy(true);setError('');const data=new FormData(e.currentTarget);try{onLogin(await api<User>(`auth/${register?'register':'login'}`,Object.fromEntries(data)));}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 return <main className="auth-page"><section className="auth-story"><div className="brand"><FileText/>合同工作室</div><div className="auth-intro"><h1>从一句需求，<br/>到一份清楚的合同。</h1><p>用对话整理约定，以 Word 留下共识。<br/>需要时，再交给律师认真审阅。</p><div className="auth-steps"><span><Check/>说清需求</span><span><Check/>生成 Word</span><span><Check/>律师审阅</span></div></div><small>AI 起草 · 真人审核 · 版本留存</small></section><section className="auth-form-area"><form className="auth-form" onSubmit={submit}><h2>{register?'创建你的账户':'欢迎回来'}</h2><p className="muted">{register?'开始起草你的第一份合同。':'登录后继续你的合同。'}</p>{register&&<label>姓名<input name="name" autoComplete="name" required maxLength={60}/></label>}<label>邮箱<input name="email" type="email" autoComplete="email" placeholder="you@example.com" required/></label><label>密码<input name="password" type="password" autoComplete={register?'new-password':'current-password'} minLength={8} maxLength={128} required/></label>{error&&<p className="error" role="alert">{error}</p>}<button className="primary wide" disabled={busy}>{busy?'正在处理…':register?'创建账户':'登录'}<ArrowRight size={16}/></button><button type="button" className="text-button wide" onClick={()=>{setRegister(!register);setError('')}}>{register?'已有账户？登录':'还没有账户？注册'}</button><p className="auth-note">律师和管理员请使用平台开通的账户登录。</p></form></section></main>
}
