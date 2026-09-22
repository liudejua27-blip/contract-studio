/** Synthetic local-only evaluation, using the configured provider. No deployment. */
import {collectIntake,draftConfirmed,verifyConfirmedDraft} from '../src/server/ai';
import {renderContract,extractDocxText} from '../src/server/documents';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import type {AgentRunContext} from '../src/server/agent/types';
async function main(){
 const dir='.data/qa/transaction-skills-'+Date.now();await mkdir(dir,{recursive:true});
 const environment={...process.env,CONTRACT_PI_SESSION_DIR:dir+'/sessions',CONTRACT_AI_TIMEOUT_MS:'240000'};
 const text='甲方测试甲科技有限公司与乙方测试乙门店有限公司合作。甲方提供一台X1咖啡机和门店点单软件，软件支持商品展示、点单、收款记录及月度对账，甲方负责安装并在开始合作前交付使用，不交源代码。机器一直归甲方，甲方负责维修和咖啡豆补货及其费用；乙方负责门店运营、水电及其费用。顾客货款由乙方统一收取，按打折后实收并扣除退款的销售收入甲方60%、乙方40%分成，不扣成本，每月月底双方核对收款账目，乙方向甲方支付分成款。没有软件开发费、设备租金或其他收费。合作自2026年10月1日起至2027年9月30日止。终止后机器由甲方取回；门店订单数据先导出交给乙方，再关闭乙方账号，甲方不再保留乙方订单数据。不保底、不独家。';
 const history=[{id:'synthetic',role:'user' as const,content:text,createdAt:new Date().toISOString()}];
 const context=(stage:string):AgentRunContext=>({ownerId:'synthetic-local',contractId:'mixed-transaction',requestId:stage,history});
 let previews=0;const started=Date.now(),events=(e:any)=>{if(e.type==='preview')previews++;if(e.type==='activity')console.log(e.label);};
 console.log('Local artifacts: '+dir);
 const result=await collectIntake(history,undefined,environment,events,context('intake'));
 await writeFile(dir+'/intake.json',JSON.stringify(result,null,2));
 assert.ok(result.intake);assert.deepEqual(result.intake.missing,[]);assert.deepEqual(result.intake.conflicts,[]);
 const intake={...result.intake,confirmedAt:new Date().toISOString()};
 const draft=await draftConfirmed(intake,environment,undefined,events,{...context('draft'),transaction:intake});
 await writeFile(dir+'/draft.json',JSON.stringify(draft,null,2));
 await verifyConfirmedDraft(draft,environment,events,{...context('verify'),transaction:intake});
 const bytes=await renderContract(draft),body=extractDocxText(bytes);
 assert.match(body,/导出/);assert.match(body,/关闭/);assert.match(body,/60%|60％|百分之六十/);assert.ok(draft.skillAudit!.receipts.some(r=>r.path.endsWith('知识产权与IT类.md')));assert.ok(draft.skillAudit!.receipts.some(r=>r.path.endsWith('租赁类.md')));assert.ok(draft.skillAudit!.applications.filter(a=>a.status==='located').length>=2,'Expected at least two grounded application records');
 await writeFile(dir+'/mixed.docx',bytes);await writeFile(dir+'/draft.json',JSON.stringify(draft,null,2));
 const report={passed:true,localOnly:true,model:'live',runtime:result.intake.agentTrace?.runtime,family:intake.templateId,ruleFamilies:intake.ruleFamilies,applications:draft.skillAudit!.applications.length,located:draft.skillAudit!.applications.filter(a=>a.status==='located').length,skillReceipts:draft.skillAudit!.receipts.length,previews,elapsedMs:Date.now()-started};
 await writeFile(dir+'/result.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
main().catch(e=>{console.error(e.code||'TRANSACTION_SKILL_CHECK_FAILED',e.message);process.exitCode=1;});
