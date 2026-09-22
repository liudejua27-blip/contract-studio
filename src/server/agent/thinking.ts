/** Pi's public levels mapped to the effort levels supported by DeepSeek. */
export type ContractThinkingLevel='off'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max';
export function configuredThinking(env:Record<string,string|undefined>):ContractThinkingLevel{
 if(['off','disabled'].includes(env.CONTRACT_AI_THINKING||''))return 'off';
 const level=env.CONTRACT_AI_REASONING_EFFORT||'high';
 if(['minimal','low','medium','high','xhigh','max'].includes(level))return level as ContractThinkingLevel;
 throw new Error('CONTRACT_AI_REASONING_EFFORT must be a supported Pi thinking level');
}
export function thinkingParameters(baseUrl:string,env:Record<string,string|undefined>,level:ContractThinkingLevel=configuredThinking(env)){
 if(new URL(baseUrl).hostname!=='api.deepseek.com')return {temperature:0.2};
 if(level==='off')return {thinking:{type:'disabled' as const},temperature:0.2};
 const effort=level==='max'?'max':['minimal','low'].includes(level)?'low':'high';
 return {thinking:{type:'enabled' as const},reasoning_effort:effort};
}
