import type {ZodType} from 'zod';
import type {AgentEventSink} from '../../lib/agent-stream';
import type {Message,Intake} from '../../lib/types';

export type Environment=Record<string,string|undefined>;
export type AgentTrace={runtime:'pi-sdk'|'pi-core';turns:number;tools:string[];skillReads?:import('../../lib/skill-audit').SkillReceipt[];resumed?:boolean;compactions?:number};
/** Constructed only after contract ownership checks. Never accept this from the browser. */
export interface AgentRunContext {
 ownerId:string;
 contractId:string;
 requestId:string;
 history:Message[];
 transaction?:Intake;
 /** Rechecks the workflow lease while the model is running (cancel/ownership changes). */
 isCurrent?:()=>Promise<boolean>;
}
export interface StructuredAgentInput<T> {
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
