/** Synthetic document-layout fixtures; not legal-quality acceptance or deploy. */
import {mkdir,writeFile} from 'node:fs/promises';
import {contentFixture} from '../tests/fixtures';
import {normalizeParts} from '../src/lib/contract-document';
import {renderContract,extractDocxText} from '../src/server/documents';
import type {ContractContent} from '../src/lib/types';

async function main(){
 const dir='output/contract-document-upgrade';await mkdir(dir,{recursive:true});
 const fixtures:Record<string,ContractContent>={};
 for(const name of ['enterprise','individual','three-party','free-service','revenue','long-table']){
  const c=contentFixture();c.documentProfile='cn-contract-v2';c.parties.forEach(p=>p.subjectType='organization');
  if(name==='individual'){c.parties[1].name='张三';c.parties[1].subjectType='individual';c.confirmation!.facts.partyB={value:'张三',quote:'张三'};}
  if(name==='three-party'){c.parties.push({role:'丙方',name:'张三',subjectType:'individual'});c.confirmation!.facts.partyC={value:'张三',quote:'张三'};}
  c.confirmation!.participants=c.parties.map((p,n)=>({role:p.role,name:p.name,subjectType:p.subjectType,factId:'party'+String.fromCharCode(65+n)}));
  if(name==='free-service'||name==='revenue'){
   c.title=name==='free-service'?'无偿服务合作协议':'设备投放与运营分成协议';
   const value=name==='free-service'?'双方合作提供公益咨询，不支付服务费，各自承担自身费用。':'甲方提供设备，乙方负责门店经营并统一收款；按扣除退款后的实收收入分成，甲方60%、乙方40%，月底核对，乙方向甲方支付分成款。';
   c.confirmation!.templateId='general';c.confirmation!.facts.exchange={value,quote:value};delete c.confirmation!.facts.price;delete c.confirmation!.facts.payment;
   c.sections=[{title:'合作内容',content:value},{title:'履行安排',content:'履行期限：'+c.confirmation!.facts.term.value+'。争议处理：'+c.confirmation!.facts.disputes.value}];c.attachments=[{title:'交易安排清单',content:value}];
  }
  if(name==='long-table'){
   c.attachments=[{title:'功能与交付清单',content:'',blocks:[{kind:'table',columns:['项目','交付内容','核对方式'],rows:Array.from({length:45},(_,i)=>['功能'+(i+1),'测试交付项：按照双方确认的功能说明逐项提供源码、使用说明和部署文档。','双方按本行约定逐项测试并记录结果。'])}],signatureRequired:true}];
  }
  normalizeParts(c);fixtures[name]=c;
  const bytes=await renderContract(c);await writeFile(dir+'/'+name+'.docx',bytes);await writeFile(dir+'/'+name+'.txt',extractDocxText(bytes));
 }
 await writeFile(dir+'/fixtures.json',JSON.stringify(fixtures,null,2));console.log('Wrote six synthetic Word fixtures to '+dir);
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
