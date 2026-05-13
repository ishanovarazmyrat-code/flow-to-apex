/**
 * Flow IR → traversal helpers
 *
 * Walks the connector graph and exposes utilities the generator needs:
 *   - linearWalk(): visit order starting from start.next (skipping into loops as a
 *     unit — loop bodies are handled separately)
 *   - findLoopBody(loopName): list of element names inside the loop's body
 *   - detectLoopDmlAntipattern(loopName): returns array of DML element names
 *     found inside the loop (these need bulkification lifting)
 */

const DML_TYPES = new Set(["recordUpdates", "recordCreates", "recordDeletes"]);

function findLoopBody(ir, loopName) {
    const loop = ir.elementsByName[loopName];
    if (!loop || loop.type !== "loops") return [];

    const body = [];
    const visited = new Set([loopName]);
    let current = loop.nextValueNext;

    while (current && current !== loopName && !visited.has(current)) {
        visited.add(current);
        const el = ir.elementsByName[current];
        if (!el) break;
        body.push(el.name);

        // Stop traversal at decision (branches handled separately) — POC simplification
        if (el.type === "decisions") break;

        // The body terminates when an element points back to the loop
        const next = getDefaultNext(el);
        if (!next || next === loopName) break;
        current = next;
    }
    return body;
}

function getDefaultNext(element) {
    // Returns the "main" next pointer of an element (ignoring decision branches)
    if (!element) return null;
    switch (element.type) {
        case "decisions":
            // No single next — caller must handle branches
            return null;
        case "loops":
            return element.noMoreValuesNext;
        default:
            return element.next;
    }
}

function detectLoopDmlAntipattern(ir, loopName) {
    const body = findLoopBody(ir, loopName);
    const dmlInLoop = [];
    for (const elementName of body) {
        const el = ir.elementsByName[elementName];
        if (el && DML_TYPES.has(el.type)) {
            dmlInLoop.push({ name: el.name, type: el.type });
        }
    }
    return dmlInLoop;
}

/**
 * Produce a linear walk of top-level elements starting from start.next.
 * Loop elements appear as a single node (their bodies are returned separately).
 * Decision elements terminate the walk (their branches are walked on demand).
 */
function linearWalk(ir) {
    const order = [];
    const visited = new Set();
    let current = ir.start.next;
    while (current && !visited.has(current)) {
        visited.add(current);
        const el = ir.elementsByName[current];
        if (!el) break;
        order.push(el);
        const next = getDefaultNext(el);
        if (next === null) break; // decision — caller resolves branches
        current = next;
    }
    return order;
}

/**
 * Walk a single branch starting from a given element name.
 * Used to follow Decision rule branches and loop bodies in generator.
 */
function walkBranch(ir, startName, stopAt = null) {
    const order = [];
    const visited = new Set();
    let current = startName;
    while (current && !visited.has(current) && current !== stopAt) {
        visited.add(current);
        const el = ir.elementsByName[current];
        if (!el) break;
        order.push(el);
        if (el.type === "decisions" || el.type === "loops") break;
        const next = getDefaultNext(el);
        if (!next) break;
        current = next;
    }
    return order;
}

module.exports = {
    findLoopBody,
    detectLoopDmlAntipattern,
    linearWalk,
    walkBranch,
    getDefaultNext,
    DML_TYPES,
};
