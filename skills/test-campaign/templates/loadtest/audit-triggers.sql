-- Ground truth for the reconciler. Install ONLY on the disposable load-test DB
-- (the seed's --install-triggers flag), never as a migration.
-- ADAPT: table/column names (entity, status, version, form data, event arrays, workflow instance).
CREATE TABLE IF NOT EXISTS lt_entity_log (
  id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT clock_timestamp(),
  entity_id text NOT NULL, entity_type text NOT NULL,
  old_status text, new_status text, old_version int, new_version int,
  form_changed boolean NOT NULL DEFAULT false, events_len int, corrections_len int
);
CREATE OR REPLACE FUNCTION lt_log_entity() RETURNS trigger AS $$
BEGIN
  IF NEW.type IN ('submission','approval_request','workload','invoice') THEN
    INSERT INTO lt_entity_log(entity_id, entity_type, old_status, new_status, old_version, new_version, form_changed, events_len, corrections_len)
    VALUES (NEW.id, NEW.type,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END, NEW.status,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.version END, NEW.version,
      TG_OP = 'UPDATE' AND (OLD.payload->'submittedFormData') IS DISTINCT FROM (NEW.payload->'submittedFormData'),
      COALESCE(jsonb_array_length(NEW.payload->'events'), 0), COALESCE(jsonb_array_length(NEW.payload->'corrections'), 0));
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS lt_entity_log_trg ON "Entity";
CREATE TRIGGER lt_entity_log_trg AFTER INSERT OR UPDATE ON "Entity" FOR EACH ROW EXECUTE FUNCTION lt_log_entity();

CREATE TABLE IF NOT EXISTS lt_node_log (
  id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT clock_timestamp(),
  instance_id text NOT NULL, entity_id text, from_node text, to_node text, from_status text, to_status text
);
CREATE OR REPLACE FUNCTION lt_log_node() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' OR OLD."currentNodeId" IS DISTINCT FROM NEW."currentNodeId" OR OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO lt_node_log(instance_id, entity_id, from_node, to_node, from_status, to_status)
    VALUES (NEW.id, NEW."submissionId", CASE WHEN TG_OP = 'UPDATE' THEN OLD."currentNodeId" END, NEW."currentNodeId",
            CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END, NEW.status);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS lt_node_log_trg ON "WorkflowInstance";
CREATE TRIGGER lt_node_log_trg AFTER INSERT OR UPDATE ON "WorkflowInstance" FOR EACH ROW EXECUTE FUNCTION lt_log_node();
