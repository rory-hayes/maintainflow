import postgres from 'postgres';
import { readFile } from 'node:fs/promises';
const connection='postgres://maintaincode_local@127.0.0.1:55439/postgres';
const sql=postgres(connection,{max:1});
const manifest=JSON.parse(await readFile(new URL('../src/lib/database/migration-manifest.json',import.meta.url)));
await sql`create table if not exists maintaincode_local_migrations(name text primary key)`;
for(const migration of manifest){const rows=await sql`select name from maintaincode_local_migrations where name=${migration.name}`;if(rows.length)continue;await sql.begin(async tx=>{await tx.unsafe(await readFile(new URL(`../docs/database/${migration.name}`,import.meta.url),'utf8'));await tx`insert into maintaincode_local_migrations(name) values(${migration.name})`;});console.log(`Applied ${migration.name}`);}
await sql.end();
