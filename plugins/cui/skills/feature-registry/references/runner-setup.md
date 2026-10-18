# Test runner setup

What each runner needs so that `cui registry check` and `cui tdd` can read its results:
JUnit XML in `test_results`, the `[FR-…]` tag visible, and a fast single-feature command.

Tag tests like this, in whatever form the runner allows:

```ts
describe('[FR-MAIL-002] attachments', () => {
  it('accepts exactly 25 MB', …)
  it('rejects 25 MB + 1 byte with a clear message', …)
})
// or per test:
it('[FR-MAIL-002] rejects 25 MB + 1 byte', …)
```

A test may carry several IDs (`[FR-SHARE-003] [FR-DRIVE-010] …`) when it genuinely fails if
either breaks. The tag is read from the test name, its classname, every enclosing suite
name, and `<property name="feature" value="FR-…"/>`.

## Vitest

```ts
// vitest.config.ts
export default defineConfig({
  test: {
    reporters: ['default', 'junit'],
    outputFile: { junit: 'test-results/vitest.xml' },
  },
})
```

```yaml
# .cui/config.yaml
test_command: "npx vitest run"
feature_test_command: "npx vitest run -t '\\[{id}\\]'"
coverage_command: "npx vitest run --coverage"
```

## Jest

`npm i -D jest-junit`, then:

```js
// jest.config.js
reporters: ['default', ['jest-junit', { outputDirectory: 'test-results', outputName: 'jest.xml',
  classNameTemplate: '{classname}', titleTemplate: '{title}', ancestorSeparator: ' › ' }]],
```

```yaml
test_command: "npx jest"
feature_test_command: "npx jest -t '\\[{id}\\]'"
```

## Playwright (e2e, collab, visual)

```ts
// playwright.config.ts
reporter: [['list'], ['junit', { outputFile: 'test-results/playwright.xml' }]],
```

```yaml
feature_test_command: "npx playwright test -g '\\[{id}\\]'"
```

For `collab` cases open two browser contexts in one test (`browser.newContext()` twice),
act in both, and assert they converge. For `visual`, `expect(page).toHaveScreenshot()`.

If you run unit and e2e suites separately, chain them in `test_command`
(`npx vitest run; a=$?; npx playwright test; b=$?; exit $((a|b))`) so both always write
results and either failure fails the run.

## node:test

```yaml
test_command: "node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=test-results/node.xml"
feature_test_command: "node --test --test-name-pattern='\\[{id}\\]' --test-reporter=junit --test-reporter-destination=test-results/node.xml"
```

node:test puts `describe()` names on `<testsuite>`, which the registry reads.

## pytest

```yaml
test_command: "pytest --junitxml=test-results/pytest.xml"
feature_test_command: "pytest --junitxml=test-results/pytest.xml -k '{id_}'"   # {id_}: FR_MAIL_002
```

Function names can't hold brackets, so tag with a property:

```python
def test_rejects_oversized_attachment(record_property):
    record_property("feature", "FR-MAIL-002")
    ...
```

and keep the ID in the name too (`test_FR_MAIL_002_rejects_oversized`) so `-k` can select it.

## Go

```yaml
test_command: "go test -v ./... 2>&1 | go-junit-report -set-exit-code > test-results/go.xml"
feature_test_command: "go test -v -run '/\\[{id}\\]' ./... 2>&1 | go-junit-report -set-exit-code > test-results/go.xml"
```

Tag subtests: `t.Run("[FR-MAIL-002] rejects 25MB+1", …)`.

## Mutation testing (risk: high features)

The registry reads the cross-tool
[mutation-testing-report-schema](https://github.com/stryker-mutator/mutation-testing-elements)
JSON. `{files}` in `mutation_command` is replaced with the selected features' `source` globs,
comma-separated.

**Stryker (JS/TS)** — `npm i -D @stryker-mutator/core` plus the runner plugin for your test
framework (`@stryker-mutator/vitest-runner`, `jest-runner`, …), or the built-in `command`
runner for anything else:

```json
// stryker.config.json
{
  "testRunner": "vitest",
  "reporters": ["json", "clear-text"],
  "coverageAnalysis": "perTest"
}
```

```yaml
mutation_command: "npx stryker run --mutate {files}"
mutation_report: "reports/mutation/mutation.json"   # Stryker's default
mutation_threshold: 60
```

Add `reports/` to `.gitignore`. With `"testRunner": "command"` and
`"commandRunner": { "command": "node --test tests/" }`, Stryker works with any test command,
but slowly, since it reruns the whole suite per mutant.

**Stryker.NET, Stryker4s, Infection (PHP)** write the same schema. Point `mutation_report` at
their JSON output.

**Python / Go**: mutmut, cosmic-ray, gremlins and go-mutesting have their own output formats.
Wrap them in a short script that writes the schema (`files → { "<path>": { "mutants": [
{ "mutatorName", "location": { "start": { "line" } }, "status": "Killed" | "Survived" |
"NoCoverage" | "Timeout" } ] } }`) and use the script as `mutation_command`.

## Checking it works

```bash
node cui/bin/cui.mjs test
node cui/bin/cui.mjs registry list     # every active feature should show n/n tests
```

If a feature shows `0/0` but you can see its tests in the output, the tag isn't reaching the
XML — open the file and look at the `<testcase name=… classname=…>` attributes.
