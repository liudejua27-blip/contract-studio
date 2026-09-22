import {sseData,publicPreview,type AgentEventSink} from '../../lib/agent-stream';
export async function readModelResponse(response:Response,stage:'intake'|'draft'|'verify',emit?:AgentEventSink){
 if(!response.headers.get('content-type')?.includes('text/event-stream'))return response.json();
 if(!response.body)throw new Error('Missing response stream');
 const calls=new Map<number,{id:string;type:string;function:{name:string;arguments:string}}>();let content='',reasoning='',finish:string|undefined,usage:unknown,last='',lastAt=0;
 for await(const data of sseData(response.body)){
  if(data==='[DONE]')break;const item=JSON.parse(data);if(item.error)throw new Error('Model stream failed');if(item.usage)usage=item.usage;
  const choice=item.choices?.[0];if(!choice)continue;if(choice.finish_reason)finish=choice.finish_reason;
  const delta=choice.delta||{};if(typeof delta.reasoning_content==='string')reasoning+=delta.reasoning_content;if(typeof delta.content==='string')content+=delta.content;
  for(const tc of delta.tool_calls||[]){const index=tc.index??0;const c=calls.get(index)||{id:'',type:'function',function:{name:'',arguments:''}};if(tc.id)c.id=tc.id;if(tc.function?.name)c.function.name+=tc.function.name;if(tc.function?.arguments)c.function.arguments+=tc.function.arguments;if(c.function.arguments.length>200000)throw new Error('Model output too large');calls.set(index,c);}
  // Skill/rule tool arguments are never user-visible.
  const terminal=[...calls.values()].find(c=>['update_contract_spec','submit_contract_draft','apply_contract_patch'].includes(c.function.name));
  if(Date.now()-lastAt>=80){lastAt=Date.now();const text=publicPreview(terminal?.function.arguments||content,stage);if(text!==last){last=text;if(text)emit?.({type:'preview',text});}}
 }
 const terminal=[...calls.values()].find(c=>['update_contract_spec','submit_contract_draft','apply_contract_patch'].includes(c.function.name));
 const finalPreview=publicPreview(terminal?.function.arguments||content,stage);
 if(finish&&finalPreview!==last&&finalPreview)emit?.({type:'preview',text:finalPreview});
 if(!finish)throw new Error('Incomplete model stream');
 return {choices:[{finish_reason:finish,message:{content,reasoning_content:reasoning,tool_calls:[...calls.values()]}}],usage};
}
