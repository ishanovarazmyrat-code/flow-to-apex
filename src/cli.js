#!/usr/bin/env node
/**
 * flow-to-apex CLI
 *
 * Usage:
 *   node src/cli.js --source <path/to/Flow.flow-meta.xml> --output <dir>
 *
 * Reads a Salesforce Record-Triggered Flow XML file and writes:
 *   - <Object>Trigger.trigger (+ -meta.xml)
 *   - <Flow>Handler.cls       (+ -meta.xml)
 *
 * POC scope: Record-Triggered Flows only. Supports Get / Update / Create /
 * Delete Records, Decision, Loop, and Assignment elements. Lifts DML out of
 * loops automatically (bulkification). Other element types are skipped with
 * a warning in the generated header.
 */

const fs = require("fs");
const path = require("path");

const { parseFlowFile } = require("./flow-parser");
const { generate } = require("./apex-generator");

function parseArgs(argv) {
    const args = { source: null, output: null, sfdx: false, help: false };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === "-h" || a === "--help") args.help = true;
        else if (a === "--sfdx") args.sfdx = true;
        else if (a === "--source" || a === "-s") args.source = argv[++i];
        else if (a === "--output" || a === "-o") args.output = argv[++i];
        else if (!args.source) args.source = a;
        else if (!args.output) args.output = a;
    }
    return args;
}

function printHelp() {
    console.log(`flow-to-apex POC

Usage:
  flow-to-apex --source <flow.flow-meta.xml> --output <dir> [--sfdx]

Options:
  -s, --source   Path to a .flow-meta.xml file (Record-Triggered Flow)
  -o, --output   Directory to write the generated trigger + class files
      --sfdx     Write files into Salesforce DX layout:
                   <output>/triggers/<Object>Trigger.trigger (+ -meta.xml)
                   <output>/classes/<FlowLabel>Handler.cls   (+ -meta.xml)
                 Without --sfdx, all files land flat in <output>.
  -h, --help     Show this help

Generated files (flat layout):
  <Object>Trigger.trigger              The trigger entry point
  <Object>Trigger.trigger-meta.xml     Metadata
  <FlowLabel>Handler.cls               The handler class with the converted logic
  <FlowLabel>Handler.cls-meta.xml      Metadata

Notes:
  * Use --sfdx to write directly into a Salesforce DX project (e.g. point
    --output at force-app/main/default).
  * The generated Apex is a skeleton intended for developer review. Verify the
    business logic, add CRUD/FLS checks and Apex tests before deploying.
  * Loop + DML antipatterns are automatically bulkified (DML lifted out of loop).
  * Unsupported elements (Screen, Subflow, Action Call, etc.) are listed in a
    warning comment in the generated handler header.
`);
}

function main() {
    const args = parseArgs(process.argv);
    if (args.help || !args.source || !args.output) {
        printHelp();
        process.exit(args.help ? 0 : 1);
    }

    const sourcePath = path.resolve(args.source);
    const outputDir = path.resolve(args.output);

    if (!fs.existsSync(sourcePath)) {
        console.error(`Error: source file not found: ${sourcePath}`);
        process.exit(2);
    }
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    let ir;
    try {
        ir = parseFlowFile(sourcePath);
    } catch (err) {
        console.error(`Parse error: ${err.message}`);
        process.exit(3);
    }

    console.log(`Parsed Flow: ${ir.metadata.label}`);
    console.log(`  Object: ${ir.start.object}`);
    console.log(`  Trigger: ${ir.start.triggerType} (${ir.start.recordTriggerType})`);
    console.log(`  Elements: ${ir.elements.length}`);
    if (ir.unsupported.length > 0) {
        console.log(`  Warning: ${ir.unsupported.length} unsupported element(s) skipped:`);
        for (const u of ir.unsupported) console.log(`    - ${u.type}: ${u.name}`);
    }

    const result = generate(ir);
    for (const file of result.files) {
        const outPath = resolveOutputPath(outputDir, file.name, args.sfdx);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, file.content, "utf8");
        console.log(`  wrote ${path.relative(process.cwd(), outPath)}`);
    }

    console.log(`\nDone. ${result.files.length} files written to ${outputDir}` +
        (args.sfdx ? " (SFDX layout)" : ""));
}

function resolveOutputPath(outputDir, fileName, sfdx) {
    if (!sfdx) return path.join(outputDir, fileName);
    // SFDX layout: triggers go in triggers/, classes go in classes/
    const isTrigger = fileName.endsWith(".trigger") || fileName.endsWith(".trigger-meta.xml");
    const subdir = isTrigger ? "triggers" : "classes";
    return path.join(outputDir, subdir, fileName);
}

main();
