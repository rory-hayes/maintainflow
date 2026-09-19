/** Only application-owned, content-free messages may be printed by the operator CLI. */
export class BackupError extends Error {
  constructor(readonly code:string,message:string){super(message);this.name='BackupError';}
}
export function backupAssert(condition:unknown,code:string,message:string):asserts condition {
  if(!condition)throw new BackupError(code,message);
}
