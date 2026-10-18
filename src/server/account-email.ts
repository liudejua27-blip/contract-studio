import nodemailer from 'nodemailer';
import {createHash,randomBytes} from 'node:crypto';
import {z} from 'zod';
import {AppError,query,withTransaction} from './db';
import {buildAuthRateLimitKeys,recordAuthRateLimitAttempt} from './rate-limit';
const digest=(token:string)=>createHash('sha256').update(token).digest('hex');
export function emailConfigured(){return Boolean(process.env.CONTRACT_SMTP_HOST&&process.env.CONTRACT_MAIL_FROM&&process.env.APP_BASE_URL);}
export const emailDelivery={send:async(to:string,subject:string,text:string)=>{
 if(!emailConfigured())throw new AppError(503,'尚未配置邮件服务，请联系平台管理员。','EMAIL_UNAVAILABLE');
 const secure=process.env.CONTRACT_SMTP_SECURE==='true';
 const transport=nodemailer.createTransport({host:process.env.CONTRACT_SMTP_HOST,port:Number(process.env.CONTRACT_SMTP_PORT||(secure?465:587)),secure,requireTLS:process.env.NODE_ENV==='production',tls:{rejectUnauthorized:true},auth:process.env.CONTRACT_SMTP_USER?{user:process.env.CONTRACT_SMTP_USER,pass:process.env.CONTRACT_SMTP_PASSWORD}:undefined,connectionTimeout:5000,greetingTimeout:5000,socketTimeout:10000,logger:false,debug:false,disableFileAccess:true,disableUrlAccess:true});
 try{await transport.sendMail({from:process.env.CONTRACT_MAIL_FROM,to,subject,text});}finally{transport.close();}
}};
export async function requestAccountEmail(input:unknown,purpose:'reset'|'verify',source?:string,userId?:string){
 if(!emailConfigured())throw new AppError(503,'尚未配置邮件服务，请联系平台管理员获取重置链接。','EMAIL_UNAVAILABLE');
 const email=purpose==='reset'?z.object({email:z.string().trim().email().max(320)}).parse(input).email.toLowerCase():undefined;
 await recordAuthRateLimitAttempt(buildAuthRateLimitKeys('register','mail:'+(email||userId),source));
 const origin=new URL(process.env.APP_BASE_URL!);
 if(process.env.NODE_ENV==='production'&&origin.protocol!=='https:')throw new AppError(503,'请先配置 HTTPS 网站地址。','EMAIL_UNAVAILABLE');
 const token=randomBytes(32).toString('base64url'),hash=digest(token);
 const user=await withTransaction(async client=>{
  const row=(await client.query<{id:string;email:string}>('SELECT id,email FROM users WHERE NOT disabled AND '+(email?'email_normalized=$1':'id=$1')+' FOR UPDATE',[email||userId])).rows[0];
  if(!row)return undefined;
  if(purpose==='reset'){
   // Requesting a mail must not revoke sessions or invalidate another still-valid reset link.
   await client.query("INSERT INTO password_reset_tokens(token_hash,user_id,issued_by,expires_at) VALUES($1,$2,$2,now()+interval '30 minutes')",[hash,row.id]);
  }else await client.query("INSERT INTO email_actions(token_hash,user_id,purpose,expires_at) VALUES($1,$2,'verify',now()+interval '30 minutes')",[hash,row.id]);
  return row;
 });
 if(user){
  const link=origin.origin+'/#'+(purpose==='reset'?'reset':'verify')+'='+token;
  try{await emailDelivery.send(user.email,purpose==='reset'?'重置合同工作室密码':'验证合同工作室邮箱',`请在 30 分钟内打开以下链接${purpose==='reset'?'设置新密码':'验证邮箱'}：\n${link}\n如果不是你本人操作，请忽略本邮件。`);}
  catch{await query('DELETE FROM '+(purpose==='reset'?'password_reset_tokens':'email_actions')+' WHERE token_hash=$1',[hash]);console.error('account_mail_delivery_failed');if(purpose==='verify')throw new AppError(503,'邮件暂时未能发出，请稍后重试。','EMAIL_UNAVAILABLE');}
 }
 return {message:purpose==='reset'?'如果该邮箱已注册，我们会发送重置邮件。':'验证邮件已发送，请查看邮箱。'};
}
export async function verifyAccountEmail(input:unknown){
 const {token}=z.object({token:z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).parse(input);
 await withTransaction(async client=>{
  const row=(await client.query<{user_id:string}>("UPDATE email_actions SET used_at=now() WHERE token_hash=$1 AND purpose='verify' AND used_at IS NULL AND expires_at>now() RETURNING user_id",[digest(token)])).rows[0];
  if(!row)throw new AppError(400,'验证链接无效或已过期。','EMAIL_LINK_INVALID');
  await client.query('UPDATE users SET email_verified_at=now() WHERE id=$1 AND NOT disabled',[row.user_id]);
  await client.query("INSERT INTO access_audit(actor_id,action,resource_id,outcome) VALUES($1,'email.verify',$1,200)",[row.user_id]);
 });
 return {verified:true};
}
