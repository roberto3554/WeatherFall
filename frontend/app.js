// frontend/app.js

let network = null;
let nodesDataSet = null;
let edgesDataSet = null;
let topologyNodes = []; // Stores [{ id, name, type, x, y }]
let isSimulating = false;
let activeDropdownIndex = -1;

// Task 1: Preload the dark-mode Miami map image
const mapImage = new Image();
mapImage.src = '/static/miami-dark-map.png';

// Geographic bounds matching the rendered miami-dark-map.png
const MIAMI_GEO_BOUNDS = {
    minLon: -80.32,
    maxLon: -80.12,
    minLat: 25.71,
    maxLat: 25.86
};

// Canvas bounding box dimensions used by beforeDrawing ctx.drawImage()
let mapBounds = {
    centerX: 0,
    centerY: 0,
    width: 1200,
    height: 950
};

mapImage.onload = function () {
    if (network) {
        network.redraw();
    }
};

/**
 * Projects geographic (lon, lat) or raw (x, y) coordinates onto locked canvas coordinates
 * aligned with the Miami background map bounding box.
 */
function projectNodeCoordinates(rawX, rawY) {
    const x = Number(rawX) || 0;
    const y = Number(rawY) || 0;

    // Detect WGS84 Miami geographic coordinates (lon ~ -80.x, lat ~ 25.x)
    if (x <= -79.0 && x >= -82.0 && y >= 24.5 && y <= 27.0) {
        const normX = (x - MIAMI_GEO_BOUNDS.minLon) / (MIAMI_GEO_BOUNDS.maxLon - MIAMI_GEO_BOUNDS.minLon);
        const normY = (MIAMI_GEO_BOUNDS.maxLat - y) / (MIAMI_GEO_BOUNDS.maxLat - MIAMI_GEO_BOUNDS.minLat);

        const canvasX = (normX - 0.5) * mapBounds.width;
        const canvasY = (normY - 0.5) * mapBounds.height;
        return { x: canvasX, y: canvasY };
    }

    return { x, y };
}

/**
 * Calculates the bounding box dimensions across all projected nodes to center the map.
 */
function calculateMapBounds(nodes) {
    if (!nodes || nodes.length === 0) {
        return { centerX: 0, centerY: 0, width: 1200, height: 950 };
    }

    // If nodes are projected from Miami WGS84 bounds, keep 1:1 alignment with miami-dark-map.png
    const hasGeoNodes = nodes.some(
        n => n.rawX <= -79.0 && n.rawX >= -82.0 && n.rawY >= 24.5 && n.rawY <= 27.0
    );
    if (hasGeoNodes) {
        return { centerX: 0, centerY: 0, width: 1200, height: 950 };
    }

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    nodes.forEach(n => {
        if (n.x < minX) minX = n.x;
        if (n.x > maxX) maxX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.y > maxY) maxY = n.y;
    });

    const padding = 220;
    const width = Math.max(800, (maxX - minX) + padding * 2);
    const height = Math.max(650, (maxY - minY) + padding * 2);
    return {
        centerX: (minX + maxX) / 2,
        centerY: (minY + maxY) / 2,
        width,
        height
    };
}

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
 * Updates the sidebar telemetry counters.
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
        size: 16,
        color: getNodeColorByType(node.type)
    }));
    nodesDataSet.update(nodeUpdates);

    const edgeUpdates = edgesDataSet.get().map(edge => ({
        id: edge.id,
        width: 1.5,
        color: { color: 'rgba(88, 166, 255, 0.28)', highlight: '#00ff00', hover: '#58a6ff' }
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
            size: 22,
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
                    scale: 1.15,
                    animation: { duration: 350, easingFunction: 'easeInOutQuad' }
                });
            }
        }
    }
}

/**
 * Task 1 & Task 2: Fetch topology from GET /api/v1/topology, render synchronized
 * Miami map in network.on("beforeDrawing"), and lock node positions with pan/zoom enabled.
 */
