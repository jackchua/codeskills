# Demo playbooks

Concrete recipes per change type. Adapt the tooling to the project's stack; keep the shape.
Every playbook assumes output is teed into `demos/<sha>/NN-name.txt` and referenced from
`demo.md`.

---

## Database: synthetic or seeded data

**Claim to prove:** rows exist, are well-formed, are referentially sound, and look real.

```bash
#!/usr/bin/env bash
set -euo pipefail
D="$(dirname "$0")"
PSQL="psql -X -q $DATABASE_URL"

# 1. Regenerate from scratch so the demo proves the generator, not leftovers
npm run db:seed -- --rows 500 --truncate 2>&1 | tee "$D/01-seed-run.txt"

# 2. Counts
$PSQL -c "\
  select 'customers' t, count(*) from customers
  union all select 'orders', count(*) from orders;" | tee "$D/02-counts.txt"

# 3. Random sample, not the first rows
$PSQL --pset=format=markdown -c "\
  select id, email, created_at, country from customers
  order by random() limit 12;" | tee "$D/03-sample-customers.md"

# 4. Realism assertions - each one must be able to fail
$PSQL -v ON_ERROR_STOP=1 -c "\
do \$\$
declare v numeric;
begin
  select count(*) into v from orders o
    left join customers c on c.id = o.customer_id where c.id is null;
  if v > 0 then raise exception 'FAIL orphan orders: %', v; end if;
  raise notice 'PASS referential integrity: 0 orphans';

  select count(distinct customer_id)::numeric / count(*) into v from orders;
  if v > 0.9 then raise exception 'FAIL each customer has ~1 order (ratio %)', v; end if;
  raise notice 'PASS orders cluster per customer (distinct/total = %)', round(v,3);

  select count(*) into v from customers where email like '%@test.com' or email like 'test%';
  if v > 0 then raise exception 'FAIL placeholder emails: %', v; end if;
  raise notice 'PASS no placeholder emails';

  select stddev(total)/nullif(avg(total),0) into v from orders;
  if v < 0.3 then raise exception 'FAIL order totals too uniform (cv=%)', v; end if;
  raise notice 'PASS order totals vary (cv=%)', round(v,3);

  select count(*) into v from orders
    where created_at < now() - interval '2 years' or created_at > now();
  if v > 0 then raise exception 'FAIL timestamps outside intended window: %', v; end if;
  raise notice 'PASS timestamps within window';
end \$\$;" 2>&1 | tee "$D/04-realism-checks.txt"

# 5. Distribution histogram as text - no plotting dependency needed
$PSQL --pset=format=markdown -c "\
  select width_bucket(total, 0, 1000, 10) * 100 as bucket_start,
         count(*), repeat('#', (count(*) / 5)::int) as bar
  from orders group by 1 order by 1;" | tee "$D/05-distribution.md"
```

Text histograms beat PNGs here: diffable, zero dependencies, readable in the CUI.

**Common misses:** seeding on top of existing rows; sampling with `LIMIT 10` (gets insertion
order); checking only counts; no uniqueness check on business keys.

---

## HTTP API: new or changed endpoint

**Claim to prove:** the endpoint responds correctly, including the unhappy paths.

```bash
BASE=http://localhost:3000
{
  echo "### POST /orders - valid"
  curl -sS -w '\nHTTP %{http_code} in %{time_total}s\n' \
    -X POST "$BASE/orders" -H 'content-type: application/json' \
    -d '{"customerId":"c_123","items":[{"sku":"A1","qty":2}]}' | tee /tmp/created.json

  echo; echo "### GET the thing we just created"
  ID=$(jq -r .id < /tmp/created.json)
  curl -sS "$BASE/orders/$ID" | jq .

  echo; echo "### POST /orders - missing customerId (expect 422)"
  curl -sS -w '\nHTTP %{http_code}\n' -X POST "$BASE/orders" \
    -H 'content-type: application/json' -d '{"items":[]}'

  echo; echo "### GET /orders/nope (expect 404)"
  curl -sS -w '\nHTTP %{http_code}\n' "$BASE/orders/nope"
} 2>&1 | tee "$D/01-api-transcript.txt"
```

