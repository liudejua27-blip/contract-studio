import test from 'node:test';import assert from 'node:assert/strict';
import {startWorkflow,controlWorkflow,type WorkflowStore} from '../src/server/workflow';
import {intakeIsCurrent} from '../src/lib/intake-state';import{unsupportedFactNumbers,intakeFactIssues,draftFactIssues}from'../src/lib/contract-library/fact-checks';
import{intakeFixture,contentFixture}from'./fixtures';import type{Contract,User}from'../src/lib/types';
test('cancelled or failed understanding cannot confirm an old complete summary',async()=>{
 const u:User={id:'client',name:'test',email:'test@example.test',role:'client'};let c:Contract={id:'c',ownerId:u.id,ownerName:'test',title:'test',createdAt:'',updatedAt:'',messages:[],versions:[],reviews:[],workflow:{intake:{...intakeFixture(),confirmedAt:undefined}}};let rev=0;
 const store:WorkflowStore={load:async()=>({contract:structuredClone(c),revision:rev}),save:async(n,r)=>{assert.equal(r,rev);c=structuredClone(n);rev++;return c},limit:async()=>{},put:async()=>''};
 const summary=c.workflow!.intake!.summaryId,id=crypto.randomUUID();await startWorkflow(store,u,{requestId:id,message:'总价改成12000元'});assert.equal(intakeIsCurrent(c),false);await controlWorkflow(store,u,id,'cancel');await assert.rejects(startWorkflow(store,u,{requestId:crypto.randomUUID(),confirmId:summary}),/重新核对/);assert.equal(c.versions.length,0);
});
test('numeric evidence allows formatting and equivalent units, rejects invention',()=>{assert.equal(unsupportedFactNumbers('0.8万元','8000元'),false);assert.equal(unsupportedFactNumbers('8000元','八千元'),false);assert.equal(unsupportedFactNumbers('2026-10-01','2026年10月1日'),false);assert.equal(unsupportedFactNumbers('12000元含税','8000元'),true)});
test('payment sums, ratios, calendar and date order are checked independently',()=>{
 const i=intakeFixture();assert.deepEqual(intakeFactIssues(i),[]);i.facts.payment.value='首款4000元，尾款8000元';assert.ok(intakeFactIssues(i).some(x=>x.includes('合计')));i.facts.payment.value='首款30%，尾款80%';assert.ok(intakeFactIssues(i).some(x=>x.includes('100%')));i.facts.payment.value='首款4000元，尾款4000元';i.facts.term.value='2026年10月31日开始，2026年10月1日结束';assert.ok(intakeFactIssues(i).some(x=>x.includes('顺序')));i.facts.term.value='2026年2月30日完成';assert.ok(intakeFactIssues(i).some(x=>x.includes('日历')));
});
test('body payment role relationships are checked, not only number membership',()=>{const c=contentFixture();c.sections=[{title:'费用、付款与发票',content:'总价8000元。首款4000元，尾款8000元。'}];assert.ok(draftFactIssues(c).some(x=>x.includes('合计')));c.sections=[{title:'期限',content:'2026年10月31日开始，2026年10月1日结束'}];assert.ok(draftFactIssues(c).length);});