async function fetchAndRenderTopology() {
    const container = document.getElementById('network-canvas');
    const nodeCountBadge = document.getElementById('node-count-badge');
    const epicenterInput = document.getElementById('epicenter-node');

    try {
        appendLog('Fetching Miami infrastructure topology from /api/v1/topology...', 'system-msg');
        const response = await fetch('/api/v1/topology');
        if (!response.ok) {
            throw new Error(`Failed to fetch topology (HTTP ${response.status})`);
        }

        const data = await response.json();
        const rawNodes = Array.isArray(data.nodes) ? data.nodes : [];
        const rawEdges = Array.isArray(data.edges) ? data.edges : [];

        // Normalize backend nodes and project spatial coordinates onto canvas
        topologyNodes = rawNodes.map(node => {
            const nodeName = node.name || node.label || String(node.id);
            const nodeId = String(node.id ?? nodeName);
            const nodeType = node.type || node.group || 'infrastructure';
            const rawX = Number(node.x ?? 0);
            const rawY = Number(node.y ?? 0);
            const projected = projectNodeCoordinates(rawX, rawY);

            return {
                id: nodeId,
                name: nodeName,
                type: nodeType,
                rawX,
                rawY,
                x: projected.x,
                y: projected.y
            };
        });

        mapBounds = calculateMapBounds(topologyNodes);

        if (nodeCountBadge) {
            nodeCountBadge.textContent = `${topologyNodes.length} nodes`;
        }

        // Map backend nodes into vis.DataSet with locked geographic coordinates
        nodesDataSet = new vis.DataSet(
            topologyNodes.map(node => ({
                id: node.id,
                label: node.name,
                title: `${node.name} [${node.type.toUpperCase()}] (${node.rawY.toFixed(4)}, ${node.rawX.toFixed(4)})`,
                group: node.type,
                x: node.x,
                y: node.y,
                color: getNodeColorByType(node.type)
            }))
        );

        edgesDataSet = new vis.DataSet(
            rawEdges.map((edge, idx) => ({
                id: `edge_${idx}`,
                from: String(edge.source ?? edge.from),
                to: String(edge.target ?? edge.to)
            }))
        );

        // Task 2: Disable node dragging while enabling pan (dragView) and zoom (zoomView)
        const options = {
            nodes: {
                shape: 'dot',
                size: 16,
                font: {
                    color: '#e6edf3',
                    size: 12,
                    face: 'Courier New',
                    strokeWidth: 3,
                    strokeColor: '#060c14'
                },
                borderWidth: 2,
                shadow: {
                    enabled: true,
                    color: 'rgba(0, 0, 0, 0.75)',
                    size: 8
                }
            },
            edges: {
                width: 1.5,
                color: { color: 'rgba(88, 166, 255, 0.28)', highlight: '#00ff00', hover: '#58a6ff' },
                arrows: { to: { enabled: true, scaleFactor: 0.6 } },
                smooth: { type: 'continuous' }
            },
            physics: {
                enabled: false
            },
            interaction: {
                dragNodes: false,
                dragView: true,
                zoomView: true,
                hover: true,
                tooltipDelay: 150
            }
        };

        network = new vis.Network(
            container,
            { nodes: nodesDataSet, edges: edgesDataSet },
            options
        );

        // Task 1: Draw the preloaded Miami dark map centered on the bounding box before drawing nodes
        network.on('beforeDrawing', function (ctx) {
            if (mapImage.complete && mapImage.naturalWidth > 0) {
                const drawX = mapBounds.centerX - mapBounds.width / 2;
                const drawY = mapBounds.centerY - mapBounds.height / 2;
                ctx.save();
                ctx.drawImage(mapImage, drawX, drawY, mapBounds.width, mapBounds.height);
                ctx.strokeStyle = 'rgba(88, 166, 255, 0.25)';
                ctx.lineWidth = 1.5;
                ctx.strokeRect(drawX, drawY, mapBounds.width, mapBounds.height);
                ctx.restore();
            }
        });

        // Update 'Epicenter Node' when user taps/clicks a node on the canvas
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

        network.fit({ animation: { duration: 400 } });

        updateTelemetry({
            state: 'READY',
            evaluated: 0,
            total: topologyNodes.length,
            failed: 0,
            survived: 0
        });

        if (topologyNodes.length > 0 && epicenterInput) {
            const currentVal = epicenterInput.value.trim();
            const exists = topologyNodes.some(n => n.name === currentVal || n.id === currentVal);
            const initialNode = exists ? currentVal : topologyNodes[0].name;
            setEpicenterInput(initialNode, false);
        }

        appendLog(
            `Rendered Miami map topology: ${topologyNodes.length} nodes and ${rawEdges.length} directed edges.`,
            'system-msg'
        );
    } catch (error) {
        appendLog(`[ERROR] Could not load topology: ${error.message}`, 'trace-fail');
    }
}

