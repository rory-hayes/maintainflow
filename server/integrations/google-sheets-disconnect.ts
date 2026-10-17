type RevocationDependencies={
 decrypt:(ciphertext:string)=>string;
 revoke:(token:string)=>Promise<{status:number}>;
};

/** Run only after the local disconnect transaction has committed. */
export async function googleSheetsRevocation(secretCiphertext:string|null,dependencies:RevocationDependencies){
 let providerRevoked=false;
 try{
  if(secretCiphertext){
   const credentials:unknown=JSON.parse(dependencies.decrypt(secretCiphertext));
   if(credentials&&typeof credentials==='object'&&!Array.isArray(credentials)){
    const token=credentials as {refresh_token?:unknown;access_token?:unknown};
    const revoke=typeof token.refresh_token==='string'&&token.refresh_token?token.refresh_token:
     typeof token.access_token==='string'&&token.access_token?token.access_token:null;
    if(revoke){const result=await dependencies.revoke(revoke);providerRevoked=result.status>=200&&result.status<300;}
   }
  }
 }catch{
  // An unreadable old credential, missing configuration or failed provider call
  // cannot undo the committed local disconnect. Never expose provider details.
 }
 return {disconnected:true as const,providerRevoked,reason:providerRevoked?null:'Local delivery is disabled. Revoke access for this app in your Google account if provider revocation could not complete.'};
}
