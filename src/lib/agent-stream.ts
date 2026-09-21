import type {Contract} from './types';
export type AgentStreamEvent={type:'activity';label:string}|{type:'preview';text:string}|{type:'result';contract:Contract}|{type:'error';message:string};
export type AgentEventSink=(event:AgentStreamEvent)=>void;
/** SSE framing shared by model transport and browser, including split UTF-8 and CRLF. */
export async function* sseData(body:ReadableStream<Uint8Array>){
 const reader=body.getReader(),decoder=new TextDecoder();let buffer='';
 try{while(true){const {done,value}=await reader.read();buffer+=done?decoder.decode():decoder.decode(value,{stream:true});
  let end:number;while((end=buffer.search(/\r?\n\r?\n/))>=0){const match=buffer.slice(end).match(/^\r?\n\r?\n/)![0];const frame=buffer.slice(0,end);buffer=buffer.slice(end+match.length);const data=frame.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).replace(/^ /,'')).join('\n');if(data)yield data;}
  if(buffer.length>1000000)throw new Error('流式消息超过限制');if(done)break;
 }}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
/** Only allow public draft strings; never emit tool arguments, evidence, or reasoning. */
export function publicPreview(json:string,stage:'intake'|'draft'|'verify'){
 if(stage==='verify')return '';
 const keys=stage==='intake'?'reply':'title|content';
 const re=new RegExp('"(?:'+keys+')"\\s*:\\s*"((?:[^"\\\\]|\\\\[\\s\\S])*)("|$)','g');
 const texts:string[]=[];for(const m of json.matchAll(re)){let raw=m[1];if(m[2]!=='"')raw=raw.replace(/\\(?:u[0-9a-fA-F]{0,3})?$/,'');try{texts.push(JSON.parse('"'+raw+'"'))}catch{}}
 return texts.join('\n\n').slice(0,24000);
}
