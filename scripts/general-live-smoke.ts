import {collectIntake,draftConfirmed,verifyConfirmedDraft} from '../src/server/ai';
import {renderContract,extractDocxText} from '../src/server/documents';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
async function main(){
const message='我代表测试甲咖啡有限公司，与测试乙门店有限公司合作。甲方提供一台X1咖啡机放到乙方青岛门店运营，机器归甲方所有，由甲方负责维修，合作结束甲方取回。甲方负责咖啡豆、补货及其费用，乙方负责店内经营、水电及费用。按销售收入分成，不扣成本，甲方60%，乙方40%，每月月底核对收款账目并结算。2026年10月1日起合作一年，不保底、不独家，没有其他收费。';
let previews=0;const started=Date.now();const events=(e:any)=>{if(e.type==='preview')previews++;if(e.type==='activity')console.log(e.label)};
const r=await collectIntake([{id:'test',role:'user',content:message,createdAt:new Date().toISOString()}],undefined,process.env,events);
await mkdir('.data/qa',{recursive:true});await writeFile('.data/qa/general-intake.json',JSON.stringify(r,null,2));
assert.ok(r.intake);assert.equal(r.intake.templateId,'general');assert.deepEqual(r.intake.missing,[]);assert.deepEqual(r.intake.conflicts,[]);
const content=await draftConfirmed({...r.intake,confirmedAt:new Date().toISOString()},process.env,undefined,events);
await verifyConfirmedDraft(content,process.env,events);const bytes=await renderContract(content);assert.match(extractDocxText(bytes),/60%|60％|百分之六十/);
await writeFile('.data/qa/general-live.docx',bytes);await writeFile('.data/qa/general-live.json',JSON.stringify({passed:true,previews,elapsedMs:Date.now()-started,content},null,2));console.log(JSON.stringify({passed:true,mode:'live-model-local',case:'coffee-revenue-share',previews,elapsedMs:Date.now()-started}));

}
main().catch(e=>{console.error(e.code||'GENERAL_LIVE_FAILED',e.message);process.exitCode=1});
