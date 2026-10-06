// frontend/app.js

let network = null;
let nodesDataSet = null;
let edgesDataSet = null;
let topologyNodes = []; // Stores [{ id, name, type }]
let isSimulating = false;
let activeDropdownIndex = -1;

/**
 * Returns distinct dark-terminal colors based on the node's infrastructure type.
 */
function getNodeColorByType(nodeType = '') {
    const type = String(nodeType).toLowerCase();

    if (type.includes('energy') || type.includes('power')) {
        return {
            background: '#1f1608',
            border: '#f0883e',
            highlight: { background: '#3b2609', border: '#ffa657' },
            hover: { background: '#2d1e0b', border: '#ffa657' }
        };
    }
    if (type.includes('water') || type.includes('sanitation')) {
        return {
            background: '#0c1d31',
            border: '#58a6ff',
            highlight: { background: '#132f4c', border: '#79c0ff' },
            hover: { background: '#11263f', border: '#79c0ff' }
        };
    }
    if (type.includes('comms') || type.includes('telecom')) {
        return {
            background: '#1e1433',
            border: '#bc8cff',
            highlight: { background: '#2e1f4d', border: '#d2a8ff' },
            hover: { background: '#261940', border: '#d2a8ff' }
        };
    }
    if (type.includes('health')) {
        return {
            background: '#0d261a',
            border: '#3fb950',
            highlight: { background: '#143a27', border: '#56d364' },
            hover: { background: '#113021', border: '#56d364' }
        };
    }
    if (type.includes('it') || type.includes('cloud') || type.includes('data')) {
        return {
            background: '#0a252c',
            border: '#39c5cf',
            highlight: { background: '#103842', border: '#56d4dd' },
            hover: { background: '#0d2e36', border: '#56d4dd' }
        };
    }
    if (type.includes('safety') || type.includes('emergency')) {
        return {
            background: '#2b1224',
            border: '#f778ba',
            highlight: { background: '#3d1933', border: '#ff9bce' },
            hover: { background: '#34152b', border: '#ff9bce' }
        };
    }
    if (type.includes('transport')) {
        return {
            background: '#261f0a',
            border: '#d29922',
            highlight: { background: '#382d0f', border: '#e3b341' },
            hover: { background: '#2f260c', border: '#e3b341' }
        };
    }

    // Default dark-terminal node theme
    return {
        background: '#161b22',
        border: '#58a6ff',
        highlight: { background: '#1f2937', border: '#00ff00' },
        hover: { background: '#1f2937', border: '#58a6ff' }
    };
}

/**
 * Appends a timestamped terminal log line to #console-log.
 */
function appendLog(text, type = 'system-msg') {
    const consoleLog = document.getElementById('console-log');
    if (!consoleLog) return;

    const el = document.createElement('div');
    el.className = `log-line ${type}`;
    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
    el.textContent = `[${timestamp}] ${text}`;
    consoleLog.appendChild(el);
    consoleLog.scrollTop = consoleLog.scrollHeight;
}

/**
 * Updates the sidebar telemetry counters if present in the DOM.
 */
function updateTelemetry({ state, evaluated, total, failed, survived }) {
    const statState = document.getElementById('stat-state');
    const statEvaluated = document.getElementById('stat-evaluated');
    const statFailed = document.getElementById('stat-failed');
    const statSurvived = document.getElementById('stat-survived');

    if (statState && state !== undefined) {
        statState.textContent = state;
        statState.className = 't-value ' + (
            state === 'RUNNING' ? 'state-running' :
            state === 'COMPLETE' ? 'state-done' : 'state-idle'
        );
    }
    if (statEvaluated && evaluated !== undefined && total !== undefined) {
        statEvaluated.textContent = `${evaluated} / ${total}`;
    }
    if (statFailed && failed !== undefined) {
        statFailed.textContent = String(failed);
    }
    if (statSurvived && survived !== undefined) {
        statSurvived.textContent = String(survived);
    }
}

/**
 * Resets all nodes and edges to their initial sector-colored state.
 */
