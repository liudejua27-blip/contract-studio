import {sseData,type AgentStreamEvent,type AgentEventSink} from './agent-stream';
import type {Contract} from './types';
export async function streamJob(path:string,onEvent:AgentEventSink,signal?:AbortSignal):Promise<Contract>{
 const subscribe=path.endsWith('/events');
 const response=await fetch('/api/'+path,{signal,method:subscribe?'GET':'POST',credentials:'same-origin',headers:{'content-type':'application/json','accept':'text/event-stream'},...(subscribe?{}:{body:'{}'})});
 if(!response.ok)throw new Error('任务连接未能建立，请重新加载后重试。');
 if(!response.headers.get('content-type')?.includes('text/event-stream')){const value=await response.json() as {data?:Contract};if(!value.data)throw new Error('任务未返回结果');return value.data;}
 if(!response.body)throw new Error('任务连接已中断');
 let result:Contract|undefined;
 for await(const data of sseData(response.body)){const event=JSON.parse(data) as AgentStreamEvent;if(event.type==='error')throw new Error(event.message);if(event.type==='result')result=event.contract;else onEvent(event);}
 if(!result)throw new Error('任务连接中断，正在重新加载已保存的进度。');return result;
}
