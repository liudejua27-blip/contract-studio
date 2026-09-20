import {getTemplate} from '../lib/contract-library/catalog';
import {blankTemplate,inspectDraft} from '../lib/contract-library/engine';
import {renderContract,DOCX_CONTENT_TYPE} from './documents';
export async function templateDownload(id:string):Promise<Response>{
 const t=getTemplate(id);if(!t)return Response.json({error:'模板不存在。',code:'NOT_FOUND'},{status:404});
 const content=blankTemplate(t);content.drafting=inspectDraft(content,t,'','explicit');
 const bytes=await renderContract(content);
 return new Response(new Uint8Array(bytes),{headers:{'Content-Type':DOCX_CONTENT_TYPE,'Cache-Control':'private, no-store','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(t.name+'-待填写模板.docx')}`}});
}
