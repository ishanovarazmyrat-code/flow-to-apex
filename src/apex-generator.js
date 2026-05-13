/**
 * IR → Apex code
 *
 * Generates two files for each Record-Triggered Flow:
 *   - <Object>Trigger.trigger         (single-line, delegates to handler)
 *   - <Flow>Handler.cls               (the actual logic)
 *
 * Bulkification: when a Loop element contains DML in its body, the generator
 * lifts the DML out of the loop, collects records into a Map<Id, SObject>, and
 * issues a single DML after the loop closes. This is the central correctness
 * concern of the POC — naive 1:1 mapping would produce governor limit errors.
 */

const { linearWalk, walkBranch, findLoopBody, detectLoopDmlAntipattern, DML_TYPES } =
    require("./flow-graph");

const INDENT = "    ";

// -------------------- helpers --------------------

function pad(level) {
    return INDENT.repeat(level);
}

function sanitizeIdentifier(name) {
    // Salesforce class names: alphanumeric + underscore, must start with letter
    return name.replace(/[^A-Za-z0-9_]/g, "_");
}

function pascalCase(s) {
    return s
        .split(/[_\s]+/)
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join("");
}

function camelCase(s) {
    const p = pascalCase(s);
    return p.charAt(0).toLowerCase() + p.slice(1);
}

function classNameFromFlow(flowLabel) {
    return sanitizeIdentifier(pascalCase(flowLabel)) + "Handler";
}

function triggerNameFromObject(objectName) {
    return sanitizeIdentifier(objectName) + "Trigger";
}

// Map Flow $Record.Field references and other refs to Apex expressions
function renderReference(ref, context) {
    if (!ref) return "null";
    // $Record.Field → record.Field
    if (ref.startsWith("$Record.")) {
        return "record." + ref.substring("$Record.".length);
    }
    if (ref === "$Record") return "record";
    // Loop variable references: <LoopName>.<Field> → <loopVar>.<Field>
    if (context && context.loopVarReplacements) {
        for (const [loopName, varName] of Object.entries(context.loopVarReplacements)) {
            if (ref === loopName) return varName;
            if (ref.startsWith(loopName + ".")) {
                return varName + "." + ref.substring(loopName.length + 1);
            }
        }
    }
    // Element reference → its generated variable name (e.g. Get_Related_Contacts → getRelatedContacts)
    if (context && context.elementVarNames && context.elementVarNames[ref]) {
        return context.elementVarNames[ref];
    }
    // Plain element name passed through (e.g. before its emit set the var name)
    return sanitizeIdentifier(camelCase(ref));
}

function renderValue(value, context) {
    if (!value) return "null";
    switch (value.type) {
        case "string":
            return `'${String(value.value).replace(/'/g, "\\'")}'`;
        case "number":
            return String(value.value);
        case "boolean":
            return value.value === true || value.value === "true" ? "true" : "false";
        case "date":
            return `Date.valueOf('${value.value}')`;
        case "reference":
            return renderReference(value.value, context);
        default:
            return "null";
    }
}

// Map Flow filter/condition operators to Apex
const COMPARISON_OPS = {
    EqualTo: "==",
    NotEqualTo: "!=",
    GreaterThan: ">",
    GreaterThanOrEqualTo: ">=",
    LessThan: "<",
    LessThanOrEqualTo: "<=",
};

function renderCondition(cond, context) {
    const left = renderReference(cond.leftValueReference, context);
    if (cond.operator === "IsNull") {
        const isNull = cond.rightValue && (cond.rightValue.value === true || cond.rightValue.value === "true");
        return isNull ? `${left} == null` : `${left} != null`;
    }
    if (COMPARISON_OPS[cond.operator]) {
        return `${left} ${COMPARISON_OPS[cond.operator]} ${renderValue(cond.rightValue, context)}`;
    }
    if (cond.operator === "Contains") {
        return `${left} != null && String.valueOf(${left}).contains(${renderValue(cond.rightValue, context)})`;
    }
    return `/* TODO: unsupported operator "${cond.operator}" for ${cond.leftValueReference} */ false`;
}

