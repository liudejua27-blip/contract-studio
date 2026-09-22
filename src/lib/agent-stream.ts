import type {Contract} from './types';
export type AgentStreamEvent={type:'job';job:import('./types').GenerationJob}|{type:'activity';label:string}|{type:'preview';text:string}|{type:'preview_delta';text:string;replace:boolean}|{type:'result';contract:Contract}|{type:'error';message:string};
export type AgentEventSink=(event:AgentStreamEvent)=>void;
/** SSE framing shared by model transport and browser, including split UTF-8 and CRLF. */
export async function* sseData(body:ReadableStream<Uint8Array>){
 const reader=body.getReader(),decoder=new TextDecoder();let buffer='';
 try{while(true){const {done,value}=await reader.read();buffer+=done?decoder.decode():decoder.decode(value,{stream:true});
  let end:number;while((end=buffer.search(/\r?\n\r?\n/))>=0){const match=buffer.slice(end).match(/^\r?\n\r?\n/)![0];const frame=buffer.slice(0,end);buffer=buffer.slice(end+match.length);const data=frame.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).replace(/^ /,'')).join('\n');if(data)yield data;}
  if(buffer.length>1000000)throw new Error('流式消息超过限制');if(done)break;
 }}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
/** Read only public JSON paths, including unfinished strings. Never publish evidence or tool metadata. */
export function publicPreview(json:string,stage:'intake'|'draft'|'verify'){
 if(stage==='verify')return '';
 let pos=0;const texts:string[]=[];
 const space=()=>{while(/\s/.test(json[pos]||'')&&pos<json.length)pos++;};
 const string=()=>{
  const start=++pos;let escaped=false;
  while(pos<json.length){const c=json[pos++];if(!escaped&&c==='"')return {raw:json.slice(start,pos-1),complete:true};if(!escaped&&c==='\\')escaped=true;else escaped=false;}
  return {raw:json.slice(start),complete:false};
 };
 const allowed=(path:(string|number)[])=>{
  let p=path[0]==='result'?path.slice(1):path;
  // A targeted revision streams only the public replacement text, never edit reasons or fingerprints.
  if(stage==='draft'&&p[0]==='changes'&&typeof p[1]==='number'&&p[2]==='part')p=['sections',p[1],...p.slice(3)];
  if(stage==='draft'&&p.length===2&&p[0]==='header'&&p[1]==='title')p=['title'];
  return stage==='intake'?p.length===1&&p[0]==='reply':
   p.length===1&&p[0]==='title'||['sections','attachments'].includes(String(p[0]))&&typeof p[1]==='number'&&(
    p.length===3&&['title','content'].includes(String(p[2]))||p[2]==='blocks'&&typeof p[3]==='number'&&(
     p.length===5&&p[4]==='text'||p.length===6&&['items','columns'].includes(String(p[4]))&&typeof p[5]==='number'||p.length===7&&p[4]==='rows'&&typeof p[5]==='number'&&typeof p[6]==='number'));

 };
 const value=(path:(string|number)[],depth:number):void=>{
  if(depth>30)return;space();const c=json[pos];
  if(c==='"'){
   const token=string();if(!allowed(path))return;
   const raw=token.complete?token.raw:token.raw.replace(/\\(?:u[0-9a-fA-F]{0,3})?$/,'');
   try{const text=JSON.parse('"'+raw+'"') as string;texts.push(text.replace(/[\uD800-\uDBFF]$/,''));}catch{}return;
  }
  if(c==='{'){
   pos++;space();while(pos<json.length&&json[pos]!=='}'){
    if(json[pos]!=='"')return;const key=string();if(!key.complete)return;space();if(json[pos++]!==':')return;
    let name:string;try{name=JSON.parse('"'+key.raw+'"');}catch{return;}
    value([...path,name],depth+1);space();if(json[pos]!==',')break;pos++;space();
   }if(json[pos]==='}')pos++;return;
  }
  if(c==='['){pos++;space();let i=0;while(pos<json.length&&json[pos]!==']'){const before=pos;value([...path,i++],depth+1);if(pos===before)return;space();if(json[pos]!==',')break;pos++;space();}if(json[pos]===']')pos++;return;}
  while(pos<json.length&&!/[\s,}\]]/.test(json[pos]))pos++;
 };
 value([],0);return texts.join('\n\n');
}