function resetGraphState() {
    if (!nodesDataSet || !edgesDataSet) return;

    const nodeUpdates = topologyNodes.map(node => ({
        id: node.id,
        label: node.name,
        size: 18,
        color: getNodeColorByType(node.type)
    }));
    nodesDataSet.update(nodeUpdates);

    const edgeUpdates = edgesDataSet.get().map(edge => ({
        id: edge.id,
        width: 1.6,
        color: { color: '#30363d', highlight: '#00ff00', hover: '#58a6ff' }
    }));
    edgesDataSet.update(edgeUpdates);

    updateTelemetry({
        state: 'READY',
        evaluated: 0,
        total: topologyNodes.length,
        failed: 0,
        survived: 0
    });
}

/**
 * Updates the 'Epicenter Node' input field and highlights the selected node on the canvas.
 */
function setEpicenterInput(nodeIdentifier, focusCanvas = false) {
    const epicenterInput = document.getElementById('epicenter-node');
    const dropdown = document.getElementById('epicenter-dropdown');
    if (epicenterInput) {
        epicenterInput.value = nodeIdentifier;
    }
    if (dropdown) {
        dropdown.classList.add('hidden');
    }

    document.querySelectorAll('.chip').forEach(btn => {
        btn.classList.toggle('active-chip', btn.dataset.node === nodeIdentifier);
    });

    if (!isSimulating && nodesDataSet && nodesDataSet.get(nodeIdentifier)) {
        resetGraphState();
        nodesDataSet.update({
            id: nodeIdentifier,
            size: 24,
            color: {
                background: '#0d261a',
                border: '#00ff00',
                highlight: { background: '#0d261a', border: '#00ff00' }
            }
        });
        if (network) {
            network.selectNodes([nodeIdentifier]);
            if (focusCanvas) {
                network.focus(nodeIdentifier, {
                    scale: 1.05,
                    animation: { duration: 350, easingFunction: 'easeInOutQuad' }
                });
            }
        }
    }
}

/**
 * Task 1: Fetch initial infrastructure graph from GET /api/v1/topology
 * and initialize vis.Network on #network-canvas with physics enabled.
 */
async function fetchAndRenderTopology() {
    const container = document.getElementById('network-canvas');
    const nodeCountBadge = document.getElementById('node-count-badge');
    const epicenterInput = document.getElementById('epicenter-node');

    try {
        appendLog('Fetching city infrastructure topology from /api/v1/topology...', 'system-msg');
        const response = await fetch('/api/v1/topology');
        if (!response.ok) {
            throw new Error(`Failed to fetch topology (HTTP ${response.status})`);
        }

        const data = await response.json();
        const rawNodes = Array.isArray(data.nodes) ? data.nodes : [];
        const rawEdges = Array.isArray(data.edges) ? data.edges : [];

        // Normalize backend nodes (supports id, name, type)
        topologyNodes = rawNodes.map(node => {
            const nodeName = node.name || node.label || String(node.id);
            const nodeId = String(node.id ?? nodeName);
            const nodeType = node.type || node.group || 'infrastructure';
            return {
                id: nodeId,
                name: nodeName,
                type: nodeType
            };
        });

        if (nodeCountBadge) {
            nodeCountBadge.textContent = `${topologyNodes.length} nodes`;
        }

        // Map backend nodes into vis.DataSet with sector-specific dark-terminal colors
        nodesDataSet = new vis.DataSet(
            topologyNodes.map(node => ({
                id: node.id,
                label: node.name,
                title: `${node.name} [Type: ${node.type}]`,
                group: node.type,
                color: getNodeColorByType(node.type)
            }))
        );

        // Map backend edges (source -> from, target -> to) into vis.DataSet
        edgesDataSet = new vis.DataSet(
            rawEdges.map((edge, idx) => ({
                id: `edge_${idx}`,
                from: String(edge.source ?? edge.from),
                to: String(edge.target ?? edge.to)
            }))
        );

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
                    color: 'rgba(0, 0, 0, 0.65)',
                    size: 8
                }
            },
            edges: {
                width: 1.6,
                color: { color: '#30363d', highlight: '#00ff00', hover: '#58a6ff' },
                arrows: { to: { enabled: true, scaleFactor: 0.65 } },
                smooth: { type: 'continuous' }
            },
            physics: {
                enabled: true,
                solver: 'forceAtlas2Based',
                forceAtlas2Based: {
                    gravitationalConstant: -90,
                    centralGravity: 0.012,
                    springLength: 160,
                    springConstant: 0.08,
                    damping: 0.45
                },
                stabilization: {
                    enabled: true,
                    iterations: 180
                }
            },
            interaction: {
                hover: true,
                tooltipDelay: 150
            }
        };

        network = new vis.Network(
            container,
            { nodes: nodesDataSet, edges: edgesDataSet },
            options
        );

        // Task 2: Hook up onclick listener on vis.Network to update 'Epicenter Node' input
        network.on('click', (params) => {
            if (params.nodes && params.nodes.length > 0 && !isSimulating) {
                const clickedNodeId = params.nodes[0];
                const clickedNode = topologyNodes.find(n => String(n.id) === String(clickedNodeId));
                const selectedIdentifier = clickedNode ? clickedNode.name : String(clickedNodeId);

                setEpicenterInput(selectedIdentifier, false);
                appendLog(
                    `[NODE SELECTED] Epicenter Node set to '${selectedIdentifier}'.`,
                    'system-msg'
                );
            }
        });

        updateTelemetry({
            state: 'READY',
            evaluated: 0,
            total: topologyNodes.length,
            failed: 0,
            survived: 0
        });

        // Populate default epicenter node if empty or not in graph
        if (topologyNodes.length > 0 && epicenterInput) {
            const currentVal = epicenterInput.value.trim();
            const exists = topologyNodes.some(n => n.name === currentVal || n.id === currentVal);
            const initialNode = exists ? currentVal : topologyNodes[0].name;
            setEpicenterInput(initialNode, false);
        }

        appendLog(
            `Rendered topology: ${topologyNodes.length} nodes and ${rawEdges.length} directed edges.`,
            'system-msg'
        );
    } catch (error) {
        appendLog(`[ERROR] Could not load topology: ${error.message}`, 'trace-fail');
    }
}

