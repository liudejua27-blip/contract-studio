/** Model behavior is probabilistic; deterministic integrity tests retain their own assertions. */
export function evaluationGate(results:{passed:boolean}[],target=0.95){
 if(!Number.isFinite(target)||target<=0||target>1)throw new Error('评估通过率目标必须大于 0 且不超过 1');
 const total=results.length,passed=results.filter(r=>r.passed).length;
 return {target,total,passed,failed:total-passed,passRate:total?passed/total:0,requiredPasses:Math.ceil(total*target),targetMet:total>0&&passed>=Math.ceil(total*target)};
}
