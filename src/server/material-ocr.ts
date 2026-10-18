import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const exec=promisify(execFile);
let active=0;
export type OcrResult={pages:Map<number,string>;warnings:string[]};
export type OcrRunner=(file:string,args:string[],timeout:number)=>Promise<string>;
const native:OcrRunner=async(file,args,timeout)=>(await exec(file,args,{timeout,maxBuffer:800000,env:{...process.env,OMP_THREAD_LIMIT:'1'},killSignal:'SIGKILL'})).stdout;
/** Operator-configured local binaries only. No document bytes or names leave the server. */
export async function ocrPdfPages(bytes:Buffer,pageNumbers:number[],env:Record<string,string|undefined>=process.env,run:OcrRunner=native):Promise<OcrResult>{
 const pages=new Map<number,string>(),warnings:string[]=[];
 if(env.CONTRACT_OCR_ENABLED!=='true')return {pages,warnings:['未启用本地OCR，扫描页尚未识别。']};
 if(active>=1)return {pages,warnings:['本地OCR正在处理其他材料，扫描页暂未识别。']};
 const cap=Math.min(10,Math.max(1,Number(env.CONTRACT_OCR_MAX_PAGES)||5)),timeout=Math.min(60000,Math.max(1000,Number(env.CONTRACT_OCR_TIMEOUT_MS)||45000));
 const selected=pageNumbers.filter(n=>Number.isSafeInteger(n)&&n>0&&n<=100).slice(0,cap),deadline=Date.now()+timeout;
 active++;let dir:string|undefined;
 try{
  dir=await mkdtemp(join(tmpdir(),'contract-ocr-'));const input=join(dir,'source.pdf');await writeFile(input,bytes,{mode:0o600});
  for(const page of selected){
   if(Date.now()>=deadline)break;
   const output=join(dir,'page-'+page);
   try{
    await run(env.CONTRACT_PDFTOPPM_BIN||'pdftoppm',['-f',String(page),'-l',String(page),'-singlefile','-scale-to','1800','-png',input,output],Math.max(1,deadline-Date.now()));
    if(Date.now()>=deadline)break;
    const text=(await run(env.CONTRACT_TESSERACT_BIN||'tesseract',[output+'.png','stdout','-l',env.CONTRACT_OCR_LANG||'chi_sim+eng'],Math.max(1,deadline-Date.now()))).trim();
    if(text&&text.length<=40000)pages.set(page,text);
   }catch{warnings.push('本地OCR未完成，请确认已安装识别程序及中文语言包；未识别内容仍标记为缺失。');break;}
  }
  if(pages.size)warnings.push(`第 ${[...pages.keys()].join('、')} 页来自本地OCR，金额、名称和表格须对照原件核对。`);
  if(pages.size<pageNumbers.length)warnings.push('部分扫描页未识别（页数/时间上限或识别失败），不能声称已读完整份材料。');
  return {pages,warnings};
 }finally{try{if(dir)await rm(dir,{recursive:true,force:true});}finally{active--;}}
}
