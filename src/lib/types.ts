import type { DraftingReport } from './contract-library/engine';
export type Role = 'client' | 'lawyer' | 'admin';
export interface User { id: string; name: string; email: string; role: Role; disabled?: boolean }
export interface Message { id: string; role: 'user' | 'assistant'; content: string; createdAt: string }
export interface ContractContent { confirmation?: Intake; attachments?: {title:string;content:string}[]; exportReady?: boolean; drafting?: DraftingReport; title: string; parties: { role: string; name: string; details?: string }[]; sections: { title: string; content: string }[]; signing: string; missing: string[] }
export interface Version { reviewId?:string; text?:string; id: string; number: number; kind: 'draft' | 'review'; fileKey: string; content: ContractContent | null; createdAt: string; source: 'ai' | 'demo' | 'lawyer'; sha256?: string }
export interface ReviewMessage { id: string; authorId: string; authorName: string; content: string; createdAt: string }
export interface Review { handoffVersionId?:string; id: string; submittedVersionId: string | null; lawyerId: string | null; lawyerName?: string; status: 'waiting' | 'reviewing' | 'need_info' | 'completed'; stance: string; concerns: string; requirements: string; submittedAt: string; completedAt?: string; finalVersionId?: string; deliveryNote?: string; messages: ReviewMessage[]; editingVersionId?: string; saveStatus?: 'saved' | 'pending' | 'error' }
export interface Contract { workflow?: Workflow; id: string; ownerId: string; ownerName: string; title: string; createdAt: string; updatedAt: string; messages: Message[]; versions: Version[]; reviews: Review[] }
export interface Capabilities { backgroundJobs?:boolean;  aiConfigured: boolean; demoEnabled: boolean; onlyofficeConfigured: boolean; storage: string }

export interface IntakeFact { source?:"user"|"accepted_proposal"; proposalId?:string;  value:string; quote:string; evidence?:string[] }
export interface Intake { deferredFields?:string[]; businessProposals?:{id:string;fieldId:string;value:string}[];  policyVersion?:string; defaults?:Record<string,string>; reviewNotes?:string[]; withdrawnFields?:string[]; agentTrace?:{runtime:"pi-core";turns:number;tools:string[]};  suggestions?:Record<string,string>; inputRevision?:number; templateId:string; facts:Record<string,IntakeFact>; missing:string[]; conflicts:string[]; summaryId:string; confirmedAt?:string }
export interface GenerationJob { repairCount?:number; repairFeedback?:string;  id:string; messageId:string; phase:'understand'|'generate'|'verify'|'export'; status:'pending'|'running'|'failed'|'completed'|'cancelled'; attempt:number; lease?:string; leaseUntil?:string; error?:string; code?:string; createdAt:string; updatedAt:string; content?:ContractContent; versionId:string }
export interface Workflow { inputRevision?:number; intake?:Intake; job?:GenerationJob; receipts?:{id:string;message:string;confirmId?:string}[] }
