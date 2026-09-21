import {collectIntake} from '../src/server/ai';
import {writeFile,mkdir} from 'node:fs/promises';
const cases=[
 {name:'软件开发与未定维护',input:'示例甲餐饮公司委托示例乙科技公司做扫码点单小程序。8000元，签订后4000元，验收后4000元。2026年10月1日至10月31日。交源码、部署说明、管理账号，还需要上线运维。',expectedQuestion:'维护'},
 {name:'设备采购含安装',input:'示例甲公司向示例乙公司买10台示例A型打印机，总价10000元，签约付5000元，验收后付5000元。2026年10月31日交到甲公司上海办公室，卖方包运费，需要安装调试。',expectedQuestion:'安装'},
 {name:'宣传视频使用场景',input:'示例甲餐饮公司请示例乙传媒公司拍门店宣传视频，交付3条30秒成片，总价6000元，签约付3000元，验收付3000元。2026年10月1日开拍，10月10日前交付。',expectedQuestion:'用在'},
];
async function main(){const results=[];
 for(const c of cases){const t=Date.now();try{const r=await collectIntake([{id:crypto.randomUUID(),role:'user',content:c.input,createdAt:new Date().toISOString()}],undefined);
 const facts=Object.values(r.intake?.facts||{});const evidenceBound=facts.every(f=>(f.evidence||[f.quote]).every(q=>c.input.includes(q))&&(f.evidence||[f.quote]).some(q=>q.includes(f.value))||f.value===(f.evidence||[f.quote]).join('；'));
 results.push({name:c.name,elapsedMs:Date.now()-t,reply:r.reply,missing:r.intake?.missing,evidenceBound,sceneQuestionAsked:r.reply.includes(c.expectedQuestion),questionCount:(r.reply.match(/^\d\./gm)||[]).length,lawyerEdits:null});
 }catch(e:any){results.push({name:c.name,error:e.code||e.name})}}
 await mkdir('.data',{recursive:true});await writeFile('.data/agent-evaluation.json',JSON.stringify({caseSource:'合成业务场景，真实模型调用；不是真实客户或律师验收',results},null,2));console.log(JSON.stringify(results,null,2));
 if(results.some(r=>!('evidenceBound'in r)||!r.evidenceBound||!r.sceneQuestionAsked||r.questionCount>3))process.exitCode=1;
}main();
