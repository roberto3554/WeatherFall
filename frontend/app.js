// app.js

const networkContainer = document.getElementById('network-canvas');
const runBtn = document.getElementById('run-btn');
const resetBtn = document.getElementById('reset-btn');
const loadingSpinner = document.getElementById('loading-spinner');
const consoleLog = document.getElementById('console-log');
const epicenterInput = document.getElementById('epicenter-node');
const clearSearchBtn = document.getElementById('clear-search-btn');
const epicenterDropdown = document.getElementById('epicenter-dropdown');
const nodeCountBadge = document.getElementById('node-count-badge');
const disasterSelect = document.getElementById('disaster-type');
const quickChipsContainer = document.getElementById('quick-epicenters');

// Telemetry DOM Elements
const statState = document.getElementById('stat-state');
const statEvaluated = document.getElementById('stat-evaluated');
const statFailed = document.getElementById('stat-failed');
const statSurvived = document.getElementById('stat-survived');

let network = null;
let nodesData = new vis.DataSet([]);
let edgesData = new vis.DataSet([]);
let topologyNodes = []; // Array of { id, label, group }
let isSimulating = false;
let activeDropdownIndex = -1;

// Vis.js Options
const options = {
    nodes: {
        shape: 'dot',
        size: 18,
        font: {
            color: '#c9d1d9',
            size: 13,
            face: 'Courier New',
            strokeWidth: 3,
            strokeColor: '#0d1117'
        },
        borderWidth: 2,
        shadow: {
            enabled: true,
            color: 'rgba(0,0,0,0.6)',
            size: 8
        },
        color: {
            background: '#161b22',
            border: '#58a6ff',
            highlight: { background: '#1f2937', border: '#00ff00' },
            hover: { background: '#1f2937', border: '#58a6ff' }
        }
    },
    edges: {
        width: 1.5,
        color: { color: '#30363d', highlight: '#58a6ff', hover: '#58a6ff' },
        arrows: { to: { enabled: true, scaleFactor: 0.65 } },
        smooth: { type: 'cubicBezier', forceDirection: 'none', roundness: 0.35 }
    },
    physics: {
        solver: 'forceAtlas2Based',
        forceAtlas2Based: {
            gravitationalConstant: -95,
            centralGravity: 0.012,
            springLength: 165,
            springConstant: 0.08,
            damping: 0.5
        },
        stabilization: {
            enabled: true,
            iterations: 200
        }
    },
    interaction: {
        hover: true,
        tooltipDelay: 150
    }
};

// Append a line to the bottom terminal console
function appendLog(text, type = 'system-msg') {
    const el = document.createElement('div');
    el.className = `log-line ${type}`;
    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
    el.textContent = `[${timestamp}] ${text}`;
    consoleLog.appendChild(el);
    consoleLog.scrollTop = consoleLog.scrollHeight;
}

// Update Telemetry HUD
function updateTelemetry({ state, evaluated, total, failed, survived }) {
    if (state !== undefined) {
        statState.textContent = state;
        statState.className = 't-value ' + (
            state === 'RUNNING' ? 'state-running' :
            state === 'COMPLETE' ? 'state-done' : 'state-idle'
        );
    }
    if (evaluated !== undefined && total !== undefined) {
        statEvaluated.textContent = `${evaluated} / ${total}`;
    }
    if (failed !== undefined) {
        statFailed.textContent = String(failed);
    }
    if (survived !== undefined) {
        statSurvived.textContent = String(survived);
    }
}

// Reset graph nodes and edges to initial standby visual state
function resetGraphState() {
    const nodeUpdates = topologyNodes.map(node => ({
        id: node.id,
        label: node.id,
        size: 18,
        color: {
            background: '#161b22',
            border: '#58a6ff',
            highlight: { background: '#1f2937', border: '#00ff00' }
        }
    }));
    nodesData.update(nodeUpdates);

    const edgeUpdates = edgesData.get().map(edge => ({
        id: edge.id,
        width: 1.5,
        color: { color: '#30363d', highlight: '#58a6ff' }
    }));
    edgesData.update(edgeUpdates);

    updateTelemetry({
        state: 'READY',
        evaluated: 0,
        total: topologyNodes.length,
        failed: 0,
        survived: 0
    });
}

