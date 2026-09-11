/** Internal cooperative deadline. A yielded unit stays in its durable queue. */
export type WorkBudget = {signal?: AbortSignal; deadlineAt?: number};
export class WorkBudgetExhausted extends Error {
  constructor(){super('Worker time budget reached; continuation scheduled.');this.name='WorkBudgetExhausted';}
}
export function requireWorkBudget(budget: WorkBudget, reserveMs=0){
  if(budget.signal?.aborted||(budget.deadlineAt!==undefined&&Date.now()+reserveMs>=budget.deadlineAt))throw new WorkBudgetExhausted();
}
