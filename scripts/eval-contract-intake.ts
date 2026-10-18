import {evaluationGate} from './eval-gate';
import {scoreIntake} from './eval-contract-score';
/** Synthetic model evaluation. Produces a small report for human review, without DB or deployment. */
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {collectIntake} from '../src/server/ai';
import type {Intake,Message} from '../src/lib/types';
async function main(){
 const target=Number(process.env.CONTRACT_EVAL_PASS_RATE||0.95);
 evaluationGate([],target); // Reject invalid configuration before any paid model calls.
 const cases=JSON.parse(await readFile(process.env.CONTRACT_EVAL_CASES||'tests/evals/contracts.json','utf8')) as any[];
 if(process.argv[2]==='--rescore'){
  const dir=process.argv[3];const report=JSON.parse(await readFile(dir+'/report.json','utf8'));
  const results=[];
  for(const old of report.results){const saved=JSON.parse(await readFile(dir+'/'+old.id+'.json','utf8'));const definition=cases.find(c=>c.id===old.id);const errors=saved.intake&&saved.replies.length===definition.turns.length?scoreIntake(definition,saved.intake):old.errors;results.push({...old,passed:!errors.length,errors});}
  const rescored={...report,...evaluationGate(results,target),evaluationVersion:4,rescoredFrom:'report.json',rescoreReason:'Recheck recorded final state for unexpected conflicts, readiness and proposal safety. This does not establish per-turn acceptance for older reports without snapshots.',passed:results.filter(r=>r.passed).length,results};
  await writeFile(dir+'/report-rescored.json',JSON.stringify(rescored,null,2));console.log('Rescored '+rescored.passed+'/'+report.total+'; target '+target*100+'%; no model calls');if(!rescored.targetMet)process.exitCode=1;return;
 }
 const selected=process.argv[2]?cases.filter(c=>process.argv[2].split(',').includes(c.id)):cases;
 if(!selected.length)throw new Error('没有匹配的评估场景');
 const dir='.data/qa/intake-v5-'+Date.now();await mkdir(dir,{recursive:true});console.log(dir);
 // Opt-in transport diagnostics contain synthetic model outputs only, never request headers or credentials.
 const captures:Promise<unknown>[]=[];
 if(process.env.CONTRACT_EVAL_CAPTURE==='1'){
  const original=globalThis.fetch;let n=0;
  const {readModelResponse}=await import('../src/server/agent/model-stream');
  globalThis.fetch=async(...args)=>{const response=await original(...args);const index=++n;captures.push(readModelResponse(response.clone(),'intake').then(payload=>writeFile(dir+'/transport-'+index+'.json',JSON.stringify(payload.choices?.map((c:any)=>({finish:c.finish_reason,calls:c.message?.tool_calls})),null,2))).catch(()=>undefined));return response;};
 }
 const results:any[]=[];let cursor=0;
 async function run(){while(cursor<selected.length){const c=selected[cursor++],history:Message[]=c.initialHistory||[];let intake:Intake|undefined=c.initialIntake;const began=Date.now(),replies:string[]=[],snapshots:any[]=[];let firstVisibleMs:number|undefined;const errors:string[]=[];
  try{
   for(const [index,content] of c.turns.entries()){
    history.push({id:crypto.randomUUID(),role:'user',content,createdAt:new Date().toISOString()});
    const r=await collectIntake(history,intake,{...process.env,CONTRACT_PI_SESSION_DIR:dir+'/sessions',CONTRACT_AI_TIMEOUT_MS:'180000'},event=>{if(event.type==='preview'&&event.text&&firstVisibleMs===undefined)firstVisibleMs=Date.now()-began},{ownerId:'synthetic-eval',contractId:c.id,requestId:String(index),history});
    intake=r.intake;replies.push(r.reply);snapshots.push({turn:index+1,reply:r.reply,intake:structuredClone(intake)});history.push({id:crypto.randomUUID(),role:'assistant',content:r.reply,createdAt:new Date().toISOString()});
    if(c.turnExpectations?.[index])errors.push(...scoreIntake(c.turnExpectations[index],intake).map(e=>'第'+(index+1)+'轮：'+e));
    if(r.reply.length>500)errors.push('第'+(index+1)+'轮回复过长');
   }
   errors.push(...scoreIntake(c,intake));
  }catch(e){errors.push(e instanceof Error?e.message:String(e));}
  const result={id:c.id,passed:!errors.length,errors,elapsedMs:Date.now()-began,firstVisibleMs,turns:c.turns.length,replies,snapshots,intake};results.push(result);await writeFile(dir+'/'+c.id+'.json',JSON.stringify(result,null,2));console.log(c.id+': '+(result.passed?'PASS':errors.join('；')));
 }}
 await Promise.all([run(),run()]);
 await Promise.allSettled(captures);
 await writeFile(dir+'/report.json',JSON.stringify({evaluationVersion:4,...evaluationGate(results,target),synthetic:true,lawyerReviewed:false,model:process.env.CONTRACT_AI_MODEL,thinking:process.env.CONTRACT_AI_THINKING,effort:process.env.CONTRACT_AI_REASONING_EFFORT,casesFile:process.env.CONTRACT_EVAL_CASES||'tests/evals/contracts.json',total:results.length,passed:results.filter(r=>r.passed).length,results:results.map(({intake,snapshots,...r})=>r)},null,2));
 await writeFile(dir+'/lawyer-review.csv','case,实质事实错误数,重大条款遗漏数,必须修改条款数,文字偏好修改数,备注\n'+selected.map(c=>c.id+',,,,,').join('\n'));
 console.log('Completed '+results.filter(r=>r.passed).length+'/'+results.length+'; '+dir);if(!evaluationGate(results,target).targetMet)process.exitCode=1;
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