// Highlight selected epicenter node on graph and quick chips
function selectEpicenterNode(nodeName, focusGraph = true) {
    epicenterInput.value = nodeName;
    epicenterDropdown.classList.add('hidden');

    // Sync quick chips
    document.querySelectorAll('.chip').forEach(btn => {
        btn.classList.toggle('active-chip', btn.dataset.node === nodeName);
    });

    if (!isSimulating && nodesData.get(nodeName)) {
        resetGraphState();
        nodesData.update({
            id: nodeName,
            size: 23,
            color: {
                background: '#1f2937',
                border: '#00ff00'
            }
        });
        if (focusGraph && network) {
            network.selectNodes([nodeName]);
            network.focus(nodeName, {
                scale: 1.05,
                animation: { duration: 350, easingFunction: 'easeInOutQuad' }
            });
        }
    }
}

// Escape regex characters for safe highlighting
function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Render searchable dropdown items
function renderEpicenterDropdown(filterText = '') {
    const query = filterText.trim().toLowerCase();
    const matches = topologyNodes.filter(n =>
        n.id.toLowerCase().includes(query) ||
        (n.group && n.group.toLowerCase().includes(query))
    );

    epicenterDropdown.innerHTML = '';
    activeDropdownIndex = -1;

    if (matches.length === 0) {
        const emptyEl = document.createElement('div');
        emptyEl.className = 'dropdown-empty';
        emptyEl.textContent = `No infrastructure node matching "${filterText}"`;
        epicenterDropdown.appendChild(emptyEl);
        epicenterDropdown.classList.remove('hidden');
        return;
    }

    matches.forEach((node, idx) => {
        const item = document.createElement('div');
        item.className = 'dropdown-item';
        item.dataset.nodeId = node.id;
        item.dataset.index = String(idx);

        const nameEl = document.createElement('div');
        nameEl.className = 'dropdown-node-name';
        if (query) {
            const regex = new RegExp(`(${escapeRegExp(query)})`, 'gi');
            nameEl.innerHTML = node.id.replace(regex, '<mark>$1</mark>');
        } else {
            nameEl.textContent = node.id;
        }

        const typeEl = document.createElement('div');
        typeEl.className = 'dropdown-node-type';
        typeEl.textContent = `Sector: ${node.group || 'Infrastructure'}`;

        item.appendChild(nameEl);
        item.appendChild(typeEl);

        item.addEventListener('mousedown', (e) => {
            e.preventDefault(); // Prevent input blur before selection completes
            selectEpicenterNode(node.id, true);
            appendLog(`[TARGET] Epicenter node set to '${node.id}' (${node.group}).`, 'system-msg');
        });

        epicenterDropdown.appendChild(item);
    });

    epicenterDropdown.classList.remove('hidden');
}

// Fetch topology and initialize vis-network graph
async function initGraph() {
    try {
        appendLog('Connecting to WeatherFall topology service...', 'system-msg');
        const res = await fetch('/api/v1/topology');
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);

        const data = await res.json();
        topologyNodes = data.nodes || [];
        nodeCountBadge.textContent = `${topologyNodes.length} nodes`;

        nodesData.clear();
        edgesData.clear();

        nodesData.add(
            topologyNodes.map(n => ({
                id: n.id,
                label: n.label,
                title: `${n.label} (${n.group || 'Infrastructure'})`,
                group: n.group
            }))
        );

        edgesData.add(
            (data.edges || []).map((e, i) => ({
                id: `edge_${i}`,
                from: e.from,
                to: e.to
            }))
        );

        const graphData = { nodes: nodesData, edges: edgesData };
        network = new vis.Network(networkContainer, graphData, options);

        // Allow clicking any node on the graph to set it as the Epicenter Node
        network.on('click', (params) => {
            if (params.nodes && params.nodes.length > 0 && !isSimulating) {
                const clickedNode = params.nodes[0];
                selectEpicenterNode(clickedNode, false);
                appendLog(`[GRAPH SELECT] Epicenter set to '${clickedNode}'. Press [ EXECUTE SIMULATION ] to start.`, 'system-msg');
            }
        });

        updateTelemetry({
            state: 'READY',
            evaluated: 0,
            total: topologyNodes.length,
            failed: 0,
            survived: 0
        });

        appendLog(`Loaded city topology: ${topologyNodes.length} infrastructure nodes and ${data.edges.length} directed dependencies.`, 'system-msg');

        if (topologyNodes.length > 0) {
            const defaultNode = topologyNodes.find(n => n.id === 'Hydroelectric Dam')
                ? 'Hydroelectric Dam'
                : topologyNodes[0].id;
            selectEpicenterNode(defaultNode, false);
        }
    } catch (err) {
        appendLog(`Failed to load topology: ${err.message}`, 'trace-fail');
    }
}

