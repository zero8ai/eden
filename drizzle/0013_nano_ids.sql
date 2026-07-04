-- Nano ID cutover: every uuid column becomes text, values preserved (a UUID string is
-- valid text — no data rewrite). New rows get app-side 12-char [a-zA-Z] nanoids via
-- $defaultFn(newId); DB-side gen_random_uuid() defaults are dropped.
--
-- Postgres can't retype a column while a foreign key of a different type references it,
-- so: snapshot + drop every FK, convert all uuid columns, re-add the FKs verbatim.
DO $$
DECLARE
  fk record;
  col record;
BEGIN
  CREATE TEMP TABLE _eden_fks ON COMMIT DROP AS
    SELECT conrelid::regclass::text AS tbl,
           conname,
           pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE contype = 'f'
      AND connamespace = 'public'::regnamespace;

  FOR fk IN SELECT * FROM _eden_fks LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', fk.tbl, fk.conname);
  END LOOP;

  FOR col IN
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND data_type = 'uuid'
  LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I DROP DEFAULT', col.table_name, col.column_name);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE text USING %I::text',
                   col.table_name, col.column_name, col.column_name);
  END LOOP;

  FOR fk IN SELECT * FROM _eden_fks LOOP
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', fk.tbl, fk.conname, fk.def);
  END LOOP;
END $$;
