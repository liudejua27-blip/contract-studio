import React from 'react';
import type {ContractContent} from '@/lib/types';
import {GOAL_STATUS_LABELS} from '@/lib/agent-outcome';

/** The selected/sent version owns this explanation; never substitute the current intake. */
export function AgentOutcomePanel({content}:{content?:ContractContent|null}){
 const outcome=content?.agentOutcome;if(!outcome)return null;
 const goal=outcome.goal;
 if(!goal&&!outcome.reviewNotes.length)return null;
 return <details className="context-section" open>
  <summary>本版起草说明</summary>
  {goal&&<><p><strong>核心诉求：</strong>{goal.value}</p><p><strong>{GOAL_STATUS_LABELS[goal.status]}</strong> · {goal.explanation}</p>
   {goal.clauses.map((link,n)=>{const part=(link.target==='section'?content.sections:content.attachments||[])[link.index];return <blockquote key={n}><p>{link.quote}</p><small>{link.target==='attachment'?'附件':'条款'}：{part?.title}</small></blockquote>;})}
  </>}
  {outcome.reviewNotes.length>0&&<><p><strong>交给负责律师核对</strong></p><ul>{outcome.reviewNotes.map((note,n)=><li key={n}>{note}</li>)}</ul></>}
  <p className="muted small">这是本版 AI 初稿的说明，供你与负责律师沟通；尚未经律师审定。</p>
 </details>;
}
