import {AsyncLocalStorage} from 'node:async_hooks';
import {query} from './db';
export const auditStore={append:async(actor:string,action:string,resource:string|null,outcome:number)=>{await query('INSERT INTO access_audit(actor_id,action,resource_id,outcome) VALUES($1,$2,$3,$4)',[actor,action,resource,outcome]);}};
const context = new AsyncLocalStorage<{actor?:string;action:string;resource?:string;started?:boolean}>();
export async function auditAccess(actorId:string,resourceId?:string):Promise<void>{
 const current=context.getStore();if(!current||current.started)return;
 if(resourceId)current.resource=resourceId;
 // Persist before granting access. No message text, password, query string or token.
 await auditStore.append(actorId,current.action,current.resource??null,0);
 current.actor=actorId;current.started=true;
}
export function audited<C>(handler:(request:Request,context:C)=>Promise<Response>){
 return async(request:Request,routeContext:C):Promise<Response>=>{
  const parts=new URL(request.url).pathname.split('/').filter(Boolean).slice(1);
  const safe=parts.map(x=>/^[0-9a-f-]{36}$/i.test(x)?':id':x.replace(/[^a-z-]/gi,'').slice(0,40));
  return context.run({action:request.method+' /'+safe.join('/'),resource:parts.find(x=>/^[0-9a-f-]{36}$/i.test(x))},async()=>{
   const response=await handler(request,routeContext),current=context.getStore()!;
   if(current.started)await auditStore.append(current.actor!,current.action,current.resource??null,response.status).catch(()=>console.error('access_audit_completion_failed'));
   return response;
  });
 };
}
