#!/bin/sh
set -eu

# Only the empty dedicated Compose database runs this script. The application's
# current migrations create generic public-schema tables and must not be pointed
# at the legacy MaintainFlow database.
for password in "$POSTGRES_PASSWORD" "$FOLIO_DB_APP_PASSWORD"; do
  case "$password" in
    ''|*[!a-zA-Z0-9_-]*)
      echo 'Database passwords must use URL-safe letters, digits, underscores or hyphens.' >&2
      exit 1
      ;;
  esac
  if [ "${#password}" -lt 32 ]; then
    echo 'Database passwords must contain at least 32 URL-safe characters.' >&2
    exit 1
  fi
done
if [ "$POSTGRES_PASSWORD" = "$FOLIO_DB_APP_PASSWORD" ]; then
  echo 'Administrator and application database passwords must be distinct.' >&2
  exit 1
fi

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 --set=app_password="$FOLIO_DB_APP_PASSWORD" <<'SQL'
CREATE ROLE folio_app LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE folio TO folio_app;
SQL
