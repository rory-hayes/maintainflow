-- Existing local installations also receive the schema-qualified trigger.
-- It remains SECURITY INVOKER: the caller's grants and RLS still apply.
CREATE OR REPLACE FUNCTION journal_document_status() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE job_id uuid;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
 END IF;
 IF NEW.status NOT IN ('received','queued','processing','needs_review','processed','failed') THEN RETURN NEW; END IF;
 IF NEW.status <> 'received' THEN
  EXECUTE format('SELECT j.id FROM %I.jobs j WHERE j.workspace_id=$1 AND j.document_id=$2 ORDER BY j.created_at DESC,j.id DESC LIMIT 1',TG_TABLE_SCHEMA)
   INTO job_id USING NEW.workspace_id,NEW.id;
 END IF;
 EXECUTE format('INSERT INTO %I.document_events(workspace_id,document_id,phase,state,operation_id) VALUES($1,$2,$3,$4,$5)',TG_TABLE_SCHEMA)
  USING NEW.workspace_id,NEW.id,'processing',NEW.status,job_id;
 RETURN NEW;
END $$;
