import {verificationSchema,validateVerification,recordAgentOutcome} from '../lib/agent-outcome';
import {preferenceUsesSchema,auditPreferences,type PreferenceUse} from '../lib/review-learning';
import {retainLegalResearch,legalCitationsSchema,type LegalSearch} from '../lib/legal-research';
import {transactionStructure} from '../lib/transaction-relations';
import {clauseLinksSchema,validateClauseLinks,sealClauseMap,planContractRevision,rebaseClauseLinks,revisionRecord,type ClauseLink} from '../lib/contract-impact';
import {PROFESSIONAL_DEFAULTS} from '../lib/standard-terms';
import {contractPatchSchema,applyContractPatch,type ContractPatch} from '../lib/contract-patch';
import {thinkingParameters} from './agent/thinking';
import {compileTransactionUpdate,intakeSchema,conversationSchema,type ConversationResult} from '../lib/transaction-update';
import {unresolvedTransactionFields} from '../lib/transaction-state';
import {partySchema,partSchema} from '../lib/contract-document-schema';
import {normalizeParts} from '../lib/contract-document';
import {auditApplications} from './agent/skill-audit';
import {documentBody,sha256,type SkillReceipt} from '../lib/skill-audit';
import {substantiveProblems} from '../lib/contract-library/quality';
import {legalSkillBundle} from './agent/legal-skills';
import type {AgentEventSink} from '../lib/agent-stream';
import {draftingPlan} from '../lib/contract-library/general';
import {runStructuredAgent,AgentFailure} from './agent/runtime';
import type {AgentRunContext} from './agent/types';
import {CONTRACT_AGENT_PROMPT,STAGE_PROMPTS,type ContractAgentTask} from './agent/prompt';
import {draftFactIssues,amounts as moneyAmounts,priceTerms,paymentTerms} from '../lib/contract-library/fact-checks';
import {PLAYBOOKS,intakeSummary,exportProblems} from '../lib/contract-library/playbooks';
import type {Intake} from '../lib/types';
import { CONTRACT_TEMPLATES, getTemplate } from '../lib/contract-library/catalog';
import { resolveTemplate, templatePrompt, inspectDraft, type LocatedFact } from '../lib/contract-library/engine';
import { z } from 'zod';
import type { ContractContent, Message } from '@/lib/types';
import { AppError } from './db';

export type AiMode = 'demo' | 'live';
export type AiSource = 'demo' | 'ai';

export type AiResult = {
  reply: string;
  content: ContractContent | null;
  source: AiSource;
};

const applicationSchema=z.object({path:z.string().max(240),ruleQuote:z.string().min(8).max(1000),location:z.string().max(240),quote:z.string().min(8).max(1500)});
const contentSchema = z.object({
  preferenceUses:preferenceUsesSchema,
  legalCitations:legalCitationsSchema,
  clauseLinks:clauseLinksSchema.optional(),
  ruleApplications:z.array(applicationSchema).max(30).optional(),
  title: z.string().trim().min(1).max(240),
  parties:z.array(partySchema).min(2).max(20),
  sections:z.array(partSchema).min(1).max(100),
  signing: z.string().trim().max(10_000),
  missing: z.array(z.string().trim().max(500)).max(100),
  attachments:z.array(partSchema.extend({signatureRequired:z.boolean().optional()})).max(20).optional(),
});

function envFirst(...names: string[]): string | undefined {
  return names.map((name) => process.env[name]?.trim()).find(Boolean);
}

export function demoEnabled(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  return ['1', 'true', 'yes', 'on'].includes((process.env.CONTRACT_DEMO_MODE ?? '').toLowerCase());
}

export function aiConfigured(): boolean {
  return Boolean(envFirst('CONTRACT_AI_API_KEY', 'OPENAI_API_KEY'));
}

