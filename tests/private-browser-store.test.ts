import test from 'node:test';
import assert from 'node:assert/strict';
import {privateKey,writePrivate,readPrivate} from '../src/lib/private-browser-store';
test('retry text is account scoped and removed at expiry',()=>{
 const data=new Map<string,string>();
 const storage={getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>data.set(k,v),removeItem:(k:string)=>data.delete(k)} as unknown as Storage;
 const key=privateKey('alice','pending:c');writePrivate(key,{message:'private terms'},storage,0);
 assert.deepEqual(readPrivate(key,storage,100),{message:'private terms'});
 assert.equal(readPrivate(privateKey('bob','pending:c'),storage,100),undefined);
 assert.equal(readPrivate(key,storage,30*60*1000),undefined);assert.equal(data.size,0);
});
