import {z} from 'zod';
import {AppError} from './error';
import type {User} from '../src/lib/types';
import type {Env} from './runtime';
const enc=new TextEncoder();
const hex=(b:ArrayBuffer)=>Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join('');
export const digest=async(value:string)=>hex(await crypto.subtle.digest('SHA-256',enc.encode(value)));
const random=()=>hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
const cookieName='contract_cloud_session';
export const registerSchema=z.object({name:z.string().trim().min(1).max(120),email:z.string().trim().email().max(320).transform(s=>s.toLowerCase()),password:z.string().min(8).max(256)});
export function publicUser(u:any):User{return{id:u.id,name:u.name,email:u.email,role:u.role,disabled:!!u.disabled};}
export async function hashPassword(password:string,salt=random()){
 const key=await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveBits']);
 const bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:enc.encode(salt),iterations:100000},key,256);
 return `pbkdf2$100000$${salt}$${hex(bits)}`;
}
export async function verifyPassword(password:string,stored:string){
 const p=stored.split('$');if(p.length!==4||p[0]!=='pbkdf2'||p[1]!=='100000'||!/^[a-f0-9]{64}$/.test(p[2])||!/^[a-f0-9]{64}$/.test(p[3]))return false;
 const actual=await hashPassword(password,p[2]);let diff=actual.length^stored.length;for(let i=0;i<actual.length;i++)diff|=actual.charCodeAt(i)^stored.charCodeAt(i);return diff===0;
}
export function cookie(request:Request){return request.headers.get('cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='))?.slice(cookieName.length+1)||'';}
export const sessionCookie=(token:string,request:Request)=>`${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${token?1209600:0}${new URL(request.url).protocol==='https:'?'; Secure':''}`;
export async function currentUser(env:Env,request:Request):Promise<User|null>{
 const token=cookie(request);if(!/^[a-f0-9]{64}$/.test(token))return null;
 const row=await env.DB.prepare('SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.hash=? AND s.expires_at>? AND u.disabled=0').bind(await digest(token),Date.now()).first();
 return row?publicUser(row):null;
}
export async function issueSession(env:Env,user:User){const token=random();await env.DB.prepare('INSERT INTO sessions(hash,user_id,expires_at) VALUES(?,?,?)').bind(await digest(token),user.id,Date.now()+1209600000).run();return token;}
export async function limit(env:Env,key:string,max:number,windowMs=900000){
 const window=Math.floor(Date.now()/windowMs);const hash=await digest(key);
 const row=await env.DB.prepare('INSERT INTO rate_limits(key,window,attempts) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN window=excluded.window THEN attempts+1 ELSE 1 END,window=excluded.window RETURNING attempts').bind(hash,window).first<{attempts:number}>();
 if(!row||row.attempts>max)throw new AppError(429,'尝试次数过多，请稍后再试。','AUTH_RATE_LIMITED');
}
export async function createUser(env:Env,input:unknown,role='client',bootstrap=false){
 const v=registerSchema.parse(input);const user={id:crypto.randomUUID(),name:v.name,email:v.email,role,disabled:false};const hash=await hashPassword(v.password);
 try{
  const statement=env.DB.prepare('INSERT INTO users(id,name,email,password_hash,role,disabled,created_at) VALUES(?,?,?,?,?,0,?)').bind(user.id,user.name,user.email,hash,role,new Date().toISOString());
  if(bootstrap)await env.DB.batch([env.DB.prepare("INSERT INTO setup(id,created_at) VALUES('bootstrap',?)").bind(new Date().toISOString()),statement]);else await statement.run();
 }catch(error){if(String(error).includes('UNIQUE'))throw new AppError(409,'账号已存在或初始化已完成。','EMAIL_EXISTS');throw error;}
 return user as User;
}
