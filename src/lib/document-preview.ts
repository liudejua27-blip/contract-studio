/** ZIP renderers may label embedded images application/octet-stream. Identify
 * allowed raster formats from their bytes; never admit SVG/HTML by MIME alone. */
export function safePreviewImage(value:string):string|undefined{
 const match=/^data:[^;,]*;base64,([A-Za-z0-9+/=]+)$/i.exec(value);if(!match)return;
 let bytes:string;try{bytes=atob(match[1].slice(0,32))}catch{return;}
 const mime=bytes.startsWith('\x89PNG\r\n\x1a\n')?'image/png':bytes.startsWith('\xff\xd8\xff')?'image/jpeg':/^GIF8[79]a/.test(bytes)?'image/gif':bytes.startsWith('RIFF')&&bytes.slice(8,12)==='WEBP'?'image/webp':undefined;
 return mime?`data:${mime};base64,${match[1]}`:undefined;
}
/** DOCX output is untrusted HTML. Sanitize in an inert document, then render only
 * inside an opaque-origin sandbox with a network-denying CSP. */
export function previewHtml(host:HTMLElement,scale=1){
 const clone=host.cloneNode(true) as HTMLElement;
 clone.querySelectorAll('script,iframe,object,embed,link,meta,base,form,input,button,textarea,select,svg,math').forEach(e=>e.remove());
 for(const element of clone.querySelectorAll('*')){
  for(const attr of Array.from(element.attributes)){
   const name=attr.name.toLowerCase();
   if(name.startsWith('on')||['href','xlink:href','srcdoc','srcset','action','formaction','target','download'].includes(name))element.removeAttribute(attr.name);
   if(name==='src'){const safe=element.tagName==='IMG'?safePreviewImage(attr.value):undefined;if(safe)element.setAttribute('src',safe);else element.removeAttribute(attr.name);}
  }
 }
 const zoom=Math.max(.28,Math.min(1,scale));
 return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><style>body{margin:0;background:#f1f3f1}.word-document-wrapper{padding:16px!important}section.word-document{zoom:${zoom}}a{color:inherit;text-decoration:none;cursor:text}</style></head><body>${clone.innerHTML}</body></html>`;
}
