import {backupAssert} from './errors.js';
import type {BackupUploadStaging} from './types.js';

const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
/** Exact declarations only. Optional sources are protected just like required originals. */
export function uploadStagingDeclarations(entries:BackupUploadStaging[],protectedKeys:Iterable<string>=[]):BackupUploadStaging[]{
 backupAssert(Array.isArray(entries)&&entries.length<=100_000,'BACKUP_STAGING','The upload staging inventory is invalid or exceeds its limit.');
 const protectedSet=new Set(protectedKeys),keys=new Set<string>(),records=new Set<string>();
 for(const entry of entries){
  const parts=typeof entry?.key==='string'?entry.key.split('/'):[];
  backupAssert(entry&&Object.keys(entry).length===3&&parts.length===2&&parts.every(p=>uuid.test(p))&&uuid.test(entry.recordId)&&['direct_upload','split_suggestion'].includes(entry.recordType),'BACKUP_STAGING','The upload staging declaration is invalid.');
  backupAssert(entry.recordType!=='direct_upload'||parts[1]===entry.recordId,'BACKUP_STAGING','The direct upload staging key does not match its reservation.');
  const record=entry.recordType+':'+entry.recordId;
  backupAssert(!keys.has(entry.key)&&!records.has(record)&&!protectedSet.has(entry.key),'BACKUP_STAGING','Upload staging aliases another declaration or an original, source or intake object.');
  keys.add(entry.key);records.add(record);
 }
 return entries.map(entry=>({...entry})).sort((a,b)=>a.key.localeCompare(b.key));
}