function joinConditions(conditions, logic, context) {
    const op = (logic || "and").toLowerCase() === "or" ? " || " : " && ";
    return conditions.map((c) => renderCondition(c, context)).join(op);
}

// Render SOQL WHERE clause from Flow Get Records filters
function renderSoqlWhere(filters, logic) {
    if (!filters || filters.length === 0) return "";
    const op = (logic || "and").toLowerCase() === "or" ? " OR " : " AND ";
    const parts = filters.map((f) => {
        const apexOp = COMPARISON_OPS[f.operator] || "=";
        const v = f.value;
        let rhs;
        if (!v) rhs = "null";
        else if (v.type === "reference") {
            rhs = ":" + renderReference(v.value, null);
        } else if (v.type === "string") {
            rhs = `'${String(v.value).replace(/'/g, "\\'")}'`;
        } else if (v.type === "boolean") {
            rhs = v.value === true || v.value === "true" ? "true" : "false";
        } else {
            rhs = String(v.value);
        }
        return `${f.field} ${apexOp === "==" ? "=" : apexOp} ${rhs}`;
    });
    return " WHERE " + parts.join(op);
}

// -------------------- per-element emitters --------------------

function emitElement(el, ir, ctx, level) {
    switch (el.type) {
        case "recordLookups":   return emitRecordLookup(el, ctx, level);
        case "assignments":     return emitAssignment(el, ctx, level);
        case "recordUpdates":   return emitRecordUpdate(el, ctx, level);
        case "recordCreates":   return emitRecordCreate(el, ctx, level);
        case "recordDeletes":   return emitRecordDelete(el, ctx, level);
        case "decisions":       return emitDecision(el, ir, ctx, level);
        case "loops":           return emitLoop(el, ir, ctx, level);
        default:                return [`${pad(level)}// TODO: unsupported element type: ${el.type} (${el.name})`];
    }
}

function emitRecordLookup(el, ctx, level) {
    const varName = camelCase(el.name);
    const where = renderSoqlWhere(el.filters, el.filterLogic);
    const limit = el.getFirstRecordOnly ? " LIMIT 1" : "";
    const lines = [];
    lines.push(`${pad(level)}// Get Records: ${el.label}`);
    if (el.getFirstRecordOnly) {
        lines.push(`${pad(level)}List<${el.object}> ${varName}List = [SELECT Id FROM ${el.object}${where}${limit}];`);
        lines.push(`${pad(level)}${el.object} ${varName} = ${varName}List.isEmpty() ? null : ${varName}List[0];`);
    } else {
        lines.push(`${pad(level)}List<${el.object}> ${varName} = [SELECT Id FROM ${el.object}${where}];`);
    }
    ctx.elementVarNames[el.name] = varName;
    return lines;
}

function emitAssignment(el, ctx, level) {
    const lines = [`${pad(level)}// Assignment: ${el.label}`];
    for (const item of el.assignmentItems) {
        const target = renderReference(item.assignToReference, ctx);
        const rhs = renderValue(item.value, ctx);
        switch (item.operator) {
            case "Add":
                // Collection add (Flow list operator)
                lines.push(`${pad(level)}${target}.add(${rhs});`);
                break;
            case "Subtract":
                lines.push(`${pad(level)}${target} -= ${rhs};`);
                break;
            case "Assign":
            default:
                // Special case: assigning a collection size to a Number field
                if (item.value && item.value.type === "reference") {
                    const refEl = ctx.ir.elementsByName[item.value.value];
                    if (refEl && refEl.type === "recordLookups" && !refEl.getFirstRecordOnly) {
                        lines.push(`${pad(level)}${target} = ${renderReference(item.value.value, ctx)}.size();`);
                        break;
                    }
                }
                lines.push(`${pad(level)}${target} = ${rhs};`);
        }
    }
    return lines;
}

