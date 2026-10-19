SET LOCAL ROLE app_owner;

-- ADR-020 / ADR-081: the organizations identity sequence needs an explicit
-- read-only grant for app_backup; pg_dump reads last_value during a logical backup.
GRANT USAGE, SELECT ON SEQUENCE app.organizations_id_seq TO app_backup;

DO $verify$
BEGIN
  IF NOT has_sequence_privilege($q$app_backup$q$, $q$app.organizations_id_seq$q$, $q$SELECT$q$) THEN
    RAISE EXCEPTION $m$app_backup must have SELECT on app.organizations_id_seq$m$;
  END IF;
END
$verify$;
