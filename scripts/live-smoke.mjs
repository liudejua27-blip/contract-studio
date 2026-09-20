import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const base='http://127.0.0.1:3210/api';
const account=JSON.parse(await readFile('.data/local-accounts.json','utf8')).find(x=>x.role==='client');
let cookie='';
const request=async(path,body)=>{const r=await fetch(base+'/'+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',...(cookie?{cookie}:{})},body:body?JSON.stringify(body):undefined});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];const data=await r.json();assert.ok(r.ok,`${path}: ${r.status} ${data.code||''}`);return data.data;};
const report={time:new Date().toISOString(),checks:[]};
try{
 await request('auth/login',{email:account.email,password:account.password});
 let c=await request('contracts',{title:'真实模型接口验收 · 摄影合同'});report.contractId=c.id;
 const started=Date.now();
 c=await request(`contracts/${c.id}/chat`,{mode:'live',generate:true,message:'这是虚构测试。甲方测试甲公司，乙方测试乙公司，摄影费用20000元，拍摄3天，照片版权归甲方。直接生成草稿，付款节点、日期、地点未确定，留待补充，不添加其他具体金额或日期。'});
 report.generationMs=Date.now()-started;
 const v=c.versions.at(-1);assert.equal(v.source,'ai');report.versionId=v.id;report.checks.push('authenticated live model generates persisted AI version');
 const download=await fetch(base+'/files/'+v.id,{headers:{cookie}});assert.equal(download.status,200);const bytes=Buffer.from(await download.arrayBuffer());assert.equal(createHash('sha256').update(bytes).digest('hex'),v.sha256);await writeFile('.data/qa/deepseek-http.docx',bytes);report.checks.push('download matches persisted SHA-256');
 c=await request(`contracts/${c.id}/reviews`,{versionId:v.id,stance:'甲方',concerns:'开发验收样例，仅验证真实生成文件送审，不代表法律审核。'});assert.equal(c.reviews.at(-1).submittedVersionId,v.id);report.checks.push('review freezes exact live-generated version');report.result='passed';
}catch(e){report.result='failed';report.error=e.message;process.exitCode=1;}finally{await writeFile('docs/deepseek-http-results.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