/**
 * Trigger POST /api/v1/simulate and animate the cascade trace on the map.
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
    const sidebar = document.getElementById('control-sidebar');
    const sidebarToggleBtn = document.getElementById('sidebar-toggle-btn');

    const disasterType = disasterSelect ? disasterSelect.value : 'Hurricane';
    const magnitude = (magnitudeInput && magnitudeInput.value.trim()) ? magnitudeInput.value.trim() : 'Category 5';
    let epicenterNode = epicenterInput ? epicenterInput.value.trim() : '';

    if (!epicenterNode) {
        appendLog('ERROR: Epicenter Node cannot be empty.', 'trace-fail');
        return;
    }

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

    // On mobile viewports, auto-collapse the floating control card so the map is visible during playback
    if (window.innerWidth <= 768 && sidebar && !sidebar.classList.contains('collapsed')) {
        sidebar.classList.add('collapsed');
        if (sidebarToggleBtn) sidebarToggleBtn.textContent = '[ CONTROLS ▼ ]';
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

        if (nodesDataSet && nodesDataSet.get(nodeId)) {
            nodesDataSet.update({
                id: nodeId,
                label: `${nodeName}\n[EVALUATING...]`,
                size: 23,
                color: {
                    background: '#d29922',
                    border: '#f0e68c'
                }
            });

            network.focus(nodeId, {
                scale: 1.1,
                animation: { duration: 400, easingFunction: 'easeInOutQuad' }
            });
        }

        await new Promise(resolve => setTimeout(resolve, 420));

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
                size: survived ? 19 : 22,
                color: statusColor
            });
        }

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

        await new Promise(resolve => setTimeout(resolve, 600));
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
 * Initialize DOM event listeners, mobile drawer toggles, and topology on DOMContentLoaded.
 */
document.addEventListener('DOMContentLoaded', () => {
    fetchAndRenderTopology();

    const runBtn = document.getElementById('run-btn');
    const resetBtn = document.getElementById('reset-btn');
    const epicenterInput = document.getElementById('epicenter-node');
    const clearSearchBtn = document.getElementById('clear-search-btn');
    const dropdown = document.getElementById('epicenter-dropdown');
    const quickChipsContainer = document.getElementById('quick-epicenters');

    // Mobile control card & collapsible terminal elements
    const sidebar = document.getElementById('control-sidebar');
    const sidebarToggleBtn = document.getElementById('sidebar-toggle-btn');
    const consoleDrawer = document.getElementById('console-drawer');
    const consoleHeader = document.getElementById('console-header');
    const consoleToggleBtn = document.getElementById('console-toggle-btn');

    // Default console to collapsed on mobile so it doesn't obscure the map
    if (window.innerWidth <= 768 && consoleDrawer && consoleToggleBtn) {
        consoleDrawer.classList.add('collapsed');
        consoleToggleBtn.textContent = '[ EXPAND ▲ ]';
    }

    if (sidebarToggleBtn && sidebar) {
        sidebarToggleBtn.addEventListener('click', () => {
            const isCollapsed = sidebar.classList.toggle('collapsed');
            sidebarToggleBtn.textContent = isCollapsed ? '[ CONTROLS ▼ ]' : '[ HIDE ▲ ]';
        });
    }

    if (consoleHeader && consoleDrawer && consoleToggleBtn) {
        consoleHeader.addEventListener('click', () => {
            const isCollapsed = consoleDrawer.classList.toggle('collapsed');
            consoleToggleBtn.textContent = isCollapsed ? '[ EXPAND ▲ ]' : '[ COLLAPSE ▼ ]';
        });
    }

    if (runBtn) {
        runBtn.addEventListener('click', runSimulation);
    }

    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            if (isSimulating) return;
            resetGraphState();
            if (network) network.fit({ animation: { duration: 500 } });
            appendLog('[RESET] Map and topology state reset to standby.', 'system-msg');
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
