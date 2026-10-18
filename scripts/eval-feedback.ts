/** Explicit opt-in generation; export/score are offline and make no model requests. */
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {z} from 'zod';
import {evaluationSet,readEvaluationSet,outputsSchema,assessmentsSchema,scoreFeedback,digest} from '../src/lib/feedback-evaluation';
import {approvedSamples} from '../src/server/review-learning';
import {closeDatabase} from '../src/server/db';
import {runStructuredAgent} from '../src/server/agent/runtime';
import {legalSkillBundle} from '../src/server/agent/legal-skills';
import {CONTRACT_AGENT_PROMPT} from '../src/server/agent/prompt';
const read=async(path:string)=>JSON.parse(await readFile(path,'utf8'));
async function save(path:string,value:unknown){await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path,JSON.stringify(value,null,2),{mode:0o600,flag:'wx'});}
async function main(){
 const [action,path,outputsPath,reviewsPath]=process.argv.slice(2);
 if(action==='--export'&&path){const set=evaluationSet(await approvedSamples());await save(path,set);console.log(JSON.stringify({cases:set.cases.length,hash:set.hash,modelCalls:0}));return;}
 if(action==='--generate'&&path&&outputsPath){
  const set=readEvaluationSet(await read(path));if(!set.cases.length)throw new Error('没有已确认样本');
  const active=evaluationSet(await approvedSamples()).cases;
  if(set.cases.some(c=>!active.some(a=>a.id===c.id&&digest(a)===digest(c))))throw new Error('样本已撤回、来源待修改或确认记录变化，请重新导出当前样本');
  await mkdir(dirname(outputsPath),{recursive:true,mode:0o700});await mkdir(outputsPath,{mode:0o700});
  const dir=outputsPath,bundle=await legalSkillBundle('draft',[]),prompt=CONTRACT_AGENT_PROMPT+'\n'+bundle.prompt+'\n这是条款级评估。只根据给定匿名场景起草相关条款，不补造事实。不生成整份合同。';const results:{id:string;candidate:string;error?:string}[]=[];
  // Separate ephemeral sessions and no customer preferences. Expected answers and holdout labels are never sent to the model.
  for(const c of set.cases){try{const r=await runStructuredAgent({prompt,messages:[{role:'user',content:c.scenario}],schema:z.object({candidate:z.string().min(1).max(16000)}),toolName:'submit_evaluation_clause',stage:'draft',environment:{...process.env,CONTRACT_LEGAL_SEARCH_API_KEY:'',TAVILY_API_KEY:''}});results.push({id:c.id,candidate:r.value.candidate});}catch{results.push({id:c.id,candidate:'',error:'generation_failed'});}await save(join(dir,c.id+'.json'),{setHash:set.hash,...results.at(-1)});}
  const output=outputsSchema.parse({setHash:set.hash,model:process.env.CONTRACT_AI_MODEL||process.env.OPENAI_MODEL||'deepseek-flash',configuration:{promptSha256:digest(prompt),skillSha256:digest(bundle.receipts),thinking:process.env.CONTRACT_AI_THINKING||'default',effort:process.env.CONTRACT_AI_REASONING_EFFORT||'default'},createdAt:new Date().toISOString(),results});
  await save(join(dir,'outputs.json'),output);
  await save(join(dir,'review.json'),{setHash:set.hash,outputHash:digest(output),reviewer:'请填写评审人',results:set.cases.map(c=>({id:c.id,criteria:c.criteria.map((criterion,index)=>({index,criterion,verdict:'uncertain',reason:'请对照场景、预期结果和本次输出逐项评审'}))}))});
  console.log(JSON.stringify({cases:results.length,output:join(dir,'outputs.json'),needsHumanReview:true}));return;
 }
 if(action==='--score'&&path&&outputsPath&&reviewsPath){const set=readEvaluationSet(await read(path)),output=outputsSchema.parse(await read(outputsPath)),reviews=assessmentsSchema.parse(await read(reviewsPath));if(reviews.reviewer==='请填写评审人')throw new Error('请填写实际评审人');const report=scoreFeedback(set,output,reviews,Number(process.env.CONTRACT_EVAL_PASS_RATE||0.95));await save(join(dirname(reviewsPath),'report-'+Date.now()+'.json'),report);console.log(JSON.stringify({development:report.development,holdout:report.holdout}));if(!report.holdout.targetMet)process.exitCode=1;return;}
 console.log('导出已确认匿名样本（不调用模型）：npm run eval:feedback -- --export .data/qa/feedback/cases.json\n显式生成条款（调用模型，可能计费）：npm run eval:feedback -- --generate .data/qa/feedback/cases.json .data/qa/feedback/run-1\n填写 review.json 后评分（不调用模型）：npm run eval:feedback -- --score cases.json outputs.json review.json');
}
main().catch(e=>{console.error(e.message);process.exitCode=1}).finally(closeDatabase);
