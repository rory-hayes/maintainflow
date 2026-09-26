import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import sharp from 'sharp';
import type {RawBankValues} from '../shared/bank-statements.js';

/** Synthetic source and controlled provider answer, never a bank-compatibility benchmark. */
export const syntheticBankRaw:RawBankValues={accounts:[{
  bank_name:'Example Bank',account_identifier:'SYN-00001234',currency:'EUR',statement_start:'01/09/2026',statement_end:'30/09/2026',
  opening_balance:'1,000.00',closing_balance:'1,010.00',total_debits:'10.00',total_credits:'20.00',
  balance_convention:'Credits increase and debits decrease the displayed account balance.',transactions:[
    {date:'03/09/2026',description:'Coffee supply monthly office stock',reference:'SYN-001',debit:'10.00',credit:null,balance:'990.00',currency:null},
    {date:'04/09/2026',description:'Client payment',reference:'SYN-002',debit:null,credit:'20.00',balance:'1,010.00',currency:null},
  ],
}]};
export const syntheticBankEvidence=[
  {field:'accounts[0].transactions[0].date',page:1,text:'03/09/2026'},
  {field:'accounts[0].transactions[0].debit',page:1,text:'10.00'},
  {field:'accounts[0].transactions[1].date',page:2,text:'04/09/2026'},
  {field:'accounts[0].transactions[1].credit',page:2,text:'20.00'},
];
const pages=[[
  'SYNTHETIC BANK STATEMENT - NOT A REAL ACCOUNT','Example Bank | Account: SYN-00001234 | Currency: EUR',
  'Statement: 01/09/2026 to 30/09/2026','Credits increase and debits decrease the displayed account balance.',
  'Opening balance: 1,000.00','Date | Description | Reference | Debit | Credit | Balance',
  '03/09/2026 | Coffee supply | SYN-001 | 10.00 | | 990.00','             monthly office stock',
  'Continued on page 2. This is synthetic test data.',
],[
  'SYNTHETIC BANK STATEMENT - PAGE 2','Example Bank | Account: SYN-00001234 | Currency: EUR',
  'Date | Description | Reference | Debit | Credit | Balance','04/09/2026 | Client payment | SYN-002 | | 20.00 | 1,010.00',
  'Total debits: 10.00 | Total credits: 20.00','Closing balance: 1,010.00','Synthetic fixture: repeated table header and wrapped description.',
]];
const xml=(value:string)=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
export async function createBankSourceFixtures(){
  const native=await PDFDocument.create(),font=await native.embedFont(StandardFonts.Helvetica),scanned=await PDFDocument.create();
  native.setTitle('Synthetic MaintainFlow bank statement');scanned.setTitle('Synthetic scanned MaintainFlow bank statement');
  const images:Buffer[]=[];
  for(const lines of pages){
    const page=native.addPage([842,595]);lines.forEach((line,index)=>page.drawText(line,{font,size:12,x:36,y:550-index*36}));
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1684" height="1190"><rect width="1684" height="1190" fill="white"/><g fill="black" font-family="sans-serif" font-size="24">${lines.map((line,index)=>`<text x="72" y="${90+index*72}">${xml(line)}</text>`).join('')}</g></svg>`;
    const image=await sharp(Buffer.from(svg)).png().toBuffer();images.push(image);
    const embedded=await scanned.embedPng(image);scanned.addPage([842,595]).drawImage(embedded,{x:0,y:0,width:842,height:595});
  }
  return {native:Buffer.from(await native.save()),scanned:Buffer.from(await scanned.save()),images};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const folder=path.resolve('fixtures/bank-statements/generated');await fs.mkdir(folder,{recursive:true});const sources=await createBankSourceFixtures();
  await fs.writeFile(path.join(folder,'synthetic-native-multipage.pdf'),sources.native);
  await fs.writeFile(path.join(folder,'synthetic-scanned-multipage.pdf'),sources.scanned);
  await fs.writeFile(path.join(folder,'synthetic-scanned-page.png'),sources.images[0]);
  await fs.writeFile(path.join(folder,'README.txt'),'Clearly labelled synthetic fixtures. The native and scanned PDFs depict the same two-page statement. The PNG contains page 1 only and must not be treated as the complete two-page statement. These files demonstrate supported input handling, not measured OCR accuracy or bank compatibility. Regenerate with scripts/bank-statement-fixtures.ts.\n');
  console.log('Generated synthetic native/scanned statement sources.');
}
