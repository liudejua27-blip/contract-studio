import type {Contract} from './types';
/** Old summaries remain readable, but may only confirm the last understood input. */
export function intakeIsCurrent(c:Contract){
 const w=c.workflow;if(!w?.intake)return false;
 if((w.inputRevision??0)!==(w.intake.inputRevision??0))return false;
 return !(w.job?.phase==='understand'&&w.job.status!=='completed');
}
