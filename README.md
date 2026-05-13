# flow-to-apex (POC)

A proof-of-concept command-line tool that converts a Salesforce **Record-Triggered Flow** (`.flow-meta.xml`) into an Apex **Trigger + Handler** class.

This is the first POC delivery — scope was intentionally kept narrow per Aykut's "simple working POC" guidance. See [Scope](#scope) below for what is and isn't supported.

---

## What it does

Given a Record-Triggered Flow XML file, it produces four files:

```
<Object>Trigger.trigger              // 1-line trigger, delegates to the handler
<Object>Trigger.trigger-meta.xml
<FlowLabel>Handler.cls               // converted business logic
<FlowLabel>Handler.cls-meta.xml
```

The generated Apex:

- Uses the correct trigger events (`before insert`, `after update`, etc.) based on the Flow's `triggerType` and `recordTriggerType`.
- Wraps logic in a `for (Object record : records)` loop — bulk-safe by construction.
- **Lifts DML out of any inner Flow Loop** that contains an Update / Create / Delete Records element, collecting records into a `Map<Id, SObject>` and issuing a single DML after the loop closes. This is the central correctness concern of the converter — naive 1:1 translation would produce governor limit errors at scale.
- Aggregates `$Record` updates from after-save Flows into a per-fire `Map<Id, SObject>` and issues a single bulk `update` at the end of the method.

---

## Quick start

```bash
# Install dependencies (just fast-xml-parser)
npm install

# Run on a sample, flat output (good for inspecting / diffing)
node src/cli.js \
    --source test/fixtures/flows/Account_Close_Open_Opportunities.flow-meta.xml \
    --output examples/output/Account_Close_Open_Opportunities
```

Output (flat layout, default):

```
examples/output/Account_Close_Open_Opportunities/
├── AccountTrigger.trigger
├── AccountTrigger.trigger-meta.xml
├── AccountCloseOpenOpportunitiesHandler.cls
└── AccountCloseOpenOpportunitiesHandler.cls-meta.xml
```

---

## Usage inside a Salesforce DX project

When you want the converter to drop its output directly into an SFDX project (the typical workflow), pass `--sfdx` and point `--output` at your project's `force-app/main/default` directory. The tool will place trigger files under `triggers/` and class files under `classes/` automatically.

```bash
# From the root of your Salesforce DX project
node /path/to/flow-to-apex/src/cli.js --sfdx \
    --source force-app/main/default/flows/MyFlow.flow-meta.xml \
    --output force-app/main/default
```

Resulting layout:

```
force-app/
└── main/
    └── default/
        ├── classes/
        │   ├── MyFlowHandler.cls
        │   └── MyFlowHandler.cls-meta.xml
        └── triggers/
            ├── AccountTrigger.trigger
            └── AccountTrigger.trigger-meta.xml
```

### Typical migration workflow

The intended day-to-day usage inside a Salesforce project:

```bash
# 1. Branch from main
git checkout main && git pull
git checkout -b flow-migration/MyFlow

# 2. Run the converter against the source Flow
node /path/to/flow-to-apex/src/cli.js --sfdx \
    --source force-app/main/default/flows/MyFlow.flow-meta.xml \
    --output force-app/main/default

# 3. Review the generated Apex
git status
git diff -- force-app/main/default/triggers force-app/main/default/classes

# 4. Add an Apex test class for the converted handler (the tool does not
#    generate one — POC limitation).

# 5. Validate against the target org without deploying
sf project deploy validate \
    --source-dir force-app/main/default \
    --target-org <targetOrg> \
    --test-level RunLocalTests

# 6. If validation passes, commit and open a PR
git add force-app/main/default
git commit -m "Migrate MyFlow to Apex (auto-generated, manually reviewed)"
git push -u origin flow-migration/MyFlow

# 7. After PR review, deactivate the source Flow in the target org and
#    deploy the branch:
sf project deploy start \
    --source-dir force-app/main/default \
    --target-org <targetOrg> \
    --test-level RunLocalTests
```

