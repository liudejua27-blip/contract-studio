export const LEGAL_DOMAINS=['npc.gov.cn','gov.cn','court.gov.cn'];
export function officialLegalUrl(value:string){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&LEGAL_DOMAINS.some(d=>u.hostname===d||u.hostname.endsWith('.'+d));}catch{return false;}}