function emitRecordUpdate(el, ctx, level) {
    const inputRef = el.inputReference;
    const lines = [`${pad(level)}// Update Records: ${el.label}`];
    if (inputRef === "$Record") {
        lines.push(`${pad(level)}// $Record updates in before-save context are written by the platform automatically.`);
        lines.push(`${pad(level)}// In after-save context the trigger framework re-fires; collect for batched DML instead.`);
        if (!ctx.isBeforeSave) {
            lines.push(`${pad(level)}recordsToUpdate.put(record.Id, record);`);
            ctx.usesRecordUpdateCollector = true;
        }
    } else if (ctx.loopVarReplacements && ctx.loopVarReplacements[inputRef]) {
        // Inside a loop, originally pointing at the loop variable
        const varName = ctx.loopVarReplacements[inputRef];
        const collectorName = ctx.collectorNamesByLoop[ctx.currentLoop];
        lines.push(`${pad(level)}${collectorName}.put(${varName}.Id, ${varName});`);
    } else {
        lines.push(`${pad(level)}update ${renderReference(inputRef, ctx)};`);
    }
    return lines;
}

function emitRecordCreate(el, ctx, level) {
    const inputRef = el.inputReference;
    return [
        `${pad(level)}// Create Records: ${el.label}`,
        `${pad(level)}insert ${renderReference(inputRef, ctx)};`,
    ];
}

function emitRecordDelete(el, ctx, level) {
    const inputRef = el.inputReference;
    return [
        `${pad(level)}// Delete Records: ${el.label}`,
        `${pad(level)}delete ${renderReference(inputRef, ctx)};`,
    ];
}

function emitDecision(el, ir, ctx, level) {
    const lines = [`${pad(level)}// Decision: ${el.label}`];
    const rules = el.rules || [];
    rules.forEach((rule, idx) => {
        const keyword = idx === 0 ? "if" : "} else if";
        const cond = joinConditions(rule.conditions, rule.conditionLogic, ctx);
        lines.push(`${pad(level)}${keyword} (${cond}) {`);
        if (rule.next) {
            const branchEls = walkBranch(ir, rule.next, /* stopAt */ null);
            for (const be of branchEls) {
                lines.push(...emitElement(be, ir, ctx, level + 1));
            }
        }
    });
    if (rules.length > 0) {
        lines.push(`${pad(level)}}` + (el.defaultNext ? " else {" : ""));
    }
    if (el.defaultNext) {
        const branchEls = walkBranch(ir, el.defaultNext, /* stopAt */ null);
        for (const be of branchEls) {
            lines.push(...emitElement(be, ir, ctx, level + 1));
        }
        lines.push(`${pad(level)}}`);
    }
    return lines;
}

function emitLoop(el, ir, ctx, level) {
    const lines = [];
    const collectionVar = renderReference(el.collectionReference, ctx);
    const loopVar = camelCase(el.name.replace(/^Loop_?/i, "")) + "Item";
    const body = findLoopBody(ir, el.name);
    const dmlInside = detectLoopDmlAntipattern(ir, el.name);
    const collector = `${camelCase(el.name)}ToUpdate`;
    const collectorObject = guessLoopObject(el, ir);

    lines.push(`${pad(level)}// Loop: ${el.label}`);
    if (dmlInside.length > 0) {
        lines.push(
            `${pad(level)}// Bulkification: DML inside loop detected (${dmlInside.map((d) => d.name).join(", ")}). ` +
            `DML lifted out of loop into Map<Id, ${collectorObject}>.`
        );
        lines.push(`${pad(level)}Map<Id, ${collectorObject}> ${collector} = new Map<Id, ${collectorObject}>();`);
    }

    // Set context for inner emissions
    const prevLoopVars = ctx.loopVarReplacements;
    const prevCollectors = ctx.collectorNamesByLoop;
    const prevCurrentLoop = ctx.currentLoop;
    ctx.loopVarReplacements = { ...prevLoopVars, [el.name]: loopVar };
    ctx.collectorNamesByLoop = { ...prevCollectors, [el.name]: collector };
    ctx.currentLoop = el.name;

    const itemType = collectorObject || "SObject";
    lines.push(`${pad(level)}for (${itemType} ${loopVar} : ${collectionVar}) {`);
    for (const elementName of body) {
        const inner = ir.elementsByName[elementName];
        if (!inner) continue;
        lines.push(...emitElement(inner, ir, ctx, level + 1));
    }
    lines.push(`${pad(level)}}`);

    // After-loop bulk DML
    if (dmlInside.length > 0) {
        const dmlOp = dmlInside[0].type === "recordDeletes" ? "delete" :
                      dmlInside[0].type === "recordCreates" ? "insert" : "update";
        lines.push(`${pad(level)}if (!${collector}.isEmpty()) {`);
        lines.push(`${pad(level)}${INDENT}${dmlOp} ${collector}.values();`);
        lines.push(`${pad(level)}}`);
    }

    // Restore context
    ctx.loopVarReplacements = prevLoopVars;
    ctx.collectorNamesByLoop = prevCollectors;
    ctx.currentLoop = prevCurrentLoop;

    // Walk the noMoreValues branch (what comes after the loop in Flow)
    if (el.noMoreValuesNext) {
        const after = walkBranch(ir, el.noMoreValuesNext);
        for (const ae of after) {
            lines.push(...emitElement(ae, ir, ctx, level));
        }
    }

    return lines;
}

