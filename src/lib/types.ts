export type Role = 'client' | 'lawyer' | 'admin';
export interface User { id: string; name: string; email: string; role: Role; disabled?: boolean }
export interface Message { id: string; role: 'user' | 'assistant'; content: string; createdAt: string }
export interface ContractContent { title: string; parties: { role: string; name: string; details?: string }[]; sections: { title: string; content: string }[]; signing: string; missing: string[] }
export interface Version { id: string; number: number; kind: 'draft' | 'review'; fileKey: string; content: ContractContent | null; createdAt: string; source: 'ai' | 'demo' | 'lawyer'; sha256?: string }
export interface ReviewMessage { id: string; authorId: string; authorName: string; content: string; createdAt: string }
export interface Review { id: string; submittedVersionId: string; lawyerId: string | null; status: 'waiting' | 'reviewing' | 'need_info' | 'completed'; stance: string; concerns: string; requirements: string; submittedAt: string; completedAt?: string; finalVersionId?: string; deliveryNote?: string; messages: ReviewMessage[]; editingVersionId?: string; saveStatus?: 'saved' | 'pending' | 'error' }
export interface Contract { id: string; ownerId: string; ownerName: string; title: string; createdAt: string; updatedAt: string; messages: Message[]; versions: Version[]; reviews: Review[] }
export interface Capabilities { aiConfigured: boolean; demoEnabled: boolean; onlyofficeConfigured: boolean; storage: string }