export function capabilities() {
  return {
    aiConfigured: aiConfigured(),
    legalSearchConfigured:!!envFirst('CONTRACT_LEGAL_SEARCH_API_KEY','TAVILY_API_KEY'),
    agentRuntime: 'pi-sdk',
    demoEnabled: demoEnabled(),
    onlyofficeConfigured: Boolean(
      envFirst('ONLYOFFICE_URL', 'ONLYOFFICE_DOCUMENT_SERVER_URL')
      && envFirst('ONLYOFFICE_JWT_SECRET', 'ONLYOFFICE_SECRET'),
    ),
    storage: envFirst('CONTRACT_STORAGE_DRIVER') ?? 'local',
  } as const;
}

function defaultSections(): ContractContent['sections'] {
  return [
    { title: '合同目的', content: '双方就本次合作的目标、范围和基本安排达成如下约定。' },
    { title: '双方权利义务', content: '双方应按照诚实信用原则履行本合同，并及时提供履约所需的资料和协助。' },
    { title: '费用与付款', content: '费用金额、付款节点和发票要求请根据双方最终确认的商务条件补充。' },
    { title: '违约责任', content: '一方违约造成对方损失的，应在可归责范围内承担相应的违约责任。' },
    { title: '争议解决', content: '因本合同产生的争议，双方应先行协商；协商不成的，提交有管辖权的机构处理。' },
  ];
}

export function demoContract(prompt: string, currentTitle?: string): ContractContent {
  const cleaned = prompt.trim().replace(/\s+/g, ' ');
  const existingTitle = currentTitle?.trim();
  const title = existingTitle && existingTitle !== '未命名合同'
    ? existingTitle
    : (['软件开发', '摄影服务', '服务合作', '采购', '保密', '租赁', '设计服务'].find(name => cleaned.includes(name)) || '合作') + '合同';
  return {
    title,
    parties: [
      { role: '甲方', name: '', details: '请补充主体名称、统一社会信用代码和联系地址。' },
      { role: '乙方', name: '', details: '请补充主体名称、统一社会信用代码和联系地址。' },
    ],
    sections: [{ title: '示例说明', content: '此文件由固定示例结构生成，用于体验网站流程，未调用 AI，不构成可签署合同。' }, { title: '用户需求原文', content: cleaned || '[待补充]' }, ...defaultSections()],
    signing: '签署日期、签署地点及授权代表信息待双方确认。',
    missing: [
      '双方完整主体信息',
      '服务或交付范围',
      '费用金额、税率和付款节点',
      '合同期限及验收标准',
    ],
  };
}

function demoReply(content: ContractContent, prompt: string, generated: boolean): string {
  if (generated) {
    return '已生成一份示例 Word，保留了你的需求原文。此模式未调用 AI，条款尚未根据业务智能起草，仅用于体验预览和审核流程。';
  }
  return `【演示模式】我记录了你的要求：“${prompt.trim().slice(0, 300)}”。可以继续补充主体、交易范围、金额、期限和风险偏好。`;
}

function normalizeContent(value: unknown): ContractContent {
  const parsed = contentSchema.safeParse(value);
  if (parsed.success) {const {ruleApplications,clauseLinks,preferenceUses,...content}=parsed.data;return normalizeParts(content);}
  throw new AppError(
    502,
    'The configured AI provider did not return a valid contract draft.',
    'AI_INVALID_CONTRACT',
  );
}

