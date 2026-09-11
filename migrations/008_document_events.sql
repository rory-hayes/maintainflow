-- Journal only real transitions after this migration; historical documents are not backfilled.
CREATE TABLE document_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 document_id uuid NOT NULL,
 phase text NOT NULL CHECK(phase IN ('processing','export')),
 state text NOT NULL CHECK(state IN ('received','queued','processing','needs_review','processed','exporting','exported','failed')),
 operation_id uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 details jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(details)='object'),
 FOREIGN KEY(document_id,workspace_id) REFERENCES documents(id,workspace_id) ON DELETE CASCADE,
 CHECK((phase='processing' AND state IN ('received','queued','processing','needs_review','processed','failed'))
    OR (phase='export' AND state IN ('exporting','exported','failed')))
);
CREATE INDEX document_events_document_order ON document_events(workspace_id,document_id,sequence DESC);
ALTER TABLE document_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON document_events
 USING(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid)
 WITH CHECK(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid);
GRANT SELECT,INSERT ON document_events TO folio_app;
GRANT USAGE ON SEQUENCE document_events_sequence_seq TO folio_app;
REVOKE UPDATE,DELETE ON document_events FROM folio_app;

CREATE FUNCTION journal_document_status() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE job_id uuid;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
 END IF;
 -- Export operations have their own journal, independent of current processing state.
 IF NEW.status NOT IN ('received','queued','processing','needs_review','processed','failed') THEN RETURN NEW; END IF;
 IF NEW.status <> 'received' THEN
  EXECUTE format('SELECT j.id FROM %I.jobs j WHERE j.workspace_id=$1 AND j.document_id=$2 ORDER BY j.created_at DESC,j.id DESC LIMIT 1',TG_TABLE_SCHEMA)
   INTO job_id USING NEW.workspace_id,NEW.id;
 END IF;
 EXECUTE format('INSERT INTO %I.document_events(workspace_id,document_id,phase,state,operation_id) VALUES($1,$2,$3,$4,$5)',TG_TABLE_SCHEMA)
  USING NEW.workspace_id,NEW.id,'processing',NEW.status,job_id;
 RETURN NEW;
END $$;
CREATE TRIGGER document_status_journal AFTER INSERT OR UPDATE OF status ON documents
 FOR EACH ROW EXECUTE FUNCTION journal_document_status();
