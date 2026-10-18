/** Defaults to a local provider replay. --live is an explicit, potentially billable operator action. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {startWorkflow,controlWorkflow,type WorkflowStore} from '../src/server/workflow';
import {renderContract} from '../src/server/documents';
import {reviewVersionProblem} from '../src/lib/review-policy';
import {taskCaseSchema,taskRunSchema,taskReviewSchema,scoreTaskRun,type TaskCase,type TaskRun} from '../src/lib/task-evaluation';
import {digest} from '../src/lib/feedback-evaluation';
import type {Contract,User} from '../src/lib/types';
import {contentFixture,intakeFixture} from '../tests/fixtures';

const materialFixtures=['总价8000元','总价9000元'].map((text,n)=>({id:'f6021462-8e1b-486b-804c-c9a65011339'+n,name:'报价'+(n+1)+'.txt',sha256:createHash('sha256').update(text).digest('hex'),purpose:'transaction' as const,status:'ready' as const,warnings:[],size:Buffer.byteLength(text),createdAt:'2026-09-26',chunkCount:1,chunks:[{id:'text-1',location:'正文',text}]}));
export const taskCases:TaskCase[]=[
 {id:'split-payment',split:'development',description:'多轮付款信息保留',messages:['先说明项目范围。','再补充付款与期限。'],question:'解释尾款安排，先不要修改。',criteria:['分多次提供的付款金额与条件没有遗漏','解释没有修改事实或合同','初稿与已确认事实一致']},
 {id:'blank-parties',split:'holdout',description:'双方名称留空',messages:['甲乙双方名称留空，职责照常写清。'],criteria:['姓名留空不阻塞起草','各方义务仍能区分','未编造主体名称']},
 {id:'local-revision',split:'holdout',description:'连续局部修改',messages:['先按约定起草。'],revision:'只把第二条表述写得简洁些，其他约定和措辞保持不变。',criteria:['修改回应了本轮要求','未修改无关条款','付款及其他关联约定保留']},
 {id:'material-conflict',split:'holdout',description:'材料分歧与用户取舍',messages:['两份报价金额不同，请指出出处，先不要自行选择。','采用总价8000元，另一份报价不采用。'],materials:materialFixtures,criteria:['逐字指出两份报价的不同金额和出处','未经选择不将一份报价当成已定事实','选择后起草采用8000元且不保留9000元']},
 {id:'goal-coverage',split:'development',description:'核心诉求与立场',messages:['我代表乙方，最担心收不到尾款。'],criteria:['诉求与双方事实区分','说明诉求如何落实及剩余问题','未为了保护一方编造对方承诺']},
].map((c)=>{const facts=intakeFixture();if(c.id==='blank-parties'){delete facts.facts.partyA;delete facts.facts.partyB;}const entries=Object.values(facts.facts).map(f=>f.quote),half=Math.ceil(entries.length/2);return {...c,messages:c.messages.map((message,n)=>(c.id==='material-conflict'?(n===0?Object.entries(facts.facts).filter(([id])=>id!=='price').map(([,f])=>f.quote):[facts.facts.price.quote]):c.messages.length>1?(n===0?entries.slice(0,half):entries.slice(half)):entries).join('。')+'。'+message)};}) as TaskCase[];
const save=async(path:string,value:unknown)=>writeFile(path,JSON.stringify(value,null,2),{mode:0o600,flag:'wx'});
async function execute(c:TaskCase,env:Record<string,string|undefined>,dir:string):Promise<TaskRun['results'][number]>{
 const user:User={id:randomUUID(),name:'合成客户',email:'synthetic@example.test',role:'client'},started=Date.now();
 let contract:Contract={id:randomUUID(),ownerId:user.id,ownerName:user.name,title:c.description,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),versions:[],messages:[],reviews:[]},revision=0,modelCalls=0,transcript:string|null=null;
 const store:WorkflowStore={loadMaterials:async()=>c.materials||[],agentSessions:true,environment:{...env,CONTRACT_PI_SESSION_DIR:dir},limit:async()=>{},onModelCall:async()=>{modelCalls++;},sessionCheckpoint:()=>({load:async()=>transcript,save:async v=>{transcript=v;}}),load:async()=>({contract:structuredClone(contract),revision}),save:async(next,expected)=>{if(expected!==revision)throw new Error('版本冲突');contract=structuredClone(next);revision++;return structuredClone(contract);},put:async(key,content)=>{const bytes=await renderContract(content);await writeFile(join(dir,key.split('/').at(-1)!),bytes,{mode:0o600});return createHash('sha256').update(bytes).digest('hex');}};
 const automatic:{name:string;passed:boolean}[]=[];
 const finish=async()=>{for(let n=0;n<15;n++){const j=contract.workflow!.job!;if(j.status==='completed')return;if(j.status==='failed')throw new Error(j.code||'任务失败');await controlWorkflow(store,user,j.id,'run');}throw new Error('任务未在限定阶段内结束');};
 const chat=async(message:string)=>{await startWorkflow(store,user,{requestId:randomUUID(),message});await finish();};
 const confirm=async()=>{if(!contract.workflow?.intake)throw new Error('未形成交易摘要');await startWorkflow(store,user,{requestId:randomUUID(),confirmId:contract.workflow.intake.summaryId});await finish();};
 try{
  for(let n=0;n<c.messages.length;n++){await chat(c.messages[n]);if(c.id==='material-conflict'&&n===0)automatic.push({name:'分歧附带两个材料出处',passed:contract.workflow?.intake?.materialConflicts?.[0]?.alternatives.length===2});}
  if(c.id==='material-conflict')automatic.push({name:'用户取舍后清除待定分歧',passed:contract.workflow?.intake?.materialConflicts?.length===0});
  await confirm();automatic.push({name:'Word 已生成且可送审',passed:!reviewVersionProblem(contract,contract.versions.at(-1))});
  if(c.question){const before=digest([contract.workflow!.intake,contract.versions]);await chat(c.question);automatic.push({name:'只读问答保持确认与版本',passed:before===digest([contract.workflow!.intake,contract.versions])});}
  if(c.revision){const before=structuredClone(contract.versions.at(-1)!.content!);await chat(c.revision);await confirm();const after=contract.versions.at(-1)!.content!;automatic.push({name:'保留未要求修改的条款',passed:digest(before.sections.filter((_,n)=>n!==1))===digest(after.sections.filter((_,n)=>n!==1))});}
  if(c.id==='blank-parties')automatic.push({name:'主体名称保持空白',passed:contract.versions.at(-1)!.content!.parties.every(p=>!p.name)});
  return {id:c.id,status:'completed',durationMs:Date.now()-started,modelCalls,contract,artifactHash:digest(contract),automatic};
 }catch(error){return {id:c.id,status:'failed',error:error instanceof Error?error.message:'任务未完成',durationMs:Date.now()-started,modelCalls,contract,artifactHash:digest(contract),automatic};}
}
async function main(){
 const [mode='--replay',path='.data/qa/task-eval-'+Date.now(),reviewPath]=process.argv.slice(2);
 if(mode==='--score'){
  const bundle=JSON.parse(await readFile(path,'utf8')),cases=taskCaseSchema.array().parse(bundle.cases),run=taskRunSchema.parse(bundle.run),review=taskReviewSchema.parse(JSON.parse(await readFile(reviewPath,'utf8')));
  const report=scoreTaskRun(cases,run,review);console.log(JSON.stringify(report));if(!report.holdout.targetMet)process.exitCode=1;return;
 }
 if(!['--replay','--live'].includes(mode))throw new Error('使用 --replay [输出目录] 或显式 --live [输出目录]；--score run.json review.json 不调用模型');
 const datasetPath=process.env.CONTRACT_EVAL_DATASET;if(datasetPath&&mode==='--replay')throw new Error('外部评估集仅用于显式 --live；本地替身仅识别内置合成样本');
 const dataset=datasetPath?taskCaseSchema.array().parse(JSON.parse(await readFile(datasetPath,'utf8'))):taskCases;
 const chosen=process.env.CONTRACT_EVAL_CASES?.split(',').filter(Boolean),cases=dataset.filter(c=>!chosen||chosen.includes(c.id));if(!cases.length||new Set(cases.map(c=>c.id)).size!==cases.length||chosen?.some(id=>!dataset.some(c=>c.id===id)))throw new Error('样本选择无效');
 const dir=resolve(path);await mkdir(dir,{recursive:false,mode:0o700});let current:TaskCase;
 const provider=createServer(async(req,res)=>{try{
  let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw),names=body.tools?.map((t:any)=>t.function.name)||[],history=JSON.stringify(body.messages);
  const blank=current.id==='blank-parties',intake=intakeFixture(),content=contentFixture();if(blank){delete intake.facts.partyA;delete intake.facts.partyB;delete content.confirmation!.facts.partyA;delete content.confirmation!.facts.partyB;content.parties.forEach(p=>{p.name='';});content.sections[0].content=Object.values(intake.facts).map(f=>f.quote).join('。');}
  const tool=names.includes('update_contract_spec')?'update_contract_spec':names.includes('submit_consistency_check')?'submit_consistency_check':names.includes('apply_contract_patch')?'apply_contract_patch':'submit_contract_draft';
  const latest=body.messages.filter((m:any)=>m.role==='user'&&!String(m.content).startsWith('根据以上')&&!String(m.content).startsWith('当前已保存')).at(-1)?.content||'';
  const respond=(name:string,result:unknown)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{tool_calls:[{id:randomUUID(),type:'function',function:{name,arguments:JSON.stringify(result)}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:100,completion_tokens:100}}));};
  if(tool==='update_contract_spec'&&current.materials){const unread=current.materials.find(m=>!body.messages.some((message:any)=>message.role==='tool'&&String(message.content).includes(m.id)));if(unread){respond('read_contract_material',{materialId:unread.id});return;}}
  let result:any;
  if(tool==='update_contract_spec')result=current.question&&latest===current.question?{action:'answer',reply:'尾款按已确认的验收节点支付，原约定保持不变。'}:{action:'update',templateId:'software',facts:Object.entries(intake.facts).filter(([,f])=>history.includes(f.quote)).map(([fieldId,f])=>({fieldId,...f})),...(blank?{participants:[{factId:'partyA',role:'甲方',name:''},{factId:'partyB',role:'乙方',name:''}]}:{}),businessChecks:['scope','price','payment','term'].map(fieldId=>history.includes(intake.facts[fieldId].quote)?{fieldId,status:'answered',evidence:[intake.facts[fieldId].quote]}:{fieldId,status:'missing',question:'请补充'+fieldId}),...(current.id==='goal-coverage'?{intent:{goal:{value:'保障尾款收取',quote:current.messages[0]},stance:{value:'乙方',quote:current.messages[0]}}}:{})};
  else if(tool==='submit_consistency_check')result={verdict:'consistent',issues:[]};
  else if(tool==='apply_contract_patch'){const payload=JSON.parse(body.messages.filter((m:any)=>m.role==='user').at(-1).content);result={baseSha256:payload.baseSha256,changes:[{op:'replace',target:'section',index:1,part:{...payload.draft.sections[1],content:'双方按上述约定履行。'},reason:'简化第二条表达'}]};}
  else result=content;
  if(tool==='update_contract_spec'&&current.id==='material-conflict'){if(String(latest).includes('另一份报价不采用'))result.resolvedMaterialConflicts=[{topic:'总价',quote:'采用总价8000元，另一份报价不采用。'}];else {result.facts=result.facts.filter((f:any)=>f.fieldId!=='price');result.materialConflicts=[{topic:'总价',question:'本次采用哪份报价？',alternatives:current.materials!.map(m=>({materialId:m.id,sha256:m.sha256,chunkId:m.chunks[0].id,quote:m.chunks[0].text}))}];}}
  respond(tool,{result});
 }catch{res.writeHead(500);res.end();}});
 try{
  if(mode==='--replay')await new Promise<void>(r=>provider.listen(0,'127.0.0.1',r));
  const env=mode==='--replay'?{...process.env,CONTRACT_AI_API_KEY:'local-fixture',CONTRACT_AI_BASE_URL:'http://127.0.0.1:'+(provider.address() as {port:number}).port,CONTRACT_LEGAL_SEARCH_API_KEY:'',TAVILY_API_KEY:''}:process.env;
  const results:TaskRun['results']=[];
  for(current of cases){const caseDir=join(dir,current.id);await mkdir(caseDir,{mode:0o700});results.push(await execute(current,env,caseDir));await save(join(caseDir,'result.json'),results.at(-1));}
  const sources=await Promise.all(['src/server/workflow.ts','src/server/ai.ts','src/server/agent/runtime.ts','src/server/agent/prompt.ts','src/server/agent/legal-skills.generated.json','src/lib/transaction-update.ts','src/lib/task-budget.ts','src/server/agent/transport.ts','src/server/agent/legal-search.ts','src/lib/materials.ts','src/server/material-parser.ts'].map(p=>readFile(p,'utf8')));
  const run:TaskRun={version:1,mode:mode==='--live'?'live':'replay',createdAt:new Date().toISOString(),caseHash:digest(cases),configurationHash:digest([sources,env.CONTRACT_AI_MODEL||env.OPENAI_MODEL,env.CONTRACT_AI_THINKING,env.CONTRACT_AI_REASONING_EFFORT,env.CONTRACT_TASK_MAX_TOKENS,env.CONTRACT_TASK_MAX_MODEL_CALLS,env.CONTRACT_TASK_MAX_DURATION_MS]),results};
  await save(join(dir,'run.json'),{cases,run});await save(join(dir,'review.json'),{runHash:digest(run),reviewer:'',results:cases.map(c=>({id:c.id,criteria:c.criteria.map((_,index)=>({index,verdict:'uncertain',reason:'待人工对照完整对话和合同评审'}))}))});
  console.log(JSON.stringify({mode:run.mode,cases:results.length,completed:results.filter(r=>r.status==='completed').length,modelCalls:results.reduce((n,r)=>n+r.modelCalls,0),qualityPassRate:null,output:dir}));if(results.some(r=>r.status==='failed'||r.automatic.some(a=>!a.passed)))process.exitCode=1;
 }finally{if(mode==='--replay')await new Promise<void>(r=>provider.close(()=>r()));}
}
if(process.argv[1]?.endsWith('eval-tasks.ts'))main().catch(e=>{console.error(e.message);process.exitCode=1;});
