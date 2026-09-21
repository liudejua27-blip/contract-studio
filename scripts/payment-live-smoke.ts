import {collectIntake,draftConfirmed,verifyConfirmedDraft} from '../src/server/ai';
import {renderContract,extractDocxText} from '../src/server/documents';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
async function main(){
const message='甲方测试甲餐饮有限公司委托乙方测试乙科技有限公司开发微信点单小程序，包含菜单展示、扫码下单、后台订单管理，不含在线支付及外卖配送。总价8000元。2026年10月1日开始，2026年10月31日完成并线上交付完整源码、部署说明和管理账号。付款方式按常见方式处理。';
let previews=0;const started=Date.now();const events=(e:any)=>{if(e.type==='preview')previews++};
let r=await collectIntake([{id:'test',role:'user',content:message,createdAt:new Date().toISOString()}],undefined,process.env,events);
await mkdir('.data/qa',{recursive:true});await writeFile('.data/qa/payment-intake.json',JSON.stringify(r,null,2));
assert.ok(r.intake);assert.ok(r.intake.businessProposals?.some(p=>p.fieldId==='payment'));
const proposal=r.intake.businessProposals!.find(p=>p.fieldId==='payment')!;
const history=[{id:'test',role:'user' as const,content:message,createdAt:new Date().toISOString()},{id:'reply',role:'assistant' as const,content:r.reply,createdAt:new Date().toISOString()},{id:'adopt',role:'user' as const,content:'采用建议：'+proposal.value,createdAt:new Date().toISOString()}];
r=await collectIntake(history,r.intake,process.env,events);
assert.deepEqual(r.intake!.missing,[]);assert.deepEqual(r.intake!.conflicts,[]);assert.equal(r.intake!.facts.payment.source,'accepted_proposal');
const content=await draftConfirmed({...r.intake!,confirmedAt:new Date().toISOString()},process.env,undefined,events);
await verifyConfirmedDraft(content,process.env,events);const bytes=await renderContract(content);assert.match(extractDocxText(bytes),/8000|8,000/);
await writeFile('.data/qa/payment-live.docx',bytes);await writeFile('.data/qa/payment-live.json',JSON.stringify({passed:true,previews,elapsedMs:Date.now()-started,content},null,2));console.log(JSON.stringify({passed:true,mode:'live-model-local',case:'software-common-payment',previews,elapsedMs:Date.now()-started}));

}
main().catch(e=>{console.error(e.message);process.exitCode=1});
