import type {ZodType} from 'zod';
import type {AgentEventSink} from '../../lib/agent-stream';
import type {Message,Intake} from '../../lib/types';

export type Environment=Record<string,string|undefined>;
export type AgentTrace={runtime:'pi-sdk'|'pi-core';turns:number;tools:string[];legalResearch?:import('../../lib/legal-research').LegalSearch[];skillReads?:import('../../lib/skill-audit').SkillReceipt[];resumed?:boolean;compactions?:number};
export interface AgentSessionCheckpoint {load():Promise<string|null>;save(transcript:string):Promise<void>}
/** Constructed only after contract ownership checks. Never accept this from the browser. */
export interface AgentRunContext {
 ephemeral?:boolean;
 budget?:import('../../lib/task-budget').ModelBudgetGate;
 clausePreferences?:import('../../lib/review-learning').ClausePreference[];
 materials?:import('../../lib/materials').MaterialDocument[];
 legalResearch?:import('../../lib/legal-research').LegalSearch[];
 ownerId:string;
 contractId:string;
 requestId:string;
 completionAttempt?:number;
 history:Message[];
 transaction?:Intake;
 checkpoint?:AgentSessionCheckpoint;
 onModelCall?:(call:import('../operations').ModelCall)=>Promise<void>;
 onRateLimit?:(retryAfterMs:number)=>Promise<void>;
 /** Rechecks the workflow lease while the model is running (cancel/ownership changes). */
 isCurrent?:()=>Promise<boolean>;
}
export interface StructuredAgentInput<T> {
 transaction?:Intake;
 incremental?:boolean;
 prompt:string;
 messages:Array<{role:'user'|'assistant';content:string}>;
 schema:ZodType<T,any,any>;
 toolName:string;
 environment?:Environment;
 rules?:unknown;
 onEvent?:AgentEventSink;
 stage?:'intake'|'draft'|'verify';
 validate?:(value:T)=>void;
 context?:AgentRunContext;
}
export class AgentFailure extends Error {
 constructor(public code:string,message:string){super(message);}
}
