import {validateCanaryManifest} from './canary-batch.mjs';
import {validatePilotCohort} from './run-canary-parallel-production.mjs';

export const REQUIRED_FUNCTIONAL_PILOT_COHORT_IDS=Object.freeze([
  'original500-unprocessed-50-20260926-v1','original500-unprocessed-50-20260926-v2',
]);

export function validateFunctionalPilotCohorts({manifest,pilots}={}) {
  if(!Array.isArray(pilots)||pilots.length!==REQUIRED_FUNCTIONAL_PILOT_COHORT_IDS.length)
    throw new Error('FUNCTIONAL_PILOT_COHORT_SET_INVALID');
  const cohortIds=pilots.map(pilot=>pilot?.cohortId);
  const idSet=new Set(cohortIds);
  if(idSet.size!==REQUIRED_FUNCTIONAL_PILOT_COHORT_IDS.length||
      REQUIRED_FUNCTIONAL_PILOT_COHORT_IDS.some(cohortId=>!idSet.has(cohortId)))
    throw new Error('FUNCTIONAL_PILOT_COHORT_SET_INVALID');
  const targetCreatorIds=new Set();
  for(const pilot of pilots){
    const validated=validatePilotCohort(pilot,manifest);
    for(const creatorId of validated.targetCreatorIds){
      if(targetCreatorIds.has(creatorId))throw new Error('FUNCTIONAL_PILOT_COHORT_OVERLAP');
      targetCreatorIds.add(creatorId);
    }
  }
  return {cohortIds:REQUIRED_FUNCTIONAL_PILOT_COHORT_IDS.slice(),targetCreatorIds:[...targetCreatorIds]};
}

/** Pick exactly one fresh qualified row outside the immutable five-lane pilot. */
export function selectNextFunctionalTarget({manifest,entries,pilots}={}) {
  if (manifest?.kind!=='qualified-source'||!Array.isArray(manifest.targets)||manifest.targets.length!==500||
      !Array.isArray(entries)||entries.length!==500) throw new Error('FUNCTIONAL_TARGET_SOURCE_INVALID');
  try { validateCanaryManifest(manifest); } catch { throw new Error('FUNCTIONAL_TARGET_SOURCE_INVALID'); }
  const excluded=new Set(validateFunctionalPilotCohorts({manifest,pilots}).targetCreatorIds);
  const candidates=[];
  for (let index=0;index<manifest.targets.length;index+=1) {
    const target=manifest.targets[index];
    if (entries[index]?.state==='pending'&&!excluded.has(target.creatorId)) candidates.push(target);
  }
  candidates.sort((a,b)=>a.sourceRank-b.sourceRank||a.creatorId.localeCompare(b.creatorId));
  return candidates.length?{creatorId:candidates[0].creatorId,recordId:candidates[0].recordId,
    sourceRank:candidates[0].sourceRank}:null;
}
