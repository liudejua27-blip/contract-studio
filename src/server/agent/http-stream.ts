import type {Contract} from '../../lib/types';
import type {AgentEventSink} from '../../lib/agent-stream';
export function agentStreamResponse(run:(emit:AgentEventSink)=>Promise<Contract>){
 const encoder=new TextEncoder();let closed=false;
 const stream=new ReadableStream<Uint8Array>({start(controller){
  const emit:AgentEventSink=event=>{if(!closed)controller.enqueue(encoder.encode('data: '+JSON.stringify(event)+'\n\n'));};
  const timer=setInterval(()=>{if(!closed)controller.enqueue(encoder.encode(': keepalive\n\n'));},10000);
  void run(emit).then(contract=>emit({type:'result',contract})).catch(()=>emit({type:'error',message:'处理连接中断，已保存的信息可重新加载后继续。'})).finally(()=>{clearInterval(timer);if(!closed){closed=true;controller.close();}});
 },cancel(){closed=true;}});
 return new Response(stream,{headers:{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-store, no-transform','X-Accel-Buffering':'no'}});
}
