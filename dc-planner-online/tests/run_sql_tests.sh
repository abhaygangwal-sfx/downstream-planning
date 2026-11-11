#!/usr/bin/env bash
# Usage: tests/run_sql_tests.sh  (needs a local Postgres; PGHOST/PGPORT/PGUSER as usual)
set -euo pipefail
cd "$(dirname "$0")/.."
dropdb --if-exists dcplanner_test && createdb dcplanner_test
psql -d dcplanner_test -v ON_ERROR_STOP=1 -q -f tests/supabase_stub.sql >/dev/null
psql -d dcplanner_test -v ON_ERROR_STOP=1 -q -f supabase/migrations/001_dc_planner_schema.sql >/dev/null
psql -d dcplanner_test -v ON_ERROR_STOP=1 -q -t -f tests/rls_test.sql 2>&1 | grep -v '^\s*$' | sed -E 's/^psql:[^:]+:[0-9]+: //'
