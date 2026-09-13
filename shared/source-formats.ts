export const sourceFormats = [
  {id:'pdf',label:'PDF',mimeType:'application/pdf'},
  {id:'png',label:'PNG',mimeType:'image/png'},
  {id:'jpeg',label:'JPEG',mimeType:'image/jpeg'},
  {id:'txt',label:'Text',mimeType:'text/plain'},
  {id:'eml',label:'Email (EML)',mimeType:'message/rfc822'},
  {id:'csv',label:'CSV',mimeType:'text/csv'},
  {id:'xlsx',label:'Excel (XLSX)',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'},
  {id:'docx',label:'Word (DOCX)',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'},
  {id:'html',label:'HTML',mimeType:'text/html'},
] as const;
export type SourceFormat = typeof sourceFormats[number]['id'];