Use `curl`, not your own SDK. Always include at least one validation failure and one
not-found — an endpoint that only proves the happy path proves very little.

---

## CLI tool or script

```bash
{
  echo '$ mytool --help';        mytool --help
  echo; echo '$ mytool run fixtures/small.csv'; mytool run fixtures/small.csv
  echo; echo '$ mytool run missing.csv  (expect clean error, exit 1)'
  mytool run missing.csv; echo "exit=$?"
} 2>&1 | tee "$D/01-cli-session.txt"
```

Show `--help`, the happy path, and a failure with a *useful* message. If the error message
is bad, that's a finding — fix it before committing.

---

## UI / frontend

Screenshot the states, not just the default one.

```js
// demos/<sha>/shoot.mjs
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
const shot = (n) => p.screenshot({ path: new URL(`./${n}.png`, import.meta.url).pathname });

await p.goto('http://localhost:5173/upload');
await shot('01-empty');
await p.setInputFiles('input[type=file]', 'fixtures/sample.csv');
await p.waitForSelector('[data-testid=chart]');
await shot('02-chart-rendered');
await p.setInputFiles('input[type=file]', 'fixtures/malformed.csv');
await p.waitForSelector('[role=alert]');
await shot('03-error-state');
await p.emulateMedia({ colorScheme: 'dark' }); await shot('04-dark');
await p.setViewportSize({ width: 390, height: 844 }); await shot('05-mobile');
await b.close();
```

Minimum set: empty, loaded, error, mobile. Add dark mode if the project has it.

---

## Data pipeline / ETL

Show input → output with counts reconciled at every stage.

```
Source rows read      12,431
  dropped: malformed      17   (0.14%)
  dropped: duplicate     203   (1.63%)
Rows written          12,211
Reconciliation        12,431 - 17 - 203 = 12,211  OK
```

Then a before/after sample of five records that went through a non-trivial transform, and
the distribution of any derived field. Unreconciled counts are the single most common way a
pipeline is silently wrong.

---

## Bug fix

The demo is the reproduction.

1. Show the bug on the parent commit: `git stash && <repro> && git stash pop`, capture the
   wrong output.
2. Show the same repro passing now.
3. Show the regression test that would have caught it, and that it fails on the old code:
   `git stash; npm test -- <new test>  # fails; git stash pop; npm test  # passes`.

A bug fix without step 3 is a bug fix that will come back.

---

## Performance

Numbers, with the method stated.

```
                         before      after     change
p50 latency (n=1000)      340ms      42ms      -88%
p99 latency               1.2s       110ms     -91%
allocations/req           18.4k      2.1k      -89%

Method: hyperfine --warmup 3 --runs 1000, local, M-series, Postgres in docker,
        cold cache cleared between runs. Same fixture dataset (10k orders).
```

State the hardware, the dataset, the warmup, and the run count, or the numbers mean nothing.
Include the *unimproved* metrics too if any regressed.

---

## External integration

Show the real wire traffic, with secrets redacted.

- The outbound request (headers redacted to `Authorization: Bearer ***`)
- The real response from the sandbox/test environment
- The retry/backoff behaviour under a forced failure
- What happens when the service is down — proof the fallback works

Never demo an integration solely against your own mock. A mock proves your mock works.

---

## Migration

```
Before:  \d orders   →  (schema dump)
Run:     npm run db:migrate   →  (output, timing)
After:   \d orders   →  (schema dump, diffed)
Data:    select count(*) from orders;  -- unchanged: 12,211
Rollback: npm run db:migrate:down  →  schema matches Before
```

Always demonstrate the rollback. A migration you can't reverse is a demo of a future outage.
