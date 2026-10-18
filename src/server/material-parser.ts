import {ocrPdfPages,type OcrResult} from './material-ocr';
import {Worker} from 'node:worker_threads';
import {extractDocxText} from './documents';
import type {MaterialChunk,MaterialInfo} from '../lib/materials';
import {AppError} from './db';
export const MAX_MATERIAL_BYTES=10*1024*1024;
const MAX_TEXT=200000;
type Extraction={chunks:MaterialChunk[];status:MaterialInfo['status'];warnings:string[]};
let activePdfWorkers=0;
function chunksFor(text:string,label:string,prefix:string):MaterialChunk[]{
 const chunks:MaterialChunk[]=[];for(let n=0;n<text.length;n+=3000)chunks.push({id:prefix+'-'+(chunks.length+1),location:label+' · 片段'+(chunks.length+1),text:text.slice(n,n+3000)});return chunks;
}
// A separate bounded worker keeps malformed/expensive PDFs off the web request event loop.
async function pdfPages(bytes:Buffer):Promise<string[]>{
 if(activePdfWorkers>=2)throw new AppError(503,'当前正在读取其他PDF，请稍后重试上传。','MATERIAL_BUSY');
 activePdfWorkers++;
 try{return await new Promise<string[]>((resolve,reject)=>{
  const worker=new Worker(`const {parentPort,workerData}=require('node:worker_threads');
   (async()=>{const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');const task=getDocument({data:new Uint8Array(workerData.bytes),isEvalSupported:false,useSystemFonts:false,disableFontFace:true,verbosity:0});
   try{const doc=await task.promise;if(doc.numPages>100)throw new Error('too_many_pages');const pages=[];let total=0;
   for(let n=1;n<=doc.numPages;n++){const page=await doc.getPage(n);const data=await page.getTextContent();const text=data.items.map(x=>x.str?x.str+(x.hasEOL?'\\n':' '):'').join('').trim();total+=text.length;if(total>200000)throw new Error('too_much_text');pages.push(text);page.cleanup();}
   parentPort.postMessage({pages});}finally{await task.destroy();}})().catch(()=>parentPort.postMessage({error:true}));`,{eval:true,workerData:{bytes},resourceLimits:{maxOldGenerationSizeMb:128}});
  const timer=setTimeout(()=>finish(new Error('timeout')),15000);let finished=false;
  function finish(error?:Error,pages?:string[]){if(finished)return;finished=true;clearTimeout(timer);void worker.terminate();error?reject(error):resolve(pages!);}
  worker.once('message',v=>v.error?finish(new Error('parse_failed')):finish(undefined,v.pages));worker.once('error',e=>finish(e));worker.once('exit',()=>{if(!finished)finish(new Error('worker_exit'));});
 });}finally{activePdfWorkers--;}
}
export async function extractMaterial(name:string,bytes:Buffer,ocr:(bytes:Buffer,pages:number[])=>Promise<OcrResult>=ocrPdfPages):Promise<Extraction>{
 if(!bytes.length||bytes.length>MAX_MATERIAL_BYTES)throw new AppError(413,'材料须为非空文件，且不超过10 MB。','MATERIAL_SIZE');
 const ext=name.toLowerCase().split('.').at(-1);
 try{
  if(ext==='pdf'){
   if(bytes.subarray(0,5).toString()!=='%PDF-')throw new Error('invalid_pdf');
   const pages=await pdfPages(bytes),empty=pages.map((p,i)=>!p.trim()?i+1:0).filter(Boolean);
   const result=empty.length?await ocr(bytes,empty):{pages:new Map<number,string>(),warnings:[]};
   for(const [page,text] of result.pages)if(empty.includes(page))pages[page-1]=text;
   if(pages.join('').length>MAX_TEXT)throw new Error('too_much_text');
   const unread=pages.map((p,i)=>!p.trim()?i+1:0).filter(Boolean);
   const chunks=pages.flatMap((p,i)=>chunksFor(p,'第'+(i+1)+'页'+(result.pages.has(i+1)?'（OCR，需核对）':''),'page'+(i+1)));
   return {chunks,status:chunks.length?unread.length||result.pages.size?'partial':'ready':'needs_ocr',warnings:[...result.warnings,...(unread.length?[`第 ${unread.join('、')} 页未读取到文字，可能是扫描页或空白页；不能声称已读完整份文件。`]:[]),'按PDF文字层与已标记OCR页读取，复杂表格和阅读顺序请对照原件核对；有文字页中的图片文字不保证识别。']};
  }
  let text='';const warnings:string[]=[];
  if(ext==='docx'){text=extractDocxText(bytes,{maxTextChars:MAX_TEXT});warnings.push('读取正文及表格文字，不含图片、批注、页眉页脚；如有修订痕迹，请先核对采用的版本。');}
  else if(ext==='txt'||ext==='md'){text=new TextDecoder('utf-8',{fatal:true}).decode(bytes).trim();if(text.includes('\0'))throw new Error('binary');}
  else throw new AppError(400,'支持 DOCX、PDF、UTF-8 TXT 或 Markdown；旧版 DOC 请先另存为 DOCX。','MATERIAL_TYPE');
  if(text.length>MAX_TEXT)throw new Error('too_much_text');
  return {chunks:chunksFor(text,'正文','text'),status:text?'ready':'needs_ocr',warnings:text?warnings:[...warnings,'未读取到正文，请提供文字版材料。']};
 }catch(e){if(e instanceof AppError)throw e;throw new AppError(422,'材料读取失败。请检查文件是否加密或损坏，PDF不超过100页，正文不超过20万字。','MATERIAL_READ_FAILED');}
}
