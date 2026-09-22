/** Local full-SDK acceptance. Synthetic transactions only; never creates a production contract. */
import {collectIntake,draftConfirmed,verifyConfirmedDraft} from '../src/server/ai';
import {renderContract,extractDocxText} from '../src/server/documents';
import type {Message} from '../src/lib/types';
import type {AgentRunContext} from '../src/server/agent/types';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
async function main(){
 const dir='.data/qa/pi-sdk-'+Date.now();await mkdir(dir,{recursive:true});
 const environment={...process.env,CONTRACT_AI_TIMEOUT_MS:'240000',CONTRACT_PI_SESSION_DIR:dir+'/sessions'};
 const history:Message[]=[];const add=(role:Message['role'],content:string)=>history.push({id:crypto.randomUUID(),role,content,createdAt:new Date().toISOString()});
 const context=(stage:string):AgentRunContext=>({ownerId:'synthetic-sdk-test',contractId:'software-test',requestId:stage,history});
 let previews=0;const events=(e:any)=>{if(e.type==='preview')previews++;if(e.type==='activity')console.log(e.label)};
 const started=Date.now();
 add('user','甲方测试甲科技有限公司委托乙方测试乙工作室开发企业内部合同管理系统，包括用户登录、合同上传分类、AI合同审查、风险提示、下载和后台管理。金额80000元，源码随系统一起交付，2026年9月25日开始，2026年10月25日完成。分两次付款，签约后付50%，验收后付50%。');
 const first=await collectIntake(history,undefined,environment,events,context('intake-1'));assert.ok(first.intake);assert.deepEqual(first.intake.missing,[]);assert.equal(first.intake.agentTrace?.runtime,'pi-sdk');add('assistant',first.reply);
 add('user','总金额改为90000元，其他约定不变。');
 const next=await collectIntake(history,first.intake,environment,events,{...context('intake-2'),transaction:first.intake});
 assert.ok(next.intake);assert.deepEqual(next.intake.missing,[]);assert.deepEqual(next.intake.conflicts,[]);assert.match(next.intake.facts.price.value,/90000/);assert.ok(next.intake.facts.term);assert.ok(next.intake.facts.deliverables);add('assistant',next.reply);
 const confirmed={...next.intake,confirmedAt:new Date().toISOString()};
 add('user','确认交易摘要，生成 Word 初稿。');
 const draft=await draftConfirmed(confirmed,environment,undefined,events,{...context('draft'),transaction:confirmed});
 await verifyConfirmedDraft(draft,environment,events,{...context('verify'),transaction:confirmed});
 const bytes=await renderContract(draft),text=extractDocxText(bytes);assert.match(text,/90,?000|90000|玖万元|玖万/);assert.doesNotMatch(text,/80,?000/);
 await writeFile(dir+'/software.docx',bytes);
 const report={passed:true,runtime:next.intake.agentTrace?.runtime,previews,elapsedMs:Date.now()-started,missing:next.intake.missing,wordGenerated:true,localOnly:true};
 await writeFile(dir+'/result.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));console.log('Artifact: '+dir+'/software.docx');
}
main().catch(e=>{console.error(e.code||'SDK_LIVE_FAILED',e.message);process.exitCode=1});
