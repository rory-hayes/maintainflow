export const PLANS = [
  {id:'explore',name:'Explore',monthlyPrice:0,monthlyPages:50,maxParsers:1,maxConcurrent:1,features:['1 parser','Downloads','Sample workflow']},
  {id:'standard',name:'Standard',monthlyPrice:19,monthlyPages:300,maxParsers:10,maxConcurrent:2,features:['10 parsers','API and webhooks','Review history']},
  {id:'team',name:'Team',monthlyPrice:49,monthlyPages:1000,maxParsers:50,maxConcurrent:4,features:['50 parsers','Workspace roles','Shared workflows']},
] as const;