function guessLoopObject(loopEl, ir) {
    // The collection reference often points at a recordLookups element
    const colName = loopEl.collectionReference;
    const colEl = ir.elementsByName[colName];
    if (colEl && colEl.type === "recordLookups") return colEl.object;
    return "SObject";
}

// -------------------- top-level generation --------------------

function generate(ir) {
    const triggerObject = ir.start.object;
    const isBeforeSave = ir.start.triggerType === "RecordBeforeSave";
    const recordOp = ir.start.recordTriggerType || "Create";
    const handlerClassName = classNameFromFlow(ir.metadata.label);
    const triggerClassName = triggerNameFromObject(triggerObject);

    const triggerEvents = mapRecordTriggerType(recordOp, isBeforeSave);

    // ---- Handler class ----
    const ctx = {
        ir,
        isBeforeSave,
        triggerObject,
        elementVarNames: {},
        loopVarReplacements: {},
        collectorNamesByLoop: {},
        currentLoop: null,
        usesRecordUpdateCollector: false,
    };

    // Walk top-level elements (decisions terminate the linear walk; we re-enter them as branches)
    const startEl = ir.elementsByName[ir.start.next];
    const bodyLines = [];
    let cursor = startEl;
    const visited = new Set();
    while (cursor && !visited.has(cursor.name)) {
        visited.add(cursor.name);
        // Indent: level 3 because we're inside method (1) → outer for-record loop (2) → body (3)
        bodyLines.push(...emitElement(cursor, ir, ctx, 3));
        if (cursor.type === "decisions") break; // branches walked recursively inside emitDecision
        if (cursor.type === "loops") {
            // The loop emitter also walks the noMoreValuesNext branch, so we're done
            break;
        }
        const nextName = cursor.next;
        cursor = nextName ? ir.elementsByName[nextName] : null;
    }

    const handler = renderHandlerClass({
        className: handlerClassName,
        triggerObject,
        isBeforeSave,
        flowLabel: ir.metadata.label,
        apiVersion: ir.metadata.apiVersion,
        recordOp,
        body: bodyLines.join("\n"),
        unsupported: ir.unsupported,
        startFilters: ir.start.filters,
        startFilterLogic: ir.start.filterLogic,
        usesRecordUpdateCollector: ctx.usesRecordUpdateCollector,
    });

    // ---- Trigger file ----
    const trigger = renderTriggerFile({
        triggerClassName,
        handlerClassName,
        triggerObject,
        triggerEvents,
        isBeforeSave,
    });

    // ---- meta files ----
    const triggerMeta = renderMetaXml(ir.metadata.apiVersion, "ApexTrigger");
    const handlerMeta = renderMetaXml(ir.metadata.apiVersion, "ApexClass");

    return {
        files: [
            { name: `${triggerClassName}.trigger`,             content: trigger },
            { name: `${triggerClassName}.trigger-meta.xml`,    content: triggerMeta },
            { name: `${handlerClassName}.cls`,                 content: handler },
            { name: `${handlerClassName}.cls-meta.xml`,        content: handlerMeta },
        ],
    };
}

