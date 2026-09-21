import {collectIntake,draftConfirmed,verifyConfirmedDraft} from '../src/server/ai';
import {renderContract} from '../src/server/documents';
import assert from 'node:assert/strict';
import {writeFile,readFile} from 'node:fs/promises';
const messages=[
{role:'user' as const,content:'我生成一份《软件开发服务合同》。甲方：测试甲科技有限公司。乙方：测试乙软件开发工作室。甲方委托乙方开发一个企业内部使用的合同管理系统，主要功能包括用户登录、合同上传、合同分类、AI 合同审查、风险提示、合同下载和后台管理。项目总金额为人民币 80,000 元。'},
{role:'assistant' as const,content:'软件做完后，源代码需要一起交付吗？这8万元打算分几次付？项目大概什么时候开始、希望多久完成？'},
{role:'user' as const,content:'软件做完后，源代码需要一起交付。这8万元打算分2次付.付款方式按照常见方式处理。项目从9月25号开始，10月25号完成'}
].map((m,n)=>({...m,id:String(n),createdAt:new Date().toISOString()}));
async function main(){
const r:Awaited<ReturnType<typeof collectIntake>>=process.env.REUSE_INTAKE?JSON.parse(await readFile('.data/qa/repeated-question.json','utf8')):await collectIntake(messages,undefined,process.env);assert.ok(!r.intake?.missing.includes('term'));assert.ok(!r.intake?.missing.includes('deliverables'));assert.ok(r.intake?.businessProposals?.some(p=>p.fieldId==='payment'));assert.doesNotMatch(r.reply,/什么时候开始|交给你哪些/);await writeFile('.data/qa/repeated-question.json',JSON.stringify(r,null,2));const proposal=r.intake!.businessProposals!.find(p=>p.fieldId==='payment')!;
 console.log("stage: accept proposal");const next=await collectIntake([...messages,{id:'reply',role:'assistant',content:r.reply,createdAt:new Date().toISOString()},{id:'accept',role:'user',content:'采用建议：'+proposal.value,createdAt:new Date().toISOString()}],r.intake,process.env);
 assert.deepEqual(next.intake!.missing,[]);assert.deepEqual(next.intake!.conflicts,[]);
 console.log("stage: draft");const draft=await draftConfirmed({...next.intake!,confirmedAt:new Date().toISOString()},process.env);console.log("stage: verify");await verifyConfirmedDraft(draft,process.env);await writeFile('.data/qa/repeated-question.docx',await renderContract(draft));
 console.log(JSON.stringify({passed:true,wordWritten:true,finalMissing:next.intake!.missing,missing:r.intake?.missing,fields:Object.keys(r.intake?.facts||{}),reply:r.reply,proposals:r.intake?.businessProposals}));}
main().catch(e=>{console.error(e.code,e.message);process.exitCode=1});
