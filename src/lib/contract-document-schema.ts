import {z} from 'zod';

export const partySchema=z.object({
 role:z.string().trim().min(1).max(80), name:z.string().trim().min(1).max(240),
 subjectType:z.enum(['organization','individual','unknown']).optional(),
 details:z.string().trim().max(2000).optional(),
 registrationId:z.string().trim().max(80).optional(), address:z.string().trim().max(500).optional(),
 contactName:z.string().trim().max(80).optional(), phone:z.string().trim().max(80).optional(), email:z.string().trim().max(160).optional(),
 legalRepresentative:z.string().trim().max(80).optional(), authorizedRepresentative:z.string().trim().max(80).optional(),
 signatureMethod:z.enum(['signature','seal','signature_and_seal']).optional(),
});
export type ContractParty=z.infer<typeof partySchema>;
export const participantSchema=partySchema.pick({role:true,name:true,subjectType:true}).extend({factId:z.string().regex(/^party[A-T]$/)});
export type Participant=z.infer<typeof participantSchema>;
const text=z.string().trim().min(1).max(6000);
export const blockSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('paragraph'),text}),
 z.object({kind:z.literal('heading'),text,level:z.union([z.literal(2),z.literal(3)])}),
 z.object({kind:z.literal('list'),items:z.array(text).min(1).max(100)}),
 z.object({kind:z.literal('table'),columns:z.array(z.string().trim().min(1).max(120)).min(2).max(6),rows:z.array(z.array(z.string().max(2000)).min(2).max(6)).min(1).max(200)}),
]);
export type DocumentBlock=z.infer<typeof blockSchema>;
export const partSchema=z.object({title:z.string().trim().min(1).max(240),content:z.string().max(50000),blocks:z.array(blockSchema).min(1).max(100).optional()});
export type ContractPart=z.infer<typeof partSchema>;
