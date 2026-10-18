import test from 'node:test';
import assert from 'node:assert/strict';
import {sendReviewMessage} from '../src/lib/review-message-client';
import {clearPrivateBrowserData,privateKey,readPrivate,writePrivate} from '../src/lib/private-browser-store';
test('lost response retries keep the original message identity, and successful sends remove private retry data',async()=>{
 const original=globalThis.fetch,requests:any[]=[];
 try{
  clearPrivateBrowserData();globalThis.fetch=async(_url,init)=>{requests.push(JSON.parse(String(init?.body)));if(requests.length===1)throw new Error('lost response');return new Response(JSON.stringify({data:{id:'c'}}));};
  await assert.rejects(()=>sendReviewMessage('owner','c','r','private message'));
  assert.equal(readPrivate<any>(privateKey('owner','review-pending:c:r'))?.requestId,requests[0].requestId);
  assert.equal(readPrivate(privateKey('stranger','review-pending:c:r')),undefined);
  await sendReviewMessage('owner','c','r','private message');
  assert.equal(requests[0].requestId,requests[1].requestId);
  assert.equal(readPrivate(privateKey('owner','review-pending:c:r')),undefined);
 }finally{globalThis.fetch=original;clearPrivateBrowserData()}
});
test('an older send response never clears the next message retry or draft',async()=>{
 const original=globalThis.fetch;let finish!:()=>void;
 try{
  clearPrivateBrowserData();globalThis.fetch=()=>new Promise(resolve=>{finish=()=>resolve(new Response(JSON.stringify({data:{id:'c'}})))});
  const sending=sendReviewMessage('owner','c','r','first');
  const key=privateKey('owner','review-pending:c:r'),draft=privateKey('owner','review:c:r:message');
  writePrivate(key,{requestId:'next',content:'next message'});writePrivate(draft,'next message');
  finish();await sending;
  assert.equal(readPrivate<any>(key).requestId,'next');assert.equal(readPrivate(draft),'next message');
 }finally{globalThis.fetch=original;clearPrivateBrowserData()}
});