// Execute Simulation
async function runSimulation() {
    if (isSimulating) return;

    const disaster = disasterSelect.value;
    let epicenter = epicenterInput.value.trim();

    if (!epicenter) {
        appendLog('ERROR: Please select or search for an Epicenter Node.', 'trace-fail');
        return;
    }

    // Fuzzy match if user typed partial or lowercase node name
    const exactMatch = topologyNodes.find(n => n.id.toLowerCase() === epicenter.toLowerCase());
    const partialMatch = topologyNodes.find(n => n.id.toLowerCase().includes(epicenter.toLowerCase()));
    if (exactMatch) {
        epicenter = exactMatch.id;
        epicenterInput.value = epicenter;
    } else if (partialMatch) {
        epicenter = partialMatch.id;
        epicenterInput.value = epicenter;
        appendLog(`[AUTO-MATCH] Matched input to node '${epicenter}'.`, 'system-msg');
    }

    isSimulating = true;
    runBtn.disabled = true;
    resetBtn.disabled = true;
    epicenterDropdown.classList.add('hidden');
    loadingSpinner.classList.remove('hidden');

    resetGraphState();
    consoleLog.innerHTML = '';
    updateTelemetry({
        state: 'RUNNING',
        evaluated: 0,
        total: topologyNodes.length,
        failed: 0,
        survived: 0
    });
    appendLog(`[INIT] Triggering '${disaster}' at epicenter '${epicenter}'...`, 'system-msg');

    try {
        const res = await fetch('/api/v1/simulate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                disaster_type: disaster,
                epicenter_node: epicenter
            })
        });

        if (!res.ok) {
            const errBody = await res.json();
            throw new Error(errBody.detail || `Server error: ${res.status}`);
        }

        const executionTrace = await res.json();
        loadingSpinner.classList.add('hidden');
        appendLog(`[TRACE READY] Evaluating ${executionTrace.length} cascading nodes in BFS order...`, 'system-msg');

        await playbackTrace(executionTrace);
    } catch (err) {
        loadingSpinner.classList.add('hidden');
        updateTelemetry({ state: 'ERROR' });
        appendLog(`[ERROR] ${err.message}`, 'trace-fail');
    } finally {
        isSimulating = false;
        runBtn.disabled = false;
        resetBtn.disabled = false;
    }
}