function mapRecordTriggerType(recordOp, isBeforeSave) {
    const prefix = isBeforeSave ? "before " : "after ";
    switch (recordOp) {
        case "Create":          return [prefix + "insert"];
        case "Update":          return [prefix + "update"];
        case "CreateAndUpdate": return [prefix + "insert", prefix + "update"];
        case "Delete":          return ["before delete", "after delete"];
        default:                return [prefix + "insert", prefix + "update"];
    }
}

function renderTriggerFile({ triggerClassName, handlerClassName, triggerObject, triggerEvents, isBeforeSave }) {
    const ctxArg = isBeforeSave ? "Trigger.new" : "Trigger.new, Trigger.oldMap";
    const methodName = isBeforeSave ? "beforeSave" : "afterSave";
    return `// =========================================================================
// ${triggerClassName}
// Auto-generated by flow-to-apex POC.
// Original Flow target object: ${triggerObject}
// =========================================================================
trigger ${triggerClassName} on ${triggerObject} (${triggerEvents.join(", ")}) {
    ${handlerClassName}.${methodName}(${ctxArg});
}
`;
}

function renderHandlerClass({
    className, triggerObject, isBeforeSave, flowLabel, apiVersion, recordOp, body, unsupported,
    startFilters, startFilterLogic, usesRecordUpdateCollector,
}) {
    const methodName = isBeforeSave ? "beforeSave" : "afterSave";
    const params = isBeforeSave
        ? `List<${triggerObject}> records`
        : `List<${triggerObject}> records, Map<Id, ${triggerObject}> oldMap`;

    const unsupportedWarning = unsupported.length === 0
        ? ""
        : ` *\n *  WARNING — Unsupported Flow elements were skipped:\n` +
          unsupported.map((u) => ` *    - ${u.type}: ${u.name}`).join("\n") + "\n";

    // Start filter: when present, gate execution
    let filterGuard = "";
    if (startFilters && startFilters.length > 0) {
        const cond = joinConditions(
            startFilters.map((f) => ({
                leftValueReference: "$Record." + f.field,
                operator: f.operator,
                rightValue: f.value,
            })),
            startFilterLogic,
            { ir: { elementsByName: {} } }
        );
        filterGuard =
            `${pad(3)}// Entry filter from Flow start node\n` +
            `${pad(3)}if (!(${cond})) { continue; }\n`;
    }

    // Method-level (per-trigger-fire) collector for $Record updates in after-save context
    const methodPreamble = usesRecordUpdateCollector
        ? `${pad(2)}Map<Id, ${triggerObject}> recordsToUpdate = new Map<Id, ${triggerObject}>();\n\n`
        : "";
    const methodPostamble = usesRecordUpdateCollector
        ? `\n${pad(2)}if (!recordsToUpdate.isEmpty()) {\n${pad(3)}update recordsToUpdate.values();\n${pad(2)}}\n`
        : "";

    return `/**
 * @description     Auto-generated Apex handler converted from Salesforce Flow.
 * @flowLabel       ${flowLabel}
 * @triggerObject   ${triggerObject}
 * @apiVersion      ${apiVersion}
 * @recordOperation ${recordOp}
 * @triggerTiming   ${isBeforeSave ? "before save" : "after save"}
${unsupportedWarning} *  NOTE: This is a POC-generated skeleton. Review business logic,
 *  add CRUD/FLS checks, and write Apex tests before deploying.
 */
public with sharing class ${className} {

    public static void ${methodName}(${params}) {
${methodPreamble}${pad(2)}for (${triggerObject} record : records) {
${filterGuard}${body}
${pad(2)}}${methodPostamble}
    }
}
`;
}

function renderMetaXml(apiVersion, type) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<${type} xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>${apiVersion}</apiVersion>
    <status>Active</status>
</${type}>
`;
}

module.exports = { generate };
