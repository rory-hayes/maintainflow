-- Only newly opted-in parsers hold their initial jobs for field discovery.
ALTER TABLE schema_suggestions ADD COLUMN auto_setup boolean NOT NULL DEFAULT false;
ALTER TABLE schema_suggestions ADD CONSTRAINT schema_suggestions_parser_tenant UNIQUE(id,parser_id,workspace_id);
ALTER TABLE parsers ADD COLUMN field_setup_state text NOT NULL DEFAULT 'ready'
 CHECK(field_setup_state IN('ready','awaiting_sample','suggesting','failed'));
ALTER TABLE parsers ADD COLUMN field_setup_suggestion_id uuid;
ALTER TABLE parsers ADD COLUMN field_setup_error text CHECK(length(field_setup_error)<=500);
ALTER TABLE parsers ADD CONSTRAINT parser_setup_suggestion
 FOREIGN KEY(field_setup_suggestion_id,id,workspace_id)
 REFERENCES schema_suggestions(id,parser_id,workspace_id)
 ON DELETE SET NULL(field_setup_suggestion_id);
ALTER TABLE jobs ADD COLUMN waiting_for_schema boolean NOT NULL DEFAULT false;
ALTER TABLE jobs ADD CONSTRAINT waiting_schema_job_unclaimed
 CHECK(NOT waiting_for_schema OR (state IN('queued','failed') AND attempts=0 AND lease_owner IS NULL AND lease_until IS NULL));
CREATE INDEX jobs_waiting_schema ON jobs(workspace_id,document_id) WHERE waiting_for_schema;
