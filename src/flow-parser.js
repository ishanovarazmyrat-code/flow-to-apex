/**
 * Flow XML → Intermediate Representation (IR)
 *
 * Parses a Salesforce Record-Triggered Flow `.flow-meta.xml` file and produces
 * a normalized IR object that the Apex generator consumes.
 *
 * Supported elements (POC scope):
 *   - recordLookups   (Get Records)
 *   - recordUpdates   (Update Records)
 *   - recordCreates   (Create Records)
 *   - decisions       (Decision)
 *   - loops           (Loop)
 *   - assignments     (Assignment)
 *
 * Unsupported elements are returned in `unsupported[]` so the generator can warn.
 */

const fs = require("fs");
const { XMLParser } = require("fast-xml-parser");

const SUPPORTED_ELEMENT_TYPES = [
    "recordLookups",
    "recordUpdates",
    "recordCreates",
    "recordDeletes",
    "decisions",
    "loops",
    "assignments",
];

const KNOWN_BUT_UNSUPPORTED = [
    "screens",
    "subflows",
    "actionCalls",
    "waits",
    "recordRollbacks",
    "stages",
    "steps",
    "apexPluginCalls",
];

const parserOptions = {
    ignoreAttributes: true,
    ignoreDeclaration: true,
    parseTagValue: true,
    trimValues: true,
    // Always treat these as arrays so callers don't have to handle single vs. multiple
    isArray: (name) => {
        const arrays = new Set([
            "recordLookups",
            "recordUpdates",
            "recordCreates",
            "recordDeletes",
            "decisions",
            "loops",
            "assignments",
            "rules",
            "conditions",
            "filters",
            "assignmentItems",
            "screens",
            "subflows",
            "actionCalls",
            "waits",
        ]);
        return arrays.has(name);
    },
};

function toArray(maybe) {
    if (maybe == null) return [];
    return Array.isArray(maybe) ? maybe : [maybe];
}

function extractValue(valueNode) {
    if (valueNode == null) return null;
    if (valueNode.stringValue !== undefined) return { type: "string", value: valueNode.stringValue };
    if (valueNode.numberValue !== undefined) return { type: "number", value: valueNode.numberValue };
    if (valueNode.booleanValue !== undefined) return { type: "boolean", value: valueNode.booleanValue };
    if (valueNode.dateValue !== undefined) return { type: "date", value: valueNode.dateValue };
    if (valueNode.elementReference !== undefined) return { type: "reference", value: valueNode.elementReference };
    return null;
}

function parseFilter(filter) {
    return {
        field: filter.field,
        operator: filter.operator,
        value: extractValue(filter.value),
    };
}

function parseCondition(condition) {
    return {
        leftValueReference: condition.leftValueReference,
        operator: condition.operator,
        rightValue: extractValue(condition.rightValue),
    };
}

function parseConnector(connectorNode) {
    if (!connectorNode) return null;
    return connectorNode.targetReference || null;
}

function parseStart(start) {
    return {
        object: start.object,
        recordTriggerType: start.recordTriggerType || "Create",
        triggerType: start.triggerType || "RecordAfterSave",
        filterLogic: start.filterLogic || null,
        filters: toArray(start.filters).map(parseFilter),
        next: parseConnector(start.connector),
    };
}

function parseElement(type, raw) {
    const base = {
        type,
        name: raw.name,
        label: raw.label || raw.name,
    };

    switch (type) {
        case "recordLookups":
            return {
                ...base,
                object: raw.object,
                filterLogic: raw.filterLogic || "and",
                filters: toArray(raw.filters).map(parseFilter),
                getFirstRecordOnly: raw.getFirstRecordOnly === true || raw.getFirstRecordOnly === "true",
                storeOutputAutomatically: raw.storeOutputAutomatically === true,
                next: parseConnector(raw.connector),
            };

        case "recordUpdates":
            return {
                ...base,
                inputReference: raw.inputReference,
                object: raw.object || null,
                filters: toArray(raw.filters).map(parseFilter),
                next: parseConnector(raw.connector),
            };

        case "recordCreates":
            return {
                ...base,
                inputReference: raw.inputReference,
                object: raw.object || null,
                next: parseConnector(raw.connector),
            };

        case "recordDeletes":
            return {
                ...base,
                inputReference: raw.inputReference,
                next: parseConnector(raw.connector),
            };

        case "decisions":
            return {
                ...base,
                rules: toArray(raw.rules).map((rule) => ({
                    name: rule.name,
                    label: rule.label || rule.name,
                    conditionLogic: rule.conditionLogic || "and",
                    conditions: toArray(rule.conditions).map(parseCondition),
                    next: parseConnector(rule.connector),
                })),
                defaultConnectorLabel: raw.defaultConnectorLabel || "Default Outcome",
                defaultNext: parseConnector(raw.defaultConnector),
            };

        case "loops":
            return {
                ...base,
                collectionReference: raw.collectionReference,
                iterationOrder: raw.iterationOrder || "Asc",
                nextValueNext: parseConnector(raw.nextValueConnector),
                noMoreValuesNext: parseConnector(raw.noMoreValuesConnector),
            };

        case "assignments":
            return {
                ...base,
                assignmentItems: toArray(raw.assignmentItems).map((item) => ({
                    assignToReference: item.assignToReference,
                    operator: item.operator || "Assign",
                    value: extractValue(item.value),
                })),
                next: parseConnector(raw.connector),
            };

        default:
            return { ...base, raw };
    }
}

function parseFlowXml(xmlString) {
    const parser = new XMLParser(parserOptions);
    const tree = parser.parse(xmlString);

    if (!tree.Flow) {
        throw new Error("Not a valid Flow XML — missing root <Flow> element.");
    }
    const flow = tree.Flow;

    // Reject non-record-triggered flows in this POC
    const triggerType = flow.start?.triggerType;
    const isRecordTriggered = triggerType === "RecordBeforeSave" || triggerType === "RecordAfterSave";
    if (!isRecordTriggered) {
        throw new Error(
            `Unsupported Flow type. This POC only supports Record-Triggered Flows ` +
            `(RecordBeforeSave / RecordAfterSave). Got triggerType="${triggerType || "<missing>"}".`
        );
    }

    const elements = [];
    for (const type of SUPPORTED_ELEMENT_TYPES) {
        for (const raw of toArray(flow[type])) {
            elements.push(parseElement(type, raw));
        }
    }

    const unsupported = [];
    for (const type of KNOWN_BUT_UNSUPPORTED) {
        for (const raw of toArray(flow[type])) {
            unsupported.push({ type, name: raw.name || "<unnamed>" });
        }
    }

    return {
        metadata: {
            label: flow.label,
            apiVersion: flow.apiVersion,
            processType: flow.processType,
            status: flow.status,
        },
        start: parseStart(flow.start),
        elements,
        elementsByName: Object.fromEntries(elements.map((e) => [e.name, e])),
        unsupported,
    };
}

function parseFlowFile(path) {
    const xml = fs.readFileSync(path, "utf8");
    return parseFlowXml(xml);
}

module.exports = { parseFlowXml, parseFlowFile, SUPPORTED_ELEMENT_TYPES, KNOWN_BUT_UNSUPPORTED };