/**
 * Task 2: Trigger POST /api/v1/simulate with selected Disaster Type and Epicenter Node,
 * then animate the cascade trace on the vis.Network graph.
 */
async function runSimulation() {
    if (isSimulating) return;

    const disasterSelect = document.getElementById('disaster-type');
    const magnitudeInput = document.getElementById('disaster-magnitude');
    const epicenterInput = document.getElementById('epicenter-node');
    const runBtn = document.getElementById('run-btn');
    const resetBtn = document.getElementById('reset-btn');
    const loadingSpinner = document.getElementById('loading-spinner');
    const consoleLog = document.getElementById('console-log');
    const dropdown = document.getElementById('epicenter-dropdown');

    const disasterType = disasterSelect ? disasterSelect.value : 'Hurricane';
    const magnitude = (magnitudeInput && magnitudeInput.value.trim()) ? magnitudeInput.value.trim() : 'Category 5';
    let epicenterNode = epicenterInput ? epicenterInput.value.trim() : '';

    if (!epicenterNode) {
        appendLog('ERROR: Epicenter Node cannot be empty.', 'trace-fail');
        return;
    }

    // Match user input to a known node name/ID (case-insensitive / partial match)
    const exactNode = topologyNodes.find(
        n => n.name.toLowerCase() === epicenterNode.toLowerCase() ||
             n.id.toLowerCase() === epicenterNode.toLowerCase()
    );
    const partialNode = topologyNodes.find(
        n => n.name.toLowerCase().includes(epicenterNode.toLowerCase())
    );
    if (exactNode) {
        epicenterNode = exactNode.name;
        epicenterInput.value = epicenterNode;
    } else if (partialNode) {
        epicenterNode = partialNode.name;
        epicenterInput.value = epicenterNode;
    }

    isSimulating = true;
    if (runBtn) runBtn.disabled = true;
    if (resetBtn) resetBtn.disabled = true;
    if (dropdown) dropdown.classList.add('hidden');
    if (loadingSpinner) loadingSpinner.classList.remove('hidden');

    resetGraphState();
    if (consoleLog) consoleLog.innerHTML = '';

    updateTelemetry({
        state: 'RUNNING',
        evaluated: 0,
        total: topologyNodes.length,
        failed: 0,
        survived: 0
    });

    appendLog(
        `[INIT] Simulating ${disasterType} (${magnitude}) at epicenter "${epicenterNode}"...`,
        'system-msg'
    );

    try {
        const response = await fetch('/api/v1/simulate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                disaster_type: disasterType,
                magnitude: magnitude,
                epicenter_node: epicenterNode
            })
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.detail || `Simulation failed (HTTP ${response.status})`);
        }

        const executionTrace = await response.json();
        if (loadingSpinner) loadingSpinner.classList.add('hidden');

        appendLog(
            `[TRACE RECEIVED] Animating ${executionTrace.length} node evaluations...`,
            'system-msg'
        );

        await animateExecutionTrace(executionTrace);
    } catch (error) {
        if (loadingSpinner) loadingSpinner.classList.add('hidden');
        updateTelemetry({ state: 'ERROR' });
        appendLog(`[ERROR] ${error.message}`, 'trace-fail');
    } finally {
        isSimulating = false;
        if (runBtn) runBtn.disabled = false;
        if (resetBtn) resetBtn.disabled = false;
    }
}

