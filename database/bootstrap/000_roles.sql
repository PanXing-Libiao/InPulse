\set ON_ERROR_STOP on

-- Run exactly once with the PostgreSQL image bootstrap superuser against app.
-- Passwords are provisioned separately; this file never contains credentials.
DO $bootstrap$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_owner') THEN
    CREATE ROLE app_owner
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
      NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE app_owner
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
      NOREPLICATION NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit_writer') THEN
    CREATE ROLE audit_writer
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
      NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE audit_writer
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
      NOREPLICATION NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_migrator') THEN
    CREATE ROLE app_migrator
      LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
      NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE app_migrator
      LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
      NOREPLICATION NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime
      LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
      NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE app_runtime
      LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
      NOREPLICATION NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_backup') THEN
    CREATE ROLE app_backup
      LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
      NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE app_backup
      LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
      NOREPLICATION NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit_reader') THEN
    CREATE ROLE audit_reader
      LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
      NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE audit_reader
      LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
      NOREPLICATION NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'audit_archive_writer'
  ) THEN
    CREATE ROLE audit_archive_writer
      LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
      NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE audit_archive_writer
      LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
      NOREPLICATION NOBYPASSRLS;
  END IF;
END
$bootstrap$;

DO $bootstrap$
DECLARE
  membership RECORD;
BEGIN
  FOR membership IN
    SELECT parent.rolname AS parent_name, member.rolname AS member_name
      FROM pg_auth_members AS relation
      JOIN pg_roles AS parent ON parent.oid = relation.roleid
      JOIN pg_roles AS member ON member.oid = relation.member
     WHERE parent.rolname IN ('app_owner', 'audit_writer')
       AND member.rolname IN (
         'app_runtime',
         'app_backup',
         'audit_reader',
         'audit_archive_writer'
       )
  LOOP
    EXECUTE format(
      'REVOKE %I FROM %I',
      membership.parent_name,
      membership.member_name
    );
  END LOOP;
END
$bootstrap$;

GRANT app_owner TO app_migrator
  WITH INHERIT FALSE, SET TRUE;
GRANT audit_writer TO app_migrator
  WITH INHERIT FALSE, SET TRUE;

SELECT format('ALTER DATABASE %I OWNER TO app_owner', current_database())
\gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database())
\gexec
SELECT format(
  'GRANT CONNECT ON DATABASE %I TO app_migrator, app_runtime, app_backup, audit_reader, audit_archive_writer',
  current_database()
)
\gexec

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM PUBLIC;

SET ROLE app_owner;
CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION app_owner;
ALTER SCHEMA app OWNER TO app_owner;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
RESET ROLE;

REVOKE ALL ON SCHEMA app FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO
  app_migrator,
  app_runtime,
  app_backup,
  audit_reader,
  audit_archive_writer;

ALTER DEFAULT PRIVILEGES FOR ROLE app_owner
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner
  REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE audit_writer
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE audit_writer
  REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE audit_writer
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- app_migrator 必须保留数据库默认 search_path：迁移名均以 app. 限定；
-- 若 app 可见，pg_get_triggerdef() 会省略函数 schema，使 0047 的历史部署
-- 断言误判为不符合预期。
SELECT format(
  'ALTER ROLE app_migrator IN DATABASE %I RESET search_path',
  current_database()
)
\gexec
SELECT format(
  'ALTER ROLE app_runtime IN DATABASE %I SET search_path = app, pg_catalog',
  current_database()
)
\gexec
SELECT format(
  'ALTER ROLE app_backup IN DATABASE %I SET search_path = app, pg_catalog',
  current_database()
)
\gexec
SELECT format(
  'ALTER ROLE audit_reader IN DATABASE %I SET search_path = app, pg_catalog',
  current_database()
)
\gexec
SELECT format(
  'ALTER ROLE audit_archive_writer IN DATABASE %I SET search_path = app, pg_catalog',
  current_database()
)
\gexec
