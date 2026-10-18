export type BudgetPolicy={maxTokens:number;maxCalls:number;maxDurationMs:number};
export type TaskBudget={policy:BudgetPolicy;startedAt:number;calls:number;accountedTokens:number;inputTokens:number;outputTokens:number;unknownCalls:number;modelMs:number;pending?:{id:string;inputTokens:number;outputTokens:number}};
export type BudgetCall={durationMs:number;inputTokens:number|null;outputTokens:number|null};
export type CallReservation={id:string;maxOutputTokens:number;timeoutMs:number};
export interface ModelBudgetGate {reserve(inputTokens:number,outputTokens:number):Promise<CallReservation>;settle(reservation:CallReservation,call:BudgetCall):Promise<void>}
export class TaskBudgetError extends Error {code='AI_TASK_BUDGET_EXCEEDED';constructor(message='本次任务已达到处理预算，已有信息和原稿已保存。'){super(message);}}
const positive=(value:string|undefined,fallback:number)=>{const n=Number(value);return Number.isSafeInteger(n)&&n>0?n:fallback;};
export function createTaskBudget(env:Record<string,string|undefined>,now=Date.now()):TaskBudget{
 return {policy:{maxTokens:positive(env.CONTRACT_TASK_MAX_TOKENS,2000000),maxCalls:positive(env.CONTRACT_TASK_MAX_MODEL_CALLS,36),maxDurationMs:positive(env.CONTRACT_TASK_MAX_DURATION_MS,900000)},startedAt:now,calls:0,accountedTokens:0,inputTokens:0,outputTokens:0,unknownCalls:0,modelMs:0};
}
/** Reserve before network I/O. A crashed call stays charged at its reservation on recovery. */
export function reserveBudgetCall(budget:TaskBudget,inputTokens:number,outputTokens:number,now=Date.now()):CallReservation{
 if(budget.pending){budget.unknownCalls++;delete budget.pending;}
 const timeoutMs=budget.policy.maxDurationMs-(now-budget.startedAt),remaining=budget.policy.maxTokens-budget.accountedTokens;
 const allowed=Math.min(outputTokens,remaining-inputTokens);
 if(timeoutMs<=0||budget.calls>=budget.policy.maxCalls||allowed<1)throw new TaskBudgetError();
 const id=crypto.randomUUID();budget.calls++;budget.accountedTokens+=inputTokens+allowed;budget.pending={id,inputTokens,outputTokens:allowed};
 return {id,maxOutputTokens:allowed,timeoutMs};
}
export function settleBudgetCall(budget:TaskBudget,reservation:CallReservation,call:BudgetCall){
 const pending=budget.pending;if(!pending||pending.id!==reservation.id)throw new Error('Budget reservation changed');
 const known=(n:number|null)=>n!==null&&Number.isSafeInteger(n)&&n>=0;
 const input=known(call.inputTokens)?call.inputTokens!:pending.inputTokens,output=known(call.outputTokens)?call.outputTokens!:pending.outputTokens;
 budget.accountedTokens+=input+output-pending.inputTokens-pending.outputTokens;
 budget.inputTokens+=known(call.inputTokens)?call.inputTokens!:0;budget.outputTokens+=known(call.outputTokens)?call.outputTokens!:0;
 if(!known(call.inputTokens)||!known(call.outputTokens))budget.unknownCalls++;
 budget.modelMs+=Math.max(0,call.durationMs);delete budget.pending;
}
/** A conservative accounting estimate, not a tokenizer or a provider billing guarantee. */
export function estimateInputTokens(value:unknown){return new TextEncoder().encode(JSON.stringify(value)).length+256;}