/**
 * Sequentially animates each evaluated node and edge in the BFS execution trace.
 */
async function animateExecutionTrace(trace) {
    let failedCount = 0;
    let survivedCount = 0;
    const evaluatedSet = new Set();

    for (let i = 0; i < trace.length; i++) {
        const step = trace[i];
        const stepNum = i + 1;
        const nodeName = step.child_node || step.node_name;
        const matchingNode = topologyNodes.find(n => n.name === nodeName || n.id === nodeName);
        const nodeId = matchingNode ? matchingNode.id : nodeName;

        // 1. Highlight node as currently being evaluated
        if (nodesDataSet && nodesDataSet.get(nodeId)) {
            nodesDataSet.update({
                id: nodeId,
                label: `${nodeName}\n[EVALUATING...]`,
                size: 25,
                color: {
                    background: '#d29922',
                    border: '#f0e68c'
                }
            });

            network.focus(nodeId, {
                scale: 1.05,
                animation: { duration: 400, easingFunction: 'easeInOutQuad' }
            });
        }

        await new Promise(resolve => setTimeout(resolve, 450));

        // 2. Update node to FAILED (red) or SURVIVED (green)
        const survived = Boolean(step.status);
        if (survived) {
            survivedCount++;
        } else {
            failedCount++;
        }
        evaluatedSet.add(nodeId);

        const statusColor = survived
            ? { background: '#00ff00', border: '#7ee787', highlight: { background: '#00ff00', border: '#ffffff' } }
            : { background: '#f85149', border: '#ff7b72', highlight: { background: '#f85149', border: '#ffffff' } };

        const statusBadge = survived ? '[SURVIVED]' : '[FAILED]';

        if (nodesDataSet && nodesDataSet.get(nodeId)) {
            nodesDataSet.update({
                id: nodeId,
                label: `${nodeName}\n${statusBadge}`,
                size: survived ? 21 : 24,
                color: statusColor
            });
        }

        // Color the cascading dependency edge
        if (edgesDataSet) {
            const matchingEdges = edgesDataSet.get().filter(edge => {
                if (step.parent_node) {
                    return edge.from === step.parent_node && edge.to === nodeId;
                }
                return edge.to === nodeId && evaluatedSet.has(edge.from);
            });

            matchingEdges.forEach(edge => {
                edgesDataSet.update({
                    id: edge.id,
                    width: 2.8,
                    color: {
                        color: survived ? '#00ff00' : '#f85149',
                        highlight: survived ? '#00ff00' : '#f85149'
                    }
                });
            });
        }

        updateTelemetry({
            state: 'RUNNING',
            evaluated: stepNum,
            total: trace.length,
            failed: failedCount,
            survived: survivedCount
        });

        const logClass = survived ? 'trace-survive' : 'trace-fail';
        const cascadeLabel = step.parent_node
            ? `${step.parent_node} ➔ ${nodeName}`
            : `${nodeName} (EPICENTER)`;

        appendLog(
            `[STEP ${stepNum}/${trace.length}] ${cascadeLabel} [${survived ? 'SURVIVED' : 'FAILED'}]: ${step.reasoning}`,
            logClass
        );

        await new Promise(resolve => setTimeout(resolve, 650));
    }

    updateTelemetry({
        state: 'COMPLETE',
        evaluated: trace.length,
        total: trace.length,
        failed: failedCount,
        survived: survivedCount
    });

    appendLog(
        `[COMPLETE] Simulation finished — ${failedCount} failed, ${survivedCount} survived.`,
        'system-msg'
    );

    if (network) {
        network.fit({ animation: { duration: 800, easingFunction: 'easeInOutQuad' } });
    }
}

