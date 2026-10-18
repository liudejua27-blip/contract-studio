import {query} from './db';
import {schedulerMetrics} from './worker-scheduler';
export type ModelCall={model:string;stage:string;status:string;durationMs:number;inputTokens:number|null;outputTokens:number|null};
export async function recordModelCall(call:ModelCall):Promise<void>{
 await query(`INSERT INTO model_calls(model,stage,status,duration_ms,input_tokens,output_tokens) VALUES($1,$2,$3,$4,$5,$6)`,[call.model,call.stage,call.status,call.durationMs,call.inputTokens,call.outputTokens]);
}
export async function operationsReport(){
 const [queue,model,reviews,tasks]=await Promise.all([schedulerMetrics(),query<{calls:number;failures:number;unknown_usage:number;input_tokens:number;output_tokens:number}>(`SELECT count(*)::int AS calls,
 count(*) FILTER(WHERE status<>'ok')::int AS failures,
 count(*) FILTER(WHERE input_tokens IS NULL OR output_tokens IS NULL)::int AS unknown_usage,
 COALESCE(sum(input_tokens),0)::float AS input_tokens, COALESCE(sum(output_tokens),0)::float AS output_tokens
 FROM model_calls WHERE created_at>now()-interval '24 hours'`),query(`SELECT count(*) FILTER(WHERE status='need_info')::int AS need_info,
 count(*) FILTER(WHERE status IN ('waiting','reviewing') AND submitted_at<now()-interval '48 hours')::int AS overdue,
 count(*) FILTER(WHERE status='completed' AND completed_at>now()-interval '24 hours')::int AS delivered FROM reviews`),query<{id:string;title:string;job_id:string;status:string;budget:import('../lib/task-budget').TaskBudget}>(`SELECT id,title,workflow->'job'->>'id' AS job_id,workflow->'job'->>'status' AS status,workflow->'job'->'budget' AS budget FROM contracts WHERE jsonb_typeof(workflow->'job'->'budget')='object' ORDER BY updated_at DESC LIMIT 20`)]);
 const m=model.rows[0],r=reviews.rows[0];
 const price=(value:string|undefined)=>value?.trim()?Number(value):NaN;
 const inputPrice=price(process.env.CONTRACT_MODEL_INPUT_PRICE_PER_MILLION),outputPrice=price(process.env.CONTRACT_MODEL_OUTPUT_PRICE_PER_MILLION);
 const estimatedCost=Number.isFinite(inputPrice)&&inputPrice>=0&&Number.isFinite(outputPrice)&&outputPrice>=0 ? (m.input_tokens*inputPrice+m.output_tokens*outputPrice)/1e6 : null;
 const alerts:string[]=[];
 if(queue.oldest_wait_seconds>Number(process.env.CONTRACT_ALERT_QUEUE_SECONDS||120))alerts.push('排队时间超过阈值');
 if(queue.pending>0&&queue.workers===0)alerts.push('有等待任务但尚无执行租约，请检查 worker');
 if(m.calls>=5&&m.failures/m.calls>Number(process.env.CONTRACT_ALERT_FAILURE_RATIO||0.2))alerts.push('近 24 小时模型调用失败率超过阈值');
 if(m.unknown_usage)alerts.push('部分模型请求未报告用量，费用估算不完整');
 if(estimatedCost!==null&&estimatedCost>Number(process.env.CONTRACT_ALERT_DAILY_COST||100))alerts.push('模型估算费用超过每日阈值');
 if(r.overdue)alerts.push('有超过 48 小时的律师审核任务');
 if(r.need_info)alerts.push('有等待用户补充信息的审核任务');
 return {tasks:tasks.rows,queue,model:{...m,estimatedCost,priceUnit:'operator-configured currency',costComplete:m.unknown_usage===0&&estimatedCost!==null},reviews:r,alerts};
}
