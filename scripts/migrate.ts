import path from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {databaseConfig} from '../server/core/config.js';
import {databaseSchema,secureDatabaseConfig} from '../server/core/db.js';
import {readMigrations,buildMigrationSql,type MigrationOptions} from './migration-sql.js';
export {scramVerifier,readMigrations,bootstrapSql,buildMigrationSql,type Migration,type MigrationOptions} from './migration-sql.js';

async function main(){
 const migrations=await readMigrations();
 const options:MigrationOptions={schema:databaseSchema,adminRole:process.env.DATABASE_ADMIN_ROLE,appRole:process.env.DATABASE_APP_ROLE};
 if(process.argv.includes('--sql')){
  if(databaseSchema==='public')throw new Error('SQL Editor output requires an explicit private DATABASE_SCHEMA.');
  process.stdout.write(buildMigrationSql(migrations,{...options,bootstrap:!process.argv.includes('--existing')}));return;
 }
 if(databaseSchema!=='public'&&!process.env.DATABASE_MIGRATION_URL)throw new Error('Private schema migration requires a separate DATABASE_MIGRATION_URL. Runtime credentials cannot perform migrations.');
 const connectionString=process.env.DATABASE_MIGRATION_URL??process.env.DATABASE_ADMIN_URL;
 const pool=new pg.Pool(secureDatabaseConfig(connectionString?{connectionString,max:1}:{...databaseConfig,user:process.env.PGADMINUSER||'folio_admin',max:1}));
 const client=await pool.connect();
 try{await client.query(buildMigrationSql(migrations,options));console.log(`Verified ${migrations.length} migrations in application schema ${databaseSchema}.`);}
 catch(error){await client.query('ROLLBACK');throw error;}
 finally{client.release();await pool.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
