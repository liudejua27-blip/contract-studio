import {api} from './api';
import {privateKey,readPrivate,writePrivate,removePrivate} from './private-browser-store';
import type {Contract} from './types';
/** Preserve the request identity across a lost response, retry and page refresh. */
export async function sendReviewMessage(userId:string,contractId:string,reviewId:string,content:string){
 const key=privateKey(userId,`review-pending:${contractId}:${reviewId}`);
 const previous=readPrivate<{requestId:string;content:string}>(key);
 const request=previous?.content===content?previous:{requestId:crypto.randomUUID(),content};
 writePrivate(key,request);
 const updated=await api<Contract>(`contracts/${contractId}/reviews/${reviewId}/messages`,request);
 if(readPrivate<{requestId:string}>(key)?.requestId===request.requestId)removePrivate(key);
 return updated;
}
