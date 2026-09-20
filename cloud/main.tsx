import React from 'react';
import {createRoot} from 'react-dom/client';
import {Studio} from '../src/components/Studio';
import '../src/app/globals.css';
createRoot(document.getElementById('root')!).render(<Studio/>);

// Optional read-only browser tool uses the same authenticated endpoint as the UI.
const context=(document as Document&{modelContext?:{registerTool:(tool:unknown,options?:unknown)=>unknown}}).modelContext;
if(context?.registerTool){
 const lifecycle=new AbortController();
 Promise.resolve(context.registerTool({name:'list_my_contracts',title:'查看我的合同',description:'读取当前登录账号可访问的合同名称、编号和最近更新时间；不会修改或送审合同。',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:true},async execute(input:unknown){if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)throw new Error('不接受额外参数');const response=await fetch('/api/contracts',{credentials:'same-origin'});if(!response.ok)throw new Error('请先登录');const value=await response.json() as {data:Array<{id:string;title:string;updatedAt:string}>};return value.data.map(({id,title,updatedAt})=>({id,title,updatedAt}));}}, {signal:lifecycle.signal})).catch(()=>{});
 window.addEventListener('pagehide',()=>lifecycle.abort(),{once:true});
}
