import fs from 'node:fs/promises';
import path from 'node:path';

export const restorePendingMessage='This restored instance is inactive. Verify and activate the backup before starting Folio.';
/** A pending restore must not run API requests, workers or outbound deliveries. */
export async function assertStorageRestoreReady(storageDir:string,driver:string){
 if(driver!=='filesystem')return;
 try{await fs.lstat(path.join(storageDir,'.folio-restore-pending.json'));}
 catch(error){
  if((error as NodeJS.ErrnoException).code==='ENOENT')return;
  throw Object.assign(new Error('The restore activation state could not be verified. Keep this instance inactive until its storage can be checked.'),{code:'FOLIO_RESTORE_STATE_UNREADABLE'});
 }
 throw Object.assign(new Error(restorePendingMessage),{code:'FOLIO_RESTORE_PENDING'});
}