The Flow itself stays on disk during this process so the team can compare side-by-side; deactivating happens in the org (or via a final commit that flips the Flow's `<status>` to `Draft`).

---

## Scope

### Supported (this POC)

| Area | Supported |
|---|---|
| Flow types | Record-Triggered Flows only (`RecordBeforeSave` / `RecordAfterSave`) |
| Record operations | `Create`, `Update`, `CreateAndUpdate` |
| Flow elements | `recordLookups` (Get Records), `recordUpdates` (Update Records), `recordCreates` (Create Records), `recordDeletes` (Delete Records), `decisions` (Decision), `loops` (Loop), `assignments` (Assignment) |
| Start node entry filter | Yes (compiled into a `continue` guard) |
| Bulkification | Loop + DML antipattern lifting; per-fire `$Record` update collector |
| Output | Apex Trigger + Handler class with sharing-aware metadata |

### Out of scope (parked for later phases)

- Screen Flows, Scheduled Flows, Autolaunched Flows, Platform Event-Triggered Flows
- Subflow chains
- Action Calls (Invocable Apex, Platform Event publishing, HTTP Callout actions)
- Wait elements / Pause / Resume
- Custom Apex Plugin Calls
- Fault path handling (try / catch translation)
- Apex → Flow direction
- CRUD / FLS injection (security review hardening)
- Apex test class generation
- Direct deployment to a Salesforce org

When the parser encounters one of the parked element types, the generator emits a warning comment block at the top of the handler class listing what was skipped — so reviewers know the conversion is incomplete.

---

## Example outputs

The three reference Flows in `test/fixtures/flows/` cover the spectrum:

1. **`Account_Set_Default_Industry.flow-meta.xml`** — simplest case
   Before-save Flow, a Decision and a single Assignment. Generates a clean `record.Industry = 'Other'` inside an `if` block.

2. **`Account_Count_Contacts.flow-meta.xml`** — after-save with $Record update
   Get Records + Assignment + Update Records on `$Record`. The generator aggregates the updates into a `Map<Id, Account> recordsToUpdate` and emits a single bulk `update` at the end of the method.

3. **`Account_Close_Open_Opportunities.flow-meta.xml`** — the antipattern case
   A Loop over related Opportunities with an Update Records element **inside** the loop. Without lifting, this would fail governor limits at scale. The generator detects the pattern, emits a `Map<Id, Opportunity>` collector, and issues a single `update` after the loop.

Generated samples for all three are checked into `examples/output/`.

---

## How it works

```
.flow-meta.xml
     │
     ▼
[ flow-parser.js ]   XML → normalized IR (elements + connectors)
     │
     ▼
[ flow-graph.js ]    Connector graph traversal + loop body / DML detection
     │
     ▼
[ apex-generator.js ] IR → Trigger + Handler Apex
     │
     ▼
  output files
```

Each module is small and single-purpose so the pipeline is easy to extend in later phases (e.g. swap the generator to produce a Queueable, or add a new parser for Screen Flows).

---

## Known limitations / things to review

This is a POC, not production code. Things a developer should review before deploying generated output:

- **No CRUD / FLS checks.** Add `Security.stripInaccessible()` or `WITH SECURITY_ENFORCED` to SOQL.
- **`SELECT Id` only.** The Get Records emitter does not yet introspect which fields are read or written downstream — it generates `SELECT Id FROM ...`. Add fields manually.
- **No formula support.** Flow formulas need a transpilation pass that isn't in this POC.
- **No Apex test class.** Write tests at 200-record scale before deploying.
- **No recursion guard.** If multiple triggers / handlers fire on the same object, add a static flag.
- **Operator coverage is limited.** `EqualTo`, `NotEqualTo`, comparison operators, `IsNull`, and a basic `Contains` are mapped. Anything else lands as a `TODO` comment.

---

## Project layout

```
flow-to-apex/
├── package.json
├── src/
│   ├── cli.js                 // command-line entry point
│   ├── flow-parser.js         // XML → IR
│   ├── flow-graph.js          // connector graph + loop body / DML detection
│   └── apex-generator.js      // IR → Apex (trigger + handler)
├── test/
│   └── fixtures/flows/        // 3 sample .flow-meta.xml inputs
└── examples/
    └── output/                // generated Apex from each fixture
```

---

## Next phase candidates

If this POC is approved for follow-up work, the natural next steps in priority order:

1. **CRUD / FLS injection** (one config flag, big credibility win).
2. **Apex test class generator** alongside the handler.
3. **Field-aware SOQL** — track which fields are referenced and select them.
4. **Subflow + Action Call** support (invocable Apex calls translate cleanly).
5. **Screen Flow logic-only extraction** (UI stays in Flow / LWC; logic moves to Apex).
6. **Direct deployment** via `sf project deploy start` integration.
7. **Apex → Flow direction** (only if there's a strong use case — see scope discussion).
