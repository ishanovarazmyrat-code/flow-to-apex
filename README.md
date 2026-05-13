# flow-to-apex (POC)

A proof-of-concept command-line tool that converts a Salesforce **Record-Triggered Flow** (`.flow-meta.xml`) into an Apex **Trigger + Handler** class, with automatic bulkification for the loop+DML antipattern.

This is a first-iteration POC delivery — scope was intentionally kept narrow so that one end-to-end migration path could be validated cleanly. See [Scope](#scope) below for what is and isn't supported.

A full step-by-step user guide is included as a PDF in [`docs/flow-to-apex_User_Guide.pdf`](docs/flow-to-apex_User_Guide.pdf).

---

## Getting Started

### 1. Clone the tool from GitHub

```bash
cd ~/Desktop   # or wherever you keep your projects
git clone https://github.com/ishanovarazmyrat-code/flow-to-apex.git
cd flow-to-apex
npm install
```

That's it for the tool — no further build step.

### 2. Make sure you have a Salesforce DX project authenticated to your org

If you don't have one yet:

```bash
cd ~/Desktop
sf project generate --name flowToApex --output-dir .
cd flowToApex
sf org login web --alias myDevOrg
```

If you already have an SFDX project, just make sure your target org is authenticated (`sf org list` should show it).

### 3. Add a `convert-flow` shortcut to your shell

Open your shell config (`~/.zshrc` on macOS, `~/.bashrc` on Linux) and append the function below. Replace the two paths with the absolute paths to (a) the cloned `flow-to-apex` folder and (b) your Salesforce DX project.

```bash
# flow-to-apex shortcut
convert-flow() {
    if [ -z "$1" ]; then
        echo "Usage: convert-flow "
        return 1
    fi
    node /Users//Desktop/flow-to-apex/src/cli.js --sfdx \
        --source /Users//Desktop/flowToApex/force-app/main/default/flows/$1.flow-meta.xml \
        --output /Users//Desktop/flowToApex/force-app/main/default
}
```

Reload your shell:

```bash
source ~/.zshrc
```

### 4. Retrieve the Flow you want to convert from the org

In VS Code (with the Salesforce Extension Pack), open your SFDX project, then:

- Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`).
- Run **SFDX: Retrieve Source in Manifest from Org**.
- Pick **Flow** as the metadata type and select the Flow you want to convert.

The Flow's `.flow-meta.xml` file lands in `force-app/main/default/flows/`.

### 5. Run the converter

From any terminal, just type:

```bash
convert-flow Account_Set_Default_Industry
```

(Replace `Account_Set_Default_Industry` with whatever Flow API name you retrieved.)

The tool generates four files into your SFDX project:

- `force-app/main/default/triggers/<Object>Trigger.trigger` (+ `-meta.xml`)
- `force-app/main/default/classes/<FlowLabel>Handler.cls` (+ `-meta.xml`)

### 6. Review, test, deploy

- Open the generated trigger and handler in VS Code, review the logic, and confirm the bulkification looks right.
- Write an Apex test class for the new handler (the converter does not generate tests automatically).
- Deactivate the source Flow in the org so it doesn't double-fire alongside the trigger.
- Right-click `force-app/main/default` in VS Code → **SFDX: Deploy Source to Org**.
- Smoke-test in the org to confirm the Apex behaves the same as the Flow did.

For the full migration workflow with `sf project deploy validate`, branch strategy, and deactivation steps, see `docs/flow-to-apex_User_Guide.pdf`.

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
├── examples/
│   └── output/                // generated Apex from each fixture
└── docs/
    └── flow-to-apex_User_Guide.pdf
```
