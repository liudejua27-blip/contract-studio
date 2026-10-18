import {recordAgentOutcome,verificationSchema} from '../src/lib/agent-outcome';
import {chromium,expect} from '@playwright/test';
import {renderContract,validateDocxBuffer} from '../src/server/documents';
import {contentFixture} from '../tests/fixtures';
import {unzipSync,zipSync,strToU8,strFromU8} from 'fflate';
async function main(){
await (await import('node:fs/promises')).mkdir('.data/qa',{recursive:true});
const root=process.env.CONTRACT_UI_TEST_URL||'http://127.0.0.1:3210',cid='22222222-2222-4222-8222-222222222222',rid='33333333-3333-4333-8333-333333333333';
if(!['127.0.0.1','localhost'].includes(new URL(root).hostname))throw Error('Local synthetic UI tests only');
const user={id:'11111111-1111-4111-8111-111111111111',name:'测试律师',email:'lawyer@fixture.test',role:'lawyer'};
const now=new Date().toISOString(),content=contentFixture();
content.confirmation!.intent={goal:{value:'保障尾款收取',quote:'我担心收不到尾款'}};
await recordAgentOutcome(content,verificationSchema.parse({verdict:'uncertain',issues:[],uncertainty:{kind:'professional',reason:'尾款保障由负责律师结合交易完善'},goalAssessment:{status:'partial',explanation:'已有付款节点，相关保障仍需完善。',clauses:[{target:'section',index:0,quote:'验收通过后支付4000元'}]}}));
const zip=unzipSync(await renderContract(content));
zip['word/document.xml']=strToU8(strFromU8(zip['word/document.xml']).replace('<w:body>','<w:body><w:p><w:hyperlink r:id="auditLink"><w:r><w:t>本地无害链接验证</w:t></w:r></w:hyperlink></w:p>'));
zip['word/_rels/document.xml.rels']=strToU8(strFromU8(zip['word/_rels/document.xml.rels']).replace('</Relationships>','<Relationship Id="auditLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:window.__auditLinkExecuted=true;void(0)" TargetMode="External"/></Relationships>'));
const docx=Buffer.from(zipSync(zip));validateDocxBuffer(docx);console.log('crafted_docx_passed_server_validator',true);
const c:any={id:cid,ownerId:'owner',ownerName:'测试用户',title:'隔离代码审计',createdAt:now,updatedAt:now,messages:[],versions:[{id:'draft',number:1,kind:'draft',fileKey:'source.docx',source:'demo',content,createdAt:now}],reviews:[{id:rid,submittedVersionId:'draft',lawyerId:user.id,lawyerName:user.name,status:'reviewing',stance:'甲方',concerns:'测试',requirements:'合成数据',submittedAt:now,messages:[]}]};
c.reviews[0].messages=[{id:'recent',authorId:user.id,authorName:user.name,content:'最新沟通',createdAt:now}];c.reviews[0].messagesHasMore=true;
c.versions.push({id:'older',number:2,kind:'review',reviewId:rid,fileKey:'older.docx',source:'lawyer',bodyLoaded:false,content:null,createdAt:now},{id:'latest',number:3,kind:'review',reviewId:rid,fileKey:'latest.docx',source:'lawyer',bodyLoaded:true,content:null,text:'最新正文',createdAt:now});c.reviews[0].editingVersionId='latest';
let office=false,dirtyFail=true,saves=0,dirtyCalls=0,versionReads=0;
const browser=await chromium.launch({headless:true,channel:'chrome'}),page=await browser.newPage({viewport:{width:1440,height:1000}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')console.log('BROWSER_ERROR',m.text())});
await page.route('**/api/**',async route=>{
if(new URL(route.request().url()).pathname.endsWith('/api/documents/api.js'))return route.fulfill({contentType:'application/javascript',body:'window.DocsAPI={DocEditor:function(id,c){window.__officeConfig=c;return {destroyEditor:function(){}}}};'});
const req=route.request(),path=new URL(req.url()).pathname.slice(5),ok=(data:any)=>route.fulfill({json:{data}});
if(path==='session')return ok(user);if(path==='capabilities')return ok({aiConfigured:true,demoEnabled:false,onlyofficeConfigured:office,storage:'fixture'});
if(path==='contract-list')return ok({items:[{...c,displayStatus:'律师完善中'}],total:1,hasMore:false});
if(path===`contracts/${cid}`)return ok(c);if(path.startsWith('files/'))return route.fulfill({body:docx,contentType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'});
if(path.endsWith('/versions/older')){versionReads++;return ok({...c.versions[1],bodyLoaded:true,text:'较早版本的正文'})}
if(path.endsWith('/messages'))return ok({items:[{id:'old',authorId:user.id,authorName:user.name,content:'较早沟通',createdAt:now}],hasMore:false});
if(path.endsWith('/materials')||path==='notifications')return ok([]);
if(path.endsWith('/deletion'))return ok(null);
if(path.endsWith('/editor'))return ok({documentServerUrl:root,config:{document:{key:'fixture-key',url:'fixture',fileType:'docx'},editorConfig:{mode:'edit'}}});
if(path.endsWith('/editor/dirty')){dirtyCalls++;if(dirtyFail)return route.fulfill({status:503,json:{error:'Synthetic dirty sync failure',code:'TEMPORARY'}});return ok(c);}
if(path.endsWith('/editor/save')){saves++;c.reviews[0].saveStatus='saved';return ok(c)}
throw Error('Unexpected route '+path);
});
try{
await page.goto(`${root}/?contract=${cid}&view=review`);
await expect(page.getByText('本版起草说明',{exact:true})).toBeVisible();await expect(page.getByText('部分落实',{exact:true})).toBeVisible();await expect(page.getByText('验收通过后支付4000元',{exact:true})).toBeVisible();console.log('agent_outcome_visible_to_lawyer',true);
const frame=page.frameLocator('iframe[title="合同预览（只读）"]');
await expect(frame.getByText('本地无害链接验证')).toBeVisible();
await expect(frame.locator('a[href]')).toHaveCount(0);
await expect(page.locator('iframe[title="合同预览（只读）"]')).toHaveAttribute('sandbox','');
await frame.getByText('本地无害链接验证').click();
await expect.poll(()=>page.evaluate(()=>(window as any).__auditLinkExecuted===true)).toBe(false);
await expect(page).toHaveTitle('合同工作室 · 对话起草，律师审阅');console.log('sandbox_preview_safe',true);await page.screenshot({path:'.data/qa/audit-fixes-preview.png'});
await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'合同原文',exact:true}).click();await expect(frame.getByText('本地无害链接验证')).toBeVisible();await page.screenshot({path:'.data/qa/audit-fixes-mobile.png',animations:'disabled'});await page.setViewportSize({width:1440,height:1000});
await page.getByRole('tab',{name:/^沟通/}).click();await page.getByRole('button',{name:'加载更早的沟通'}).click();await expect(page.getByText('较早沟通',{exact:true})).toBeVisible();await expect(page.getByText('最新沟通',{exact:true})).toBeVisible();
if(versionReads!==0)throw Error('Historical version eagerly fetched');await page.getByRole('tab',{name:'版本',exact:true}).click();await page.getByLabel('原版本',{exact:true}).selectOption('older');await expect(page.getByText('删除：较早版本的正文')).toBeVisible();if(Number(versionReads)!==1)throw Error('Lazy body fetch missing');
console.log('history_paging_and_lazy_body',true);
office=true;await page.reload();await expect(page.getByRole('button',{name:'保存最新文档',exact:true}).first()).toBeVisible();
await expect.poll(()=>page.evaluate(()=>!!(window as any).__officeConfig?.events?.onDocumentStateChange)).toBe(true);
await page.evaluate(()=>(window as any).__officeConfig.events.onDocumentStateChange({data:true}));await expect(page.getByText('修改状态同步失败，恢复连接后点击保存即可重试。')).toBeVisible();
await expect(page.getByRole('button',{name:'重新连接编辑器'})).toBeVisible();dirtyFail=false;await page.getByRole('button',{name:'保存最新文档',exact:true}).first().click();
await expect.poll(()=>saves).toBe(1);if(dirtyCalls!==2)throw Error('dirty retry missing');console.log('dirty_failure_recovery',{dirtyCalls,saveRequests:saves,reconnectButtons:await page.getByRole('button',{name:'重新连接编辑器'}).count()});await page.screenshot({path:'.data/qa/audit-fixes-save.png'});user.role='client';office=false;c.reviews=[];c.versions=[c.versions[0]];
const materials=['总价8000元','总价9000元'].map((text,n)=>({id:'f6021462-8e1b-486b-804c-c9a65011339'+n,name:'报价'+(n+1)+'.txt',sha256:'a'.repeat(64),purpose:'transaction',status:'ready',size:20,createdAt:now,chunkCount:1,warnings:[]}));
c.workflow={inputRevision:0,intake:{...structuredClone(content.confirmation),summaryId:'new-material-summary',confirmedAt:undefined,inputRevision:0,materialSources:materials,materialConflicts:[{topic:'总价',question:'本次采用哪份报价？',alternatives:materials.map((m,n)=>({materialId:m.id,sha256:m.sha256,chunkId:'text-1',quote:n?'总价9000元':'总价8000元'}))}],conflicts:['本次采用哪份报价？']}};
await page.goto(`${root}/?contract=${cid}`);await page.getByText('本次起草的材料与法律依据',{exact:true}).click();
const evidence=page.locator('.source-evidence');await expect(evidence.locator('blockquote')).toHaveCount(2);await expect(evidence.getByText('本次采用哪份报价？',{exact:true})).toBeVisible();await expect(evidence.getByText('报价2.txt · text-1',{exact:true})).toBeVisible();
await page.screenshot({path:'.data/qa/phase6-material-conflict.png'});console.log('current_material_conflicts_visible_beside_previous_draft',true);
console.log('page_errors',errors);if(errors.length)throw Error(errors.join(';'));
}finally{await browser.close()}
}
main().catch(e=>{console.error(e);process.exitCode=1});