export function validateNumericFacts(content: ContractContent, reference: string): void {
  const amounts = (text: string) => new Set(moneyAmounts(text).map(cents=>String(cents/100)));
  const dates = (text: string) => new Set([...Array.from(text.matchAll(/(20\d{2})[年\/-](\d{1,2})[月\/-](\d{1,2})日?/g), m => `${Number(m[1])}-${Number(m[2])}-${Number(m[3])}`), ...Array.from(text.matchAll(/(20\d{2})年(\d{1,2})月\d{1,2}日(?:至|到|—|-)(?:(\d{1,2})月)?(\d{1,2})日/g),m=>`${Number(m[1])}-${Number(m[3]||m[2])}-${Number(m[4])}`)]);
  // Tables often put the currency unit in the header, not in each cell.
  const tableAmounts=[...content.sections,...content.attachments||[]].flatMap(p=>(p.blocks||[]).flatMap(b=>b.kind!=='table'?[]:b.columns.flatMap((header,index)=>{
   if(!/金额|价款|单价|总价|人民币|[（(]元[）)]|万元/.test(header))return [];
   return b.rows.flatMap(row=>{const cell=(row[index]||'').trim().replace(/[,，]/g,'');return /^\d+(?:\.\d+)?$/.test(cell)?[cell+(/万元/.test(header)?'万元':'元')]:[]});
  }))).join('\n');
  const draft = JSON.stringify({title:content.title,parties:content.parties,sections:content.sections,attachments:content.attachments,signing:content.signing})+'\n'+tableAmounts;
  const referenceAmounts = amounts(reference), referenceDates = dates(reference);
  const confirmed=content.confirmation;
  if(confirmed){
   const price=priceTerms(confirmed),payment=paymentTerms(confirmed),prices=price.amountsInCents,ratios=payment.ratios;
   for(const cents of [...prices,...payment.amountsInCents])referenceAmounts.add(String(cents/100));
   if(price.basis==='total'&&prices.length===1&&ratios.length&&Math.abs(ratios.reduce((a,b)=>a+b,0)-100)<0.001)
    for(const ratio of ratios)referenceAmounts.add(String(Math.round(prices[0]*ratio/100)/100));
   if(price.basis==='total'&&prices.length===1&&payment.amountsInCents.length===1&&payment.amountsInCents[0]<=prices[0]&&/余款|剩下|剩余|尾款/.test(payment.raw)&&!unresolvedTransactionFields(confirmed).includes('payment')&&!confirmed.deferredFields?.includes('payment'))referenceAmounts.add(String((prices[0]-payment.amountsInCents[0])/100));
  }
  const issues=content.confirmation?draftFactIssues(content):[];if(issues.length)throw new AppError(422,issues.join('；'),'FACT_CONFLICT');
  const extraAmounts=[...amounts(draft)].filter(value=>!referenceAmounts.has(value)),extraDates=[...dates(draft)].filter(value=>!referenceDates.has(value));
  if (extraAmounts.length || extraDates.length) {
    throw new AppError(502, '草稿出现未确认数值：'+[...extraAmounts.map(v=>v+'元'),...extraDates].join('、')+'。删除无依据的数值，保留用户原文意思；例如不投广告无需改写成0元预算。', 'AI_UNCONFIRMED_FACTS');
  }
}

