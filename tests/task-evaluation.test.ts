import test from 'node:test';
import assert from 'node:assert/strict';
import {scoreTaskRun,taskReviewSchema,type TaskCase,type TaskRun} from '../src/lib/task-evaluation';
import {digest} from '../src/lib/feedback-evaluation';
function fixture(){
 const cases:TaskCase[]=Array.from({length:20},(_,n)=>({id:'case-'+n,split:'holdout',description:'合成样本'+n,messages:['约定'],criteria:['履行目标','保留事实']}));
 const contract={synthetic:true};const run:TaskRun={version:1,mode:'live',caseHash:digest(cases),configurationHash:'config',createdAt:'',results:cases.map(c=>({id:c.id,status:'completed',durationMs:1,modelCalls:3,contract,artifactHash:digest(contract),automatic:[{name:'Word 可读',passed:true}]}))};
 const review=taskReviewSchema.parse({runHash:digest(run),reviewer:'合成评审',results:cases.map(c=>({id:c.id,criteria:c.criteria.map((_,index)=>({index,verdict:'pass',reason:'合成测试结果'}))}))});return {cases,run,review};
}
test('quality gate allows 19/20 and treats uncertainty as not passed; development cannot improve holdout',()=>{
 const {cases,run,review}=fixture();review.results[0].criteria[0].verdict='fail';assert.equal(scoreTaskRun(cases,run,review).holdout.targetMet,true);
 review.results[1].criteria[0].verdict='uncertain';const score=scoreTaskRun(cases,run,review);assert.equal(score.holdout.passRate,.9);assert.equal(score.holdout.targetMet,false);assert.equal(score.holdout.uncertain,1);assert.equal(score.development.total,0);
});
test('replay cannot prove model quality, and omitted/duplicate criteria or tampered output cannot pass unnoticed',()=>{
 const {cases,run,review}=fixture();run.mode='replay';review.runHash=digest(run);assert.equal(scoreTaskRun(cases,run,review).holdout.targetMet,false);
 review.results[0].criteria.pop();assert.equal(scoreTaskRun(cases,run,review).holdout.uncertain,1);
 review.results[0].criteria.push(review.results[0].criteria[0]);assert.throws(()=>scoreTaskRun(cases,run,review),/重复/);review.results[0].criteria.pop();
 run.results[0].contract={changed:true};assert.throws(()=>scoreTaskRun(cases,run,review),/不对应/);review.runHash=digest(run);assert.throws(()=>scoreTaskRun(cases,run,review),/输出已改变/);
});
test('failed workflow or absent run remains a failure even if a reviewer marks all criteria pass',()=>{
 const {cases,run,review}=fixture();run.results[0].automatic[0].passed=false;run.results.pop();review.runHash=digest(run);assert.equal(scoreTaskRun(cases,run,review).holdout.passed,18);
});
