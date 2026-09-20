/// <reference types="@cloudflare/workers-types" />
export interface Env {
 DB:D1Database; BUCKET:R2Bucket; ASSETS:Fetcher;
 CONTRACT_AI_API_KEY:string; CONTRACT_AI_BASE_URL?:string; CONTRACT_AI_MODEL?:string;
 CONTRACT_AI_TIMEOUT_MS?:string; CONTRACT_BOOTSTRAP_SECRET?:string;
 CONTRACT_BOOTSTRAP_ADMIN_EMAIL?:string; CONTRACT_BOOTSTRAP_ADMIN_HASH?:string;
}
