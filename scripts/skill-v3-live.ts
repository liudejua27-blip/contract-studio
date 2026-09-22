/** Isolated synthetic evaluation against the configured Pi SDK provider; no DB or deployment. */
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {collectIntake,draftConfirmed,verifyConfirmedDraft} from '../src/server/ai';
import {renderContract,extractDocxText} from '../src/server/documents';
import type {Message,Intake,ContractContent} from '../src/lib/types';
import type {AgentRunContext} from '../src/server/agent/types';
async function main(){
 const resume=process.argv[2];
 const dir='.data/qa/skill-v3-'+Date.now();await mkdir(dir,{recursive:true});console.log('Local artifacts: '+dir);
 const env={...process.env,CONTRACT_PI_SESSION_DIR:dir+'/sessions',CONTRACT_AI_TIMEOUT_MS:'240000'};
 let previews=0;const started=Date.now(),events=(e:any)=>{if(e.type==='preview')previews++;if(e.type==='activity')console.log(e.label)};
 const history:Message[]=[];const add=(content:string)=>history.push({id:crypto.randomUUID(),role:'user',content,createdAt:new Date().toISOString()});
 const context=(requestId:string):AgentRunContext=>({ownerId:'synthetic-local',contractId:'skill-v3-software',requestId,history});
 add('甲方测试甲科技有限公司委托乙方测试乙工作室开发内部合同管理系统，包括登录、上传、分类、审查和下载。总价80000元，源码与系统一起交付。2026年9月25日开始，10月25日完成。签约后付50%，验收后付50%。甲方邮箱 alpha@example.test，乙方邮箱 beta@example.test。乙方授权签署人张三，乙方签名并盖章；甲方签署方式未约定。付款计划请用表格列出。');
 const first:{intake?:Intake;reply:string}=resume?JSON.parse(await readFile(resume+'/first.json','utf8')):await collectIntake(history,undefined,env,events,context('first'));await writeFile(dir+'/first.json',JSON.stringify(first,null,2));
 assert.ok(first.intake);assert.deepEqual(first.intake.missing,[]);assert.ok(first.intake.businessChecks?.length);assert.equal(first.intake.agentTrace?.runtime,'pi-sdk');
 history.push({id:crypto.randomUUID(),role:'assistant',content:first.reply,createdAt:new Date().toISOString()});add('总价改为90000元，其他约定不变。');
 const next:{intake?:Intake;reply:string}=resume?JSON.parse(await readFile(resume+'/revised.json','utf8')):await collectIntake(history,first.intake,env,events,context('revision'));await writeFile(dir+'/revised.json',JSON.stringify(next,null,2));
 assert.ok(next.intake);assert.deepEqual(next.intake.missing,[]);assert.deepEqual(next.intake.conflicts,[]);assert.match(next.intake.facts.price.value,/90000/);
 const intake={...next.intake,confirmedAt:new Date().toISOString()};
 const draft:ContractContent=resume?JSON.parse(await readFile(resume+'/draft.json','utf8')):await draftConfirmed(intake,env,undefined,events,{...context('draft'),transaction:intake});await writeFile(dir+'/draft.json',JSON.stringify(draft,null,2));
 if(resume)assert.ok(draft.skillAudit?.consistency,'Resume requires a verified synthetic draft');else await verifyConfirmedDraft(draft,env,events,{...context('verify'),transaction:intake});
 const a=draft.parties.find(p=>p.role==='甲方')!,b=draft.parties.find(p=>p.role==='乙方')!;
 assert.equal(a.email,'alpha@example.test');assert.equal(b.email,'beta@example.test');assert.equal(b.authorizedRepresentative,'张三');assert.equal(b.signatureMethod,'signature_and_seal');assert.equal(a.signatureMethod,undefined);
 assert.ok(draft.sections.some(s=>s.blocks?.some(b=>b.kind==='table')),'Expected an actual payment table');
 const bytes=await renderContract(draft),text=extractDocxText(bytes);assert.match(text,/90,?000/);assert.doesNotMatch(text,/80,?000/);
 await writeFile(dir+'/software.docx',bytes);await writeFile(dir+'/draft.json',JSON.stringify(draft,null,2));
 const quote='甲方测试甲公司和乙方测试乙门店合作卖咖啡。甲方提供咖啡机，机器归甲方，甲方负责维修和咖啡豆补货及费用，结束后取回机器。乙方负责门店运营和水电费用。顾客付款由乙方收取，每月底乙方向甲方付销售收入的60%，乙方留40%。合作从2026年10月1日至2027年9月30日，没有其他费用。分成按折后实收计算，退款怎么算还没定。';
 const revenueHistory:Message[]=[{id:crypto.randomUUID(),role:'user',content:quote,createdAt:new Date().toISOString()}];
 const revenue=await collectIntake(revenueHistory,undefined,env,events,{ownerId:'synthetic-local',contractId:'skill-v3-revenue',requestId:'undecided',history:revenueHistory});
 await writeFile(dir+'/revenue.json',JSON.stringify(revenue,null,2));assert.ok(revenue.intake?.deferredFields?.includes('revenueAdjustments'));assert.equal(revenue.intake!.facts.revenueAdjustments,undefined);assert.ok(revenue.intake!.reviewNotes?.some(n=>/退款/.test(n)));assert.doesNotMatch(revenue.reply,/退款要从.*扣/);
 const report={passed:true,localOnly:true,draftResumedFrom:resume||null,runtime:'pi-sdk',skillVersions:[...new Set(draft.skillAudit!.receipts.filter(r=>r.path.startsWith('platform/')).map(r=>r.source.commit))],paymentTable:true,partyOwnership:true,correctionRetained:true,unknownRefundRetained:true,previews,elapsedMs:Date.now()-started};
 await writeFile(dir+'/result.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
main().catch(e=>{console.error(e.code||'SKILL_V3_LIVE_FAILED',e.message);process.exitCode=1});