/**
 * Searchable dropdown helper for filtering topology nodes in the sidebar.
 */
function renderEpicenterDropdown(filterText = '') {
    const dropdown = document.getElementById('epicenter-dropdown');
    if (!dropdown) return;

    const query = filterText.trim().toLowerCase();
    const matches = topologyNodes.filter(
        n => n.name.toLowerCase().includes(query) || n.type.toLowerCase().includes(query)
    );

    dropdown.innerHTML = '';
    activeDropdownIndex = -1;

    if (matches.length === 0) {
        const emptyEl = document.createElement('div');
        emptyEl.className = 'dropdown-empty';
        emptyEl.textContent = `No infrastructure node matching "${filterText}"`;
        dropdown.appendChild(emptyEl);
        dropdown.classList.remove('hidden');
        return;
    }

    matches.forEach((node, idx) => {
        const item = document.createElement('div');
        item.className = 'dropdown-item';
        item.dataset.nodeId = node.name;
        item.dataset.index = String(idx);

        const nameEl = document.createElement('div');
        nameEl.className = 'dropdown-node-name';
        nameEl.textContent = node.name;

        const typeEl = document.createElement('div');
        typeEl.className = 'dropdown-node-type';
        typeEl.textContent = `Type: ${node.type}`;

        item.appendChild(nameEl);
        item.appendChild(typeEl);

        item.addEventListener('mousedown', (e) => {
            e.preventDefault();
            setEpicenterInput(node.name, true);
            appendLog(`[SELECT] Epicenter Node set to '${node.name}' (${node.type}).`, 'system-msg');
        });

        dropdown.appendChild(item);
    });

    dropdown.classList.remove('hidden');
}

/**
 * Initialize DOM event listeners and fetch initial topology on DOMContentLoaded.
 */
document.addEventListener('DOMContentLoaded', () => {
    fetchAndRenderTopology();

    const runBtn = document.getElementById('run-btn');
    const resetBtn = document.getElementById('reset-btn');
    const epicenterInput = document.getElementById('epicenter-node');
    const clearSearchBtn = document.getElementById('clear-search-btn');
    const dropdown = document.getElementById('epicenter-dropdown');
    const quickChipsContainer = document.getElementById('quick-epicenters');

    if (runBtn) {
        runBtn.addEventListener('click', runSimulation);
    }

    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            if (isSimulating) return;
            resetGraphState();
            if (network) network.fit({ animation: { duration: 500 } });
            appendLog('[RESET] Topology state reset to standby.', 'system-msg');
        });
    }

    if (epicenterInput) {
        epicenterInput.addEventListener('focus', () => renderEpicenterDropdown(epicenterInput.value));
        epicenterInput.addEventListener('input', (e) => renderEpicenterDropdown(e.target.value));
        epicenterInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (dropdown) dropdown.classList.add('hidden');
                runSimulation();
            } else if (e.key === 'Escape' && dropdown) {
                dropdown.classList.add('hidden');
            }
        });
    }

    if (clearSearchBtn && epicenterInput) {
        clearSearchBtn.addEventListener('click', () => {
            epicenterInput.value = '';
            epicenterInput.focus();
            renderEpicenterDropdown('');
        });
    }

    if (quickChipsContainer) {
        quickChipsContainer.addEventListener('click', (e) => {
            const chip = e.target.closest('.chip');
            if (!chip || isSimulating) return;
            setEpicenterInput(chip.dataset.node, true);
            appendLog(`[QUICK SELECT] Epicenter Node set to '${chip.dataset.node}'.`, 'system-msg');
        });
    }

    document.addEventListener('click', (e) => {
        if (dropdown && !e.target.closest('.search-group')) {
            dropdown.classList.add('hidden');
        }
    });
});
