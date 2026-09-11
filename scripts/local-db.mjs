import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const root=process.cwd(),dir=path.join(root,'.local/pg'),sock=path.join(root,'.local/socket');
fs.mkdirSync(sock,{recursive:true,mode:0o700});fs.chmodSync(sock,0o700);
const run=(bin,args,allowFail=false)=>{const r=spawnSync(`/opt/homebrew/bin/${bin}`,args,{stdio:'inherit'});if(r.status&&!allowFail)process.exit(r.status);return r.status;};
const action=process.argv[2]||'start';
if(action==='stop'){run('pg_ctl',['-D',dir,'-m','fast','stop'],true);process.exit(0);}
if(!fs.existsSync(path.join(dir,'PG_VERSION'))){run('initdb',['-D',dir,'-U','folio_admin','--auth-local=trust','--auth-host=reject','--encoding=UTF8','--locale=C']);fs.appendFileSync(path.join(dir,'postgresql.conf'),`\nlisten_addresses = ''\nport = 55432\nunix_socket_directories = '${sock.replaceAll("'","''")}'\nunix_socket_permissions = 0700\nmax_connections = 40\n`);}
const state=spawnSync('/opt/homebrew/bin/pg_ctl',['-D',dir,'status'],{stdio:'ignore'});if(state.status)run('pg_ctl',['-D',dir,'-l',path.join(root,'.local/postgres.log'),'start','-w']);
run('psql',['-h',sock,'-p','55432','-U','folio_admin','-d','postgres','-v','ON_ERROR_STOP=1','-c',"DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='folio_app') THEN CREATE ROLE folio_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; END IF; END $$;"]);
const exists=spawnSync('/opt/homebrew/bin/psql',['-h',sock,'-p','55432','-U','folio_admin','-d','postgres','-Atc',"SELECT 1 FROM pg_database WHERE datname='folio'"],{encoding:'utf8'});if(exists.stdout.trim()!=='1')run('createdb',['-h',sock,'-p','55432','-U','folio_admin','folio']);
console.log('Private local PostgreSQL is ready on .local/socket:55432 (TCP disabled).');