function extractJson(text: string): unknown | null {
  const withoutFence = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  try {
    return JSON.parse(withoutFence);
  } catch {
    const start = withoutFence.indexOf('{');
    const end = withoutFence.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(withoutFence.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export async function callCompatibleApi(messages:Array<{role:'system'|'user'|'assistant';content:string}>,generated:boolean,environment:Record<string,string|undefined>=process.env):Promise<string>{
 const budget=Math.min(65000,Math.max(1000,Number(environment.CONTRACT_AI_TIMEOUT_MS)||65000)),started=Date.now();
 let recoverEmpty=false;
 for(let attempt=0;attempt<2;attempt++){
  try{return await callCompatibleApiOnce(recoverEmpty?messages.map(m=>m.role==='system'?{...m,content:m.content+'\n必须输出符合上述结构的完整JSON对象，不要留空或输出解释。'}:m):messages,generated&&!recoverEmpty,{...environment,CONTRACT_AI_TIMEOUT_MS:String(Math.max(1000,budget-(Date.now()-started)))});}
  catch(error){if(attempt||!(error instanceof AppError)||!['AI_EMPTY_RESPONSE','AI_PROVIDER_UNAVAILABLE'].includes(error.code)||Date.now()-started>budget-5000)throw error;
   recoverEmpty=error.code==='AI_EMPTY_RESPONSE'&&generated;
   console.warn(JSON.stringify({event:'ai_recovery',code:error.code,attempt:attempt+1}));await new Promise(resolve=>setTimeout(resolve,300));}
 }
 throw new AppError(502,'模型暂时无法回复，你的信息已保存。','AI_EMPTY_RESPONSE');
}

function historyForModel(messages: Message[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  return messages.map((message) => ({ role: message.role, content: message.content }));
}

async function callCompatibleApiOnce(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>, generated: boolean, environment: Record<string,string|undefined> = process.env): Promise<string> {
  const envFirst = (...names:string[]) => names.map(name=>environment[name]?.trim()).find(Boolean);
  const apiKey = envFirst('CONTRACT_AI_API_KEY', 'OPENAI_API_KEY');
  if (!apiKey) {
    throw new AppError(
      503,
      'Live AI is not configured. Set CONTRACT_AI_API_KEY (or OPENAI_API_KEY), or explicitly enable local demo mode.',
      'AI_NOT_CONFIGURED',
    );
  }
  const baseUrl = (envFirst('CONTRACT_AI_BASE_URL', 'OPENAI_BASE_URL', 'OPENAI_API_BASE_URL') ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = envFirst('CONTRACT_AI_MODEL', 'OPENAI_MODEL') ?? (new URL(baseUrl).hostname === 'api.deepseek.com' ? 'deepseek-flash' : 'gpt-4o-mini');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(65000, Math.max(1000, Number(environment.CONTRACT_AI_TIMEOUT_MS) || 65000)));
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, ...thinkingParameters(baseUrl,environment),
        ...(new URL(baseUrl).hostname==='api.deepseek.com'?{max_tokens:8000}:{}),
        ...(generated ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      // Never pass provider response bodies through; they may contain credentials or prompts.
      throw new AppError(502, 'The configured AI provider returned an error.', 'AI_PROVIDER_ERROR');
    }
    const payload = await response.json() as {
      choices?: Array<{ finish_reason?: string; message?: { content?: unknown } }>;
    };
    if (payload.choices?.[0]?.finish_reason === 'length') {
      throw new AppError(502, '模型输出未完成，未保存草稿。请缩小本次修改范围后重试。', 'AI_OUTPUT_TRUNCATED');
    }
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      console.warn(JSON.stringify({event:'ai_empty_response',finishReason:payload.choices?.[0]?.finish_reason||'absent',choices:payload.choices?.length||0,contentType:typeof content}));
      throw new AppError(502, 'The configured AI provider returned no assistant content.', 'AI_EMPTY_RESPONSE');
    }
    return content.trim();
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (controller.signal.aborted) {
      throw new AppError(504, '模型生成超时，未保存新版本。请稍后重试。', 'AI_TIMEOUT');
    }
    throw new AppError(502, 'The configured AI provider could not be reached.', 'AI_PROVIDER_UNAVAILABLE');
  } finally {
    clearTimeout(timeout);
  }
}


/** Compatibility entry: a legacy generate flag can never bypass confirmation. */
export async function generateContractReply(input:{mode:AiMode;generate:boolean;prompt:string;title:string;messages:Message[];existingDocumentText?:string;environment?:Record<string,string|undefined>;templateId?:string}):Promise<AiResult>{
 const result=await collectIntake([...input.messages,{id:crypto.randomUUID(),role:'user',content:input.prompt,createdAt:new Date().toISOString()}],undefined,input.environment);
 return{reply:result.reply,content:null,source:'ai'};
}

async function callAgentJson(task:ContractAgentTask,messages:Array<{role:'system'|'user'|'assistant';content:string}>,_generated:boolean,environment?:Record<string,string|undefined>,validate?:(value:any)=>void,onEvent?:AgentEventSink,context?:AgentRunContext,families:string[]=[],transaction?:Intake):Promise<string>{
 const prompt=messages.filter(m=>m.role==='system').map(m=>m.content).join('\n');
 const intake=task==='intake',verify=task==='verify',patch=task==='patch';
 const schema= patch?contractPatchSchema:intake?conversationSchema:verify?verificationSchema:contentSchema;
 const bundle=await legalSkillBundle(intake?'intake':verify?'verify':'draft',families,transaction||context?.transaction);
 onEvent?.({type:'activity',label:'正在载入通用合同规则'+(families.length?'及相关专项参考':'')});
 try{const result=await runStructuredAgent({incremental:true,context,transaction:transaction||context?.transaction,prompt:CONTRACT_AGENT_PROMPT+'\n'+bundle.prompt+'\n'+prompt,onEvent,stage:intake?'intake':verify?'verify':'draft',messages:messages.filter((m):m is {role:'user'|'assistant';content:string}=>m.role!=='system'),schema:schema as z.ZodTypeAny,toolName:patch?'apply_contract_patch':intake?'update_contract_spec':verify?'submit_consistency_check':'submit_contract_draft',environment,validate,rules:intake?PLAYBOOKS:undefined});return JSON.stringify({...result.value,__agentTrace:result.trace,__legalResearch:result.trace.legalResearch||[],__skillReceipts:[...bundle.receipts,...result.trace.skillReads||[]]});}
 catch(e){if(e instanceof AgentFailure)throw new AppError(502,e.message,e.code);throw new AppError(502,'模型未完整整理本次内容，请重试。','AI_INVALID_ROUTING');}
}

export async function collectIntake(messages:Message[],previous:Intake|undefined,environment?:Record<string,string|undefined>,onEvent?:AgentEventSink,context?:AgentRunContext,currentDocument?:ContractContent|null):Promise<ConversationResult>{
 const userTexts=messages.filter(m=>m.role==='user').map(m=>m.content);
 const accepted=previous?.businessProposals?.find(p=>messages.at(-1)?.role==='user'&&messages.at(-1)?.content===`采用建议：${p.value}`);
 if(previous&&accepted&&!previous.conflicts.length&&previous.missing.every(id=>id===accepted.fieldId)){
  return {action:'update',...compileTransactionUpdate(intakeSchema.parse({templateId:previous.templateId,ruleFamilies:previous.ruleFamilies,reply:'已采用这个建议，其他约定保留。',facts:[],businessChecks:previous.businessChecks,acceptedProposalIds:[accepted.id]}),previous,userTexts,context?.materials)};
 }
 let acceptedResult:ConversationResult|undefined;
 const raw=await callAgentJson('intake',[{role:'system',content:`当前日期（上海）：${new Date().toLocaleDateString("sv-SE",{timeZone:"Asia/Shanghai"})}。
${STAGE_PROMPTS.intake}
可用普通专业条款：${JSON.stringify(PROFESSIONAL_DEFAULTS)}。
专项规则索引：${Object.keys(PLAYBOOKS).join('、')}。需要时通过 get_contract_rules 查询。`},...historyForModel(messages),{role:'user',content:'当前已保存的最新合同（只作解释和修改定位依据，不能覆盖最新交易事实；没有合同时不得虚构条款）：'+(currentDocument?documentBody(currentDocument):'尚无合同正文')}],true,environment,value=>{
  const result=conversationSchema.parse(value);
  acceptedResult=result.action==='answer'?{action:'answer',reply:result.reply}:{action:'update',...compileTransactionUpdate(result,previous,userTexts,context?.materials)};
 },onEvent,context,[],previous);
 if(!acceptedResult)throw new AppError(502,'本次信息未整理完成，原对话已保存，可以重试。','AI_INVALID_ROUTING');
 if(acceptedResult.action==='update'&&acceptedResult.intake){const meta=extractJson(raw) as any;const {legalResearch:traceResearch,...agentTrace}=meta.__agentTrace;acceptedResult.intake.agentTrace=agentTrace;acceptedResult.intake.legalResearch=retainLegalResearch(mergeResearch(previous?.legalResearch,meta.__legalResearch),acceptedResult.intake.legalCitations);}
 return acceptedResult;
}
export async function draftConfirmed(intake:Intake,environment?:Record<string,string|undefined>,repairFeedback?:string,onEvent?:AgentEventSink,context?:AgentRunContext):Promise<ContractContent>{
 const p=PLAYBOOKS[intake.templateId];if(!p||!intake.confirmedAt||intake.missing.length||intake.conflicts.length||unresolvedTransactionFields(intake).length)throw new AppError(409,'请先补齐并确认关键约定。','CONFIRMATION_REQUIRED');
 const t=getTemplate(intake.templateId)!;
 const families=[...new Set([intake.templateId,...intake.ruleFamilies||[]])].filter(id=>Object.hasOwn(PLAYBOOKS,id));
 const plan=draftingPlan(intake,families.flatMap(id=>PLAYBOOKS[id].clauses));intake={...intake,draftingPlan:plan};delete intake.skillSource;
 const raw=await callAgentJson('draft',[{role:'system',content:`${STAGE_PROMPTS.draft}\n交易起草方案：${JSON.stringify(plan)}`},{role:'user',content:intakeSummary(intake,true)+'\n用户已撤回、不得恢复的事项：'+JSON.stringify(intake.withdrawnFields||[])+(repairFeedback?'\n上一版一致性检查发现问题，请只依据上述事实和系统规则修正：'+repairFeedback:'')}],true,environment,(candidate)=>{
  const checked=normalizeContent(candidate);checked.documentProfile='cn-contract-v2';checked.confirmation=structuredClone(intake);
  auditPreferences(checked,context?.clausePreferences||[],candidate.preferenceUses);
  validateClauseLinks(checked,intake,candidate.clauseLinks||[]);
  validateNumericFacts(checked,intakeSummary(intake,true));
  const problems=exportProblems(checked);if(problems.length)throw new Error(problems.join('；'));
 },onEvent,context,families,intake);
 const content=normalizeContent(extractJson(raw));content.documentProfile='cn-contract-v2';content.confirmation=structuredClone(intake);
 if(content.attachments?.length){const last=content.sections.at(-1)!;const reference='附件《'+content.attachments.map(a=>a.title).join('》《')+'》为本合同组成部分。';if(last.blocks){last.blocks.push({kind:'paragraph',text:reference});normalizeParts(content);}else last.content+='\n'+reference;}
 validateNumericFacts(content,intakeSummary(intake,true));
 const problems=exportProblems(content);if(problems.length)throw new AppError(422,'文档校验未通过：'+problems.join('；')+'。请修改约定或重试，未输出缺项合同。','EXPORT_NOT_READY');
 content.drafting=inspectDraft(content,t,Object.values(intake.facts).map(f=>f.quote).join('\n'),'ai',Object.entries(intake.facts).map(([fieldId,f])=>({fieldId,quote:f.quote})));
 const metadata=extractJson(raw) as {preferenceUses?:PreferenceUse[];__legalResearch?:LegalSearch[];clauseLinks?:ClauseLink[];__skillReceipts:SkillReceipt[];ruleApplications?:z.infer<typeof applicationSchema>[]};
 content.preferenceAudit=auditPreferences(content,context?.clausePreferences||[],metadata.preferenceUses);
 content.legalResearch=retainLegalResearch(mergeResearch(intake.legalResearch,metadata.__legalResearch),[...intake.legalCitations||[],...content.legalCitations||[]]);
 await sealClauseMap(content,intake,metadata.clauseLinks||[]);
 content.skillAudit=await auditApplications(content,metadata.__skillReceipts||[],metadata.ruleApplications||[]);
 content.exportReady=true;return content;
}

/** Repair or revise an existing draft without resubmitting all its unaffected clauses. */
export async function reviseConfirmedDraft(base:ContractContent,intake:Intake,request:string,environment?:Record<string,string|undefined>,onEvent?:AgentEventSink,context?:AgentRunContext):Promise<ContractContent>{
 if(!intake.confirmedAt||intake.missing.length||intake.conflicts.length||unresolvedTransactionFields(intake).length)throw new AppError(409,'请先补齐并确认关键约定。','CONFIRMATION_REQUIRED');
 const original=structuredClone(base),impactPlan=await planContractRevision(original,intake),baseSha256=impactPlan.baseSha256;
 const families=[...new Set([intake.templateId,...intake.ruleFamilies||[]])].filter(id=>Object.hasOwn(PLAYBOOKS,id));
 let accepted:ContractContent|undefined,acceptedLinks:ClauseLink[]=[];
 const raw=await callAgentJson('patch',[{role:'system',content:STAGE_PROMPTS.patch},{role:'user',content:JSON.stringify({baseSha256,request,impactPlan,transaction:transactionStructure(intake),previousTransaction:original.confirmation?transactionStructure(original.confirmation):undefined,clauseLinks:original.clauseMap?.contentSha256===baseSha256?original.clauseMap.links:[],confirmed:intakeSummary(intake,true),withdrawn:intake.withdrawnFields||[],previousConfirmed:original.confirmation?intakeSummary(original.confirmation,true):undefined,draft:{title:original.title,parties:original.parties,sections:original.sections,attachments:original.attachments||[],signing:original.signing}})}],true,environment,value=>{
  const patch=contractPatchSchema.parse(value),patched=applyContractPatch(original,patch,baseSha256);
  patched.preferenceAudit=auditPreferences(patched,context?.clausePreferences||[],patch.preferenceUses);
  const links=rebaseClauseLinks(original,intake,patch,baseSha256);
  validateClauseLinks(patched,intake,links);
  patched.revision=revisionRecord(impactPlan,patch,original);
  // Schema validation is read-only here: normalization must not rewrite untouched parts.
  contentSchema.parse(patched);patched.confirmation={...structuredClone(intake),reviewNotes:[...new Set([...intake.reviewNotes||[],...original.confirmation?.reviewNotes||[]])]};
  validateNumericFacts(patched,intakeSummary(intake,true));
  const problems=exportProblems(patched);if(problems.length)throw new Error(problems.join('；'));
  accepted=patched;acceptedLinks=links;
 },onEvent,context?{...context,legalResearch:mergeResearch(context.legalResearch,original.legalResearch)}:undefined,families,{...intake,legalResearch:mergeResearch(intake.legalResearch,original.legalResearch)});
 if(!accepted)throw new AppError(502,'本次修改未完成，原稿已保留，可以重试。','AI_INVALID_ROUTING');
 const metadata=extractJson(raw) as ContractPatch&{__legalResearch?:LegalSearch[];__skillReceipts?:SkillReceipt[]};
 const preserved=(original.skillAudit?.applications||[]).filter(a=>[...accepted!.sections,...accepted!.attachments||[]].some(p=>p.title===a.location&&p.content.includes(a.quote))).map(({path,ruleQuote,location,quote})=>({path,ruleQuote,location,quote}));
 const applications=[...new Map([...preserved,...metadata.ruleApplications].map(a=>[JSON.stringify(a),a])).values()];
 const receipts=[...new Map([...original.skillAudit?.receipts||[],...metadata.__skillReceipts||[]].map(r=>[r.id,r])).values()];
 accepted.legalResearch=retainLegalResearch(mergeResearch(original.legalResearch,intake.legalResearch,metadata.__legalResearch),[...intake.legalCitations||[],...metadata.legalCitations||[]]);
 accepted.legalCitations=metadata.legalCitations||[];
 await sealClauseMap(accepted,intake,acceptedLinks);
 accepted.skillAudit=await auditApplications(accepted,receipts,applications);
 accepted.drafting=inspectDraft(accepted,getTemplate(intake.templateId)!,Object.values(intake.facts).map(f=>f.quote).join('\n'),'ai',Object.entries(intake.facts).map(([fieldId,f])=>({fieldId,quote:f.quote})));
 accepted.exportReady=true;return accepted;
}

export async function verifyConfirmedDraft(content:ContractContent,environment?:Record<string,string|undefined>,onEvent?:AgentEventSink,context?:AgentRunContext):Promise<void>{
 if(content.skillAudit&&content.skillAudit.contentSha256!==await sha256(documentBody(content)))throw new AppError(422,'正文已变更，规则关联需要重新生成。','DRAFT_MISMATCH');
 const localProblems=substantiveProblems(content);if(localProblems.length)throw new AppError(422,localProblems.join('；'),'DRAFT_MISMATCH');
 const raw=await callAgentJson('verify',[{role:'system',content:STAGE_PROMPTS.verify},{role:'user',content:JSON.stringify({intent:content.confirmation?.intent,confirmed:intakeSummary(content.confirmation!,true),transaction:transactionStructure(content.confirmation!),revision:content.revision,preferenceAudit:content.preferenceAudit,clauseLinks:content.clauseMap?.links||[],draft:{parties:content.parties,sections:content.sections,attachments:content.attachments,signing:content.signing}})}],true,environment,value=>validateVerification(verificationSchema.parse(value),content),onEvent,context,[content.confirmation!.templateId,...content.confirmation!.ruleFamilies||[]],{...content.confirmation!,legalResearch:mergeResearch(content.confirmation?.legalResearch,content.legalResearch)});
 const parsed=verificationSchema.safeParse(extractJson(raw));
 if(!parsed.success)throw new AppError(502,'内容一致性检查未完成，请重试。','AI_CHECK_FAILED');
 if(parsed.data.verdict==='consistent'&&parsed.data.issues.length)throw new AppError(502,'一致性检查返回了相互矛盾的结果，请重试核对。','AI_CHECK_FAILED');
 if(parsed.data.verdict==='inconsistent')throw new AppError(422,'合同与确认信息存在差异，尚未导出：'+parsed.data.issues.join('；'),'DRAFT_MISMATCH');
 if(parsed.data.verdict==='uncertain'&&parsed.data.uncertainty?.kind!=='professional')throw new AppError(422,'原稿已保留，未自动改写。尚无法核对：'+(parsed.data.uncertainty?.reason||parsed.data.issues.join('；')||'模型未能确定事实是否一致')+(parsed.data.uncertainty?.question?'。请补充：'+parsed.data.uncertainty.question:'。可补充相关信息，或稍后重新核对。'),'FACT_CHECK_UNCERTAIN');
 await recordAgentOutcome(content,parsed.data);
 content.legalResearch=retainLegalResearch(mergeResearch(content.legalResearch,(extractJson(raw) as any).__legalResearch),[...content.confirmation?.legalCitations||[],...content.legalCitations||[],...parsed.data.legalCitations||[]]);
 content.legalCitations=[...content.legalCitations||[],...parsed.data.legalCitations||[]];
 if(content.skillAudit){content.skillAudit.receipts.push(...((extractJson(raw) as {__skillReceipts?:SkillReceipt[]}).__skillReceipts||[]));content.skillAudit.consistency={contentSha256:await sha256(documentBody(content)),status:content.agentOutcome!.consistency,checkedAt:content.agentOutcome!.checkedAt};}
 if(content.confirmation)content.confirmation.reviewNotes=[...new Set([...content.confirmation.reviewNotes||[],...content.agentOutcome!.reviewNotes])];
}

function mergeResearch(...sets:(LegalSearch[]|undefined)[]){return [...new Map(sets.flatMap(s=>s||[]).map(r=>[JSON.stringify([r.query,r.searchedAt]),r])).values()];}