// Animate the trace sequence step-by-step on the vis-network canvas
async function playbackTrace(trace) {
    let failedCount = 0;
    let survivedCount = 0;
    const evaluatedSet = new Set();

    for (let i = 0; i < trace.length; i++) {
        const step = trace[i];
        const stepNum = i + 1;

        // 1. Pulse node in amber ("Evaluating")
        nodesData.update({
            id: step.node_name,
            label: `${step.node_name}\n[EVALUATING...]`,
            size: 25,
            color: {
                background: '#d29922',
                border: '#f0e68c'
            }
        });

        network.focus(step.node_name, {
            scale: 1.05,
            animation: { duration: 400, easingFunction: 'easeInOutQuad' }
        });

        await new Promise(r => setTimeout(r, 450));

        // 2. Apply final node evaluation status (Red = Failed, Green = Survived)
        if (step.status) {
            survivedCount++;
        } else {
            failedCount++;
        }
        evaluatedSet.add(step.node_name);

        const targetColor = step.status
            ? { background: '#00ff00', border: '#7ee787', highlight: { background: '#00ff00', border: '#ffffff' } }
            : { background: '#f85149', border: '#ff7b72', highlight: { background: '#f85149', border: '#ffffff' } };

        const statusBadge = step.status ? '[ONLINE / BACKUP]' : '[FAILED]';

        nodesData.update({
            id: step.node_name,
            label: `${step.node_name}\n${statusBadge}`,
            size: step.status ? 21 : 24,
            color: targetColor
        });

        // Color outgoing/incoming edges connected to evaluated parent nodes
        const connectedEdges = edgesData.get().filter(
            e => e.to === step.node_name && evaluatedSet.has(e.from)
        );
        connectedEdges.forEach(edge => {
            edgesData.update({
                id: edge.id,
                width: 2.8,
                color: {
                    color: step.status ? '#00ff00' : '#f85149',
                    highlight: step.status ? '#00ff00' : '#f85149'
                }
            });
        });

        updateTelemetry({
            state: 'RUNNING',
            evaluated: stepNum,
            total: trace.length,
            failed: failedCount,
            survived: survivedCount
        });

        const logClass = step.status ? 'trace-survive' : 'trace-fail';
        appendLog(
            `[STEP ${stepNum}/${trace.length}] ${step.node_name} -> ${step.status ? 'SURVIVED' : 'FAILED'} | ${step.reasoning}`,
            logClass
        );

        await new Promise(r => setTimeout(r, 650));
    }

    updateTelemetry({
        state: 'COMPLETE',
        evaluated: trace.length,
        total: trace.length,
        failed: failedCount,
        survived: survivedCount
    });

    appendLog(
        `[COMPLETE] Cascade simulation finished: ${failedCount} nodes failed, ${survivedCount} nodes survived.`,
        'system-msg'
    );

    network.fit({
        animation: { duration: 850, easingFunction: 'easeInOutQuad' }
    });
}

// Search Input Event Listeners
epicenterInput.addEventListener('focus', () => {
    renderEpicenterDropdown(epicenterInput.value);
});

epicenterInput.addEventListener('input', (e) => {
    renderEpicenterDropdown(e.target.value);
});

epicenterInput.addEventListener('keydown', (e) => {
    const items = epicenterDropdown.querySelectorAll('.dropdown-item');
    if (!items.length) return;

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeDropdownIndex = (activeDropdownIndex + 1) % items.length;
        items.forEach((el, idx) => el.classList.toggle('active', idx === activeDropdownIndex));
        items[activeDropdownIndex].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeDropdownIndex = (activeDropdownIndex - 1 + items.length) % items.length;
        items.forEach((el, idx) => el.classList.toggle('active', idx === activeDropdownIndex));
        items[activeDropdownIndex].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
        e.preventDefault();
        if (activeDropdownIndex >= 0 && items[activeDropdownIndex]) {
            const chosen = items[activeDropdownIndex].dataset.nodeId;
            selectEpicenterNode(chosen, true);
            appendLog(`[TARGET] Epicenter node set to '${chosen}'.`, 'system-msg');
        } else {
            epicenterDropdown.classList.add('hidden');
            runSimulation();
        }
    } else if (e.key === 'Escape') {
        epicenterDropdown.classList.add('hidden');
    }
});

clearSearchBtn.addEventListener('click', () => {
    epicenterInput.value = '';
    epicenterInput.focus();
    renderEpicenterDropdown('');
});

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-group')) {
        epicenterDropdown.classList.add('hidden');
    }
});

// Quick-select chip buttons
quickChipsContainer.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip || isSimulating) return;
    const nodeName = chip.dataset.node;
    selectEpicenterNode(nodeName, true);
    appendLog(`[QUICK SELECT] Epicenter target set to '${nodeName}'.`, 'system-msg');
});

// Reset button
resetBtn.addEventListener('click', () => {
    if (isSimulating) return;
    resetGraphState();
    network.fit({ animation: { duration: 500 } });
    appendLog('[RESET] Graph state reset to standby.', 'system-msg');
});

// Run button
runBtn.addEventListener('click', runSimulation);

// Start
initGraph();
