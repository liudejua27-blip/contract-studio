import {agentStreamResponse} from '../src/server/agent/http-stream';
import {templateDownload} from '../src/server/template-download';
import {z,ZodError} from 'zod';
import {AppError} from './error';
import type {Env} from './runtime';
import {cookie,createUser,currentUser,digest,issueSession,limit,publicUser,sessionCookie,verifyPassword} from './auth';
import * as contracts from './contracts';
const json=(data:unknown,status=200,headers:Record<string,string>={})=>Response.json({data},{status,headers:{'Cache-Control':'no-store',...headers}});
async function readBody(request:Request,max:number){
 const reader=request.body?.getReader();if(!reader)return new Uint8Array();const chunks:Uint8Array[]=[];let size=0;
 try{while(true){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>max){await reader.cancel();throw new AppError(413,'内容超过大小限制。','REQUEST_TOO_LARGE');}chunks.push(r.value);}}finally{reader.releaseLock();}
 const result=new Uint8Array(size);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length;}return result;
}
async function api(request:Request,env:Env):Promise<Response>{
 const url=new URL(request.url),p=url.pathname.slice(5).split('/'),method=request.method;
 if(!['GET','POST','PATCH'].includes(method))throw new AppError(405,'不支持此操作。','METHOD_NOT_ALLOWED');
 let input:any={};let bounded:Request|undefined;
 if(method!=='GET'){
  const origin=request.headers.get('origin');if(request.headers.get('sec-fetch-site')==='cross-site'||(origin&&origin!==url.origin))throw new AppError(403,'请使用网站原地址提交。','CSRF_BLOCKED');
  const upload=p[0]==='contracts'&&p[4]==='upload';const bytes=await readBody(request,upload?11*1024*1024:128*1024);
  if(upload&&!request.headers.get('content-type')?.startsWith('multipart/form-data'))throw new AppError(400,'请选择有效的上传文件。','INVALID_INPUT');
  if(upload)bounded=new Request(request.url,{method,headers:request.headers,body:bytes});
  else if(bytes.length){try{input=JSON.parse(new TextDecoder().decode(bytes));}catch{throw new AppError(400,'输入格式无效。','INVALID_INPUT');}if(!input||typeof input!=='object'||Array.isArray(input))throw new AppError(400,'输入格式无效。','INVALID_INPUT');}
 }
 if(p.join('/')==='capabilities'&&method==='GET')return json({aiConfigured:!!env.CONTRACT_AI_API_KEY,demoEnabled:false,onlyofficeConfigured:false,storage:'r2'});
 const user=await currentUser(env,request);
 if(p.join('/')==='session'&&method==='GET')return json(user);
 if(p[0]==='auth'&&method==='POST'){
  if(p[1]==='logout'){const token=cookie(request);if(token)await env.DB.prepare('DELETE FROM sessions WHERE hash=?').bind(await digest(token)).run();return json(null,200,{'Set-Cookie':sessionCookie('',request)});}
  const email=typeof input.email==='string'?input.email.trim().toLowerCase():'';
  await limit(env,`auth:${p[1]}:${email}`,p[1]==='login'?10:5);
  const ip=request.headers.get('cf-connecting-ip');if(ip)await limit(env,`ip:${ip}`,50);
  if(p[1]==='bootstrap'){
   const secret=request.headers.get('x-contract-bootstrap');
   if(!env.CONTRACT_BOOTSTRAP_SECRET||!secret||await digest(secret)!==await digest(env.CONTRACT_BOOTSTRAP_SECRET))throw new AppError(403,'无权初始化。','FORBIDDEN');
   const created=await createUser(env,input,'admin',true);return json(created,201);
  }
  if(p[1]==='register'){if(email===env.CONTRACT_BOOTSTRAP_ADMIN_EMAIL)throw new AppError(409,'此邮箱为平台管理员保留，请直接登录。','EMAIL_EXISTS');const created=await createUser(env,input);return json(created,201,{'Set-Cookie':sessionCookie(await issueSession(env,created),request)});}
  if(p[1]==='login'){
   const v=z.object({email:z.string().email(),password:z.string().min(1).max(256)}).parse({...input,email});
   let found=await env.DB.prepare('SELECT * FROM users WHERE email=?').bind(v.email).first<any>();
   // A preconfigured administrator may complete one-time setup through ordinary
   // sign-in. No public first-registrant or client-supplied role can claim it.
   if(!found&&v.email===env.CONTRACT_BOOTSTRAP_ADMIN_EMAIL&&env.CONTRACT_BOOTSTRAP_ADMIN_HASH&&await verifyPassword(v.password,env.CONTRACT_BOOTSTRAP_ADMIN_HASH)){
    try{await createUser(env,{...v,name:'平台管理员'},'admin',true);}catch(error){if(!(error instanceof AppError&&error.status===409))throw error;}
    found=await env.DB.prepare('SELECT * FROM users WHERE email=?').bind(v.email).first<any>();
   }
   if(!found||found.disabled||!await verifyPassword(v.password,found.password_hash))throw new AppError(401,'邮箱或密码不正确。','INVALID_CREDENTIALS');
   const logged=publicUser(found);return json(logged,200,{'Set-Cookie':sessionCookie(await issueSession(env,logged),request)});
  }
 }
 if(!user)throw new AppError(401,'请先登录。','UNAUTHENTICATED');
 if(p[0]==='templates'&&p.length===3&&p[2]==='download'&&method==='GET')return templateDownload(p[1]);
 if(p.length===1&&p[0]==='lawyers'&&method==='GET')return json((await env.DB.prepare("SELECT id,name FROM users WHERE role='lawyer' AND disabled=0 ORDER BY name,id").all()).results);
 if(p[0]==='users'){
  if(user.role!=='admin')throw new AppError(403,'需要管理员权限。','FORBIDDEN');
  if(p.length===1&&method==='GET')return json((await env.DB.prepare('SELECT * FROM users ORDER BY created_at').all()).results.map(publicUser));
  if(p.length===1&&method==='POST'){const role=z.enum(['client','lawyer','admin']).parse(input.role);return json(await createUser(env,input,role),201);}
  if(p.length===2&&method==='PATCH'){
   const v=z.object({name:z.string().trim().min(1).max(120).optional(),disabled:z.boolean().optional()}).refine(v=>v.name!==undefined||v.disabled!==undefined).parse(input);
   const old=await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(p[1]).first<any>();if(!old)throw new AppError(404,'账号不存在。','USER_NOT_FOUND');
   if(v.disabled&&p[1]===user.id)throw new AppError(409,'不能停用自己的账号。','SELF_DISABLE_FORBIDDEN');
   const name=v.name??old.name,disabled=v.disabled===undefined?old.disabled:Number(v.disabled);
   // Predicate and modification share one SQLite statement, protecting the last
   // administrator under concurrent requests without PostgreSQL row locks.
   const statement=env.DB.prepare("UPDATE users SET name=?,disabled=? WHERE id=? AND EXISTS(SELECT 1 FROM users actor WHERE actor.id=? AND actor.role='admin' AND actor.disabled=0) AND (?=0 OR role<>'admin' OR EXISTS(SELECT 1 FROM users other WHERE other.role='admin' AND other.disabled=0 AND other.id<>?)) RETURNING *").bind(name,disabled,p[1],user.id,disabled,p[1]);
   const result=await env.DB.batch([statement,env.DB.prepare('DELETE FROM sessions WHERE user_id=? AND EXISTS(SELECT 1 FROM users WHERE id=? AND disabled=1)').bind(p[1],p[1])]);
   const updated=result[0].results[0];if(!updated)throw new AppError(409,'必须保留一个正常管理员，请刷新。','LAST_ADMIN_DISABLE_FORBIDDEN');return json(publicUser(updated));
  }
 }
 if(p[0]==='files'&&p.length===2&&method==='GET')return contracts.download(env,user,p[1]);
 if(p.length===1&&p[0]==='contract-list'&&method==='GET')return json(await contracts.listPage(env,user,Object.fromEntries(url.searchParams)));
 if(p[0]==='contracts'){
  if(p.length===1&&method==='GET')return json(await contracts.list(env,user));
  if(p.length===1&&method==='POST')return json(await contracts.create(env,user,input),201);
  if(p.length===2&&method==='GET')return json(contracts.view((await contracts.load(env,p[1],user)).contract,user));
  if(p.length===5&&p[2]==='jobs'&&['run','retry','cancel'].includes(p[4])&&method==='POST'){if(p[4]==='run'&&request.headers.get('accept')?.includes('text/event-stream'))return agentStreamResponse(emit=>contracts.jobAction(env,user,p[1],p[3],'run',emit));const c=await contracts.jobAction(env,user,p[1],p[3],p[4] as 'run'|'retry'|'cancel');return json(c);}
  if(p.length===3&&p[2]==='chat'&&method==='POST'){const c=await contracts.chat(env,user,p[1],input);return json(c);}
  if(p.length===3&&p[2]==='reviews'&&method==='POST')return json(await contracts.submit(env,user,p[1],input),201);
  if(p.length===5&&p[2]==='reviews'&&method==='POST'){
   if(p[4]==='upload'){const file=(await bounded!.formData()).get('file');if(!file||typeof file==='string')throw new AppError(400,'请选择 DOCX 文件。','FILE_REQUIRED');return json(await contracts.upload(env,user,p[1],p[3],file));}
   return json(await contracts.reviewAction(env,user,p[1],p[3],p[4],input));
  }
 }
 throw new AppError(404,'接口不存在。','NOT_FOUND');
}
export default {
 async fetch(request:Request,env:Env):Promise<Response>{
  try{
   if(new URL(request.url).pathname.startsWith('/api/'))return await api(request,env);
   const path=new URL(request.url).pathname;const response=await env.ASSETS.fetch(path==='/'?new Request(new URL('/index.html',request.url),request):request);
   return response;
  }catch(error){
   if(error instanceof AppError)return Response.json({error:error.message,code:error.code},{status:error.status,headers:{'Cache-Control':'no-store'}});
   if(error instanceof ZodError)return Response.json({error:'请检查输入是否完整。',code:'INVALID_INPUT'},{status:400});
   console.error('Contract cloud request failed',error instanceof Error?error.name:'UnknownError');
   return Response.json({error:'服务暂时不可用，请稍后重试。',code:'INTERNAL_ERROR'},{status:500});
  }
 }
};
