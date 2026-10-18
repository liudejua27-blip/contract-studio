'use client';
import {visibleContractText} from '@/lib/contract-document';
import {previewHtml} from '@/lib/document-preview';
import {useEffect,useRef,useState} from 'react';
import {FileText,Download,Loader2,ZoomIn,ZoomOut} from 'lucide-react';
import {StreamingText} from './StreamingText';
import type {Version} from '@/lib/types';
export function DocumentPreview({version}:{version?:Version}){
 const root=useRef<HTMLDivElement>(null),[status,setStatus]=useState('loading'),[error,setError]=useState(''),[actual,setActual]=useState(false),[width,setWidth]=useState(800),[rendered,setRendered]=useState<{id:string;host:HTMLElement;paperWidth:number}|null>(null);
 useEffect(()=>{const host=root.current;if(!host)return;const resize=new ResizeObserver(()=>setWidth(host.clientWidth));resize.observe(host);setWidth(host.clientWidth);return()=>resize.disconnect()},[version?.id]);
 useEffect(()=>{if(!version)return;let gone=false;const controller=new AbortController();setStatus('loading');setError('');setRendered(null);
 (async()=>{try{
  const response=await fetch(`/api/files/${version.id}`,{signal:controller.signal});if(!response.ok)throw new Error('文档暂时无法读取，请重试或下载 Word。');
  const bytes=await response.arrayBuffer(),{renderAsync}=await import('docx-preview');if(gone)return;
  const inert=document.implementation.createHTMLDocument(''),host=inert.createElement('div');inert.body.append(host);
  await renderAsync(bytes,host,undefined,{className:'word-document',inWrapper:true,ignoreWidth:false,ignoreHeight:false,breakPages:true,renderHeaders:true,renderFooters:true,renderFootnotes:true,useBase64URL:true,renderAltChunks:false});
  const page=host.querySelector<HTMLElement>('section.word-document'),size=page?.style.width||'612pt';
  const paperWidth=parseFloat(size)*(size.endsWith('pt')?4/3:1)||816;
  if(!gone){setRendered({id:version.id,host,paperWidth});setStatus('ready')}
 }catch(e){if(!gone){setStatus('error');setError((e as Error).message)}}})();return()=>{gone=true;controller.abort()};},[version?.id]);
 if(!version)return <div className="document-empty"><FileText size={34}/><h3>合同会显示在这里</h3><p>在对话中补充需求，即可生成 Word 草稿。</p></div>;
 return <div className="document-preview"><div className="preview-toolbar"><strong>合同预览</strong><span>第 {version.number} 版</span><button className="icon-button" aria-label={actual?'适应页面宽度':'放大文档'} onClick={()=>setActual(!actual)}>{actual?<ZoomOut size={17}/>:<ZoomIn size={17}/>}</button><a className="icon-button" href={`/api/files/${version.id}`} aria-label="下载当前Word"><Download size={17}/></a></div>{status==='loading'&&<div className="preview-loading saved-document-loading"><span><Loader2 className="spin" size={16}/>正在打开已保存的 Word…</span>{version.content&&<article className="stream-document-paper"><StreamingText text={visibleContractText(version.content)}/></article>}</div>}{error&&<div className="error" role="alert">{error}</div>}<div className="docx-host" ref={root}>{rendered?.id===version.id&&<iframe title="合同预览（只读）" sandbox="" referrerPolicy="no-referrer" srcDoc={previewHtml(rendered.host,actual?1:(width-40)/rendered.paperWidth)} style={{width:'100%',height:'max(600px, 75vh)',border:0,display:'block'}}/>}</div></div>;
}
