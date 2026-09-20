import {processOneAccountEmail} from './account-recovery-mail.js';
import {processOneInvitationEmail} from './invitation-email.js';
import {requireWorkBudget,type WorkBudget} from './work-budget.js';

const lanes=[processOneAccountEmail,processOneInvitationEmail];
let nextLane=0;
/** Alternate busy lanes; a failing queue cannot prevent the other lane making progress. */
export async function processOneWorkspaceEmail(budget:WorkBudget={}):Promise<boolean>{
 let failed=false;
 for(let attempt=0;attempt<lanes.length;attempt++){
  requireWorkBudget(budget,1000);
  const processOne=lanes[nextLane];nextLane=(nextLane+1)%lanes.length;
  try{if(await processOne(budget))return true;}
  catch{requireWorkBudget(budget,1000);failed=true;}
 }
 if(failed)throw new Error('Workspace email processing failed.');
 return false;
}
