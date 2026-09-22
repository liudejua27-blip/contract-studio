'use client';
import {visibleContractText} from '@/lib/contract-document';
import { useEffect, useRef, useState } from 'react';
import { FileText, Download, Loader2, ZoomIn, ZoomOut } from 'lucide-react';
import {StreamingText} from './StreamingText';
import type { Version } from '@/lib/types';
export function DocumentPreview({version}:{version?:Version}) {
 const root=useRef<HTMLDivElement>(null), [status,setStatus]=useState('loading'),[error,setError]=useState(''),[actual,setActual]=useState(false);
 useEffect(()=>{if(!version||!root.current)return;let gone=false;const controller=new AbortController();setStatus('loading');setError('');const host=root.current;host.innerHTML='';
 (async()=>{try{const r=await fetch(`/api/files/${version.id}`,{signal:controller.signal});if(!r.ok)throw new Error('文档暂时无法读取，请重试或下载 Word。');const bytes=await r.arrayBuffer();const {renderAsync}=await import('docx-preview');if(gone)return;await renderAsync(bytes,host,undefined,{className:'word-document',inWrapper:true,ignoreWidth:false,ignoreHeight:false,breakPages:true,renderHeaders:true,renderFooters:true,renderFootnotes:true,useBase64URL:true});if(!gone)setStatus('ready');}catch(e){if(!gone){setStatus('error');setError((e as Error).message)}}})();return()=>{gone=true;controller.abort()};},[version?.id]);
 useEffect(()=>{if(!root.current)return;const host=root.current;const fit=()=>{const pages=host.querySelectorAll<HTMLElement>('section.word-document');pages.forEach(p=>{const width=p.offsetWidth;if(width){const scale=actual?1:Math.min(1,(host.clientWidth-40)/width);p.style.zoom=String(Math.max(.28,scale));}})};const resize=new ResizeObserver(fit);resize.observe(host);const mutation=new MutationObserver(fit);mutation.observe(host,{childList:true});fit();return()=>{resize.disconnect();mutation.disconnect()};},[status,actual]);
 if(!version)return <div className="document-empty"><FileText size={34}/><h3>合同会显示在这里</h3><p>在对话中补充需求，即可生成 Word 草稿。</p></div>;
 return <div className="document-preview"><div className="preview-toolbar"><strong>合同预览</strong><span>第 {version.number} 版</span><button className="icon-button" aria-label={actual?"适应页面宽度":"放大文档"} onClick={()=>setActual(!actual)}>{actual?<ZoomOut size={17}/>:<ZoomIn size={17}/>}</button><a className="icon-button" href={`/api/files/${version.id}`} aria-label="下载当前Word"><Download size={17}/></a></div>{status==='loading'&&<div className="preview-loading saved-document-loading"><span><Loader2 className="spin" size={16}/>正在打开已保存的 Word…</span>{version.content&&<article className="stream-document-paper"><StreamingText text={visibleContractText(version.content)}/></article>}</div>}{error&&<div className="error" role="alert">{error}</div>}<div className={`docx-host ${actual?'actual-size':''}`} ref={root}/></div>
}
