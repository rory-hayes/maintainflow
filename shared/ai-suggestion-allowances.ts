/** Field discovery and split suggestions share this calendar-month UTC allowance. */
export const monthlyAiSuggestionAllowances=Object.freeze({explore:3,standard:5,team:20});

/** Only catalogue IDs grant a paid allowance; legacy or unknown plans use Explore. */
export function monthlyAiSuggestionLimit(planId:unknown):number{
 return planId==='standard'?monthlyAiSuggestionAllowances.standard:planId==='team'?monthlyAiSuggestionAllowances.team:monthlyAiSuggestionAllowances.explore;
}

export type AiSuggestionLimits={perDay:number;perMonth:number;pendingPerWorkspace:number};
