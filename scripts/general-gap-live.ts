import assert from 'node:assert/strict';
import {collectIntake} from '../src/server/ai';
async function main(){
 const content='测试甲公司委托测试乙公司做门店开业活动服务，费用10000元，签约后支付5000元，活动结束且约定成果交付后支付5000元。活动是2026年10月1日，乙方交付活动现场照片和活动总结报告。';
 const r=await collectIntake([{id:'m',role:'user',content,createdAt:new Date().toISOString()}],undefined,process.env);
 assert.ok(r.intake?.facts.scope);assert.ok(r.intake?.missing.includes('scope'));assert.doesNotMatch(r.reply,/准备什么时候开始|这次一共多少钱/);console.log(JSON.stringify({passed:true,type:r.intake.templateId,missing:r.intake.missing,reply:r.reply}));
}
main().catch(e=>{console.error(e.code,e.message);process.exitCode=1});
