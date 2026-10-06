// frontend/app.js

let network = null;
let nodesDataSet = null;
let edgesDataSet = null;
let topologyNodes = []; // Stores [{ id, name, type, rawX, rawY, x, y }]
let isSimulating = false;
let activeDropdownIndex = -1;

// Preload the dark-mode Miami map image
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
    width: 1800,
    height: 1425
};

mapImage.onload = function () {
    if (network) {
        network.redraw();
    }
};

/**
 * Helper to encode raw SVG markup into a valid data URI.
 */
function toSvgDataUri(svgString) {
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgString.trim());
}

/**
 * Generates minimalist, terminal-style inline SVG string for each infrastructure type.
 * Supports an optional strokeOverride for simulation states (evaluating, failed, survived).
 */
function createTerminalSvg(nodeType = 'energy', strokeOverride = null) {
    const type = String(nodeType).toLowerCase();

    if (type.includes('water') || type.includes('sanitation')) {
        const stroke = strokeOverride || '#00FFFF';
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" width="36" height="36">
            <circle cx="18" cy="18" r="16" fill="#060c14" fill-opacity="0.78" stroke="${stroke}" stroke-width="1.8"/>
            <path d="M18 7 C18 7 10 17 10 22 A8 8 0 0 0 26 22 C26 17 18 7 18 7 Z" fill="none" stroke="${stroke}" stroke-width="2.2" stroke-linejoin="round"/>
            <path d="M14 23 A4 4 0 0 0 18 26" fill="none" stroke="${stroke}" stroke-width="1.6" stroke-linecap="round"/>
        </svg>`;
    }

    if (type.includes('transport')) {
        const stroke = strokeOverride || '#FFA500';
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" width="36" height="36">
            <circle cx="18" cy="18" r="16" fill="#060c14" fill-opacity="0.78" stroke="${stroke}" stroke-width="1.8"/>
            <path d="M7 24 L29 24 M11 24 L11 14 M25 24 L25 14 M7 19 Q18 10 29 19" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            <line x1="18" y1="14" x2="18" y2="24" stroke="${stroke}" stroke-width="1.6" stroke-dasharray="2,2"/>
        </svg>`;
    }

    if (type.includes('health')) {
        const stroke = strokeOverride || '#00FF00';
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" width="36" height="36">
            <circle cx="18" cy="18" r="16" fill="#060c14" fill-opacity="0.78" stroke="${stroke}" stroke-width="1.8"/>
            <path d="M15 9 H21 V15 H27 V21 H21 V27 H15 V21 H9 V15 H15 Z" fill="none" stroke="${stroke}" stroke-width="2.2" stroke-linejoin="round"/>
        </svg>`;
    }

    if (type.includes('comms') || type.includes('telecom')) {
        const stroke = strokeOverride || '#00FF00';
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" width="36" height="36">
            <circle cx="18" cy="18" r="16" fill="#060c14" fill-opacity="0.78" stroke="${stroke}" stroke-width="1.8"/>
            <path d="M18 14 L12 28 M18 14 L24 28 M14 23 H22" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            <circle cx="18" cy="12" r="2" fill="${stroke}"/>
            <path d="M12 9 A8 8 0 0 1 24 9 M9 6.5 A12 12 0 0 1 27 6.5" fill="none" stroke="${stroke}" stroke-width="1.6" stroke-linecap="round"/>
        </svg>`;
    }

    // Default: 'energy' / power lightning bolt (#00FF00)
    const stroke = strokeOverride || '#00FF00';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" width="36" height="36">
        <circle cx="18" cy="18" r="16" fill="#060c14" fill-opacity="0.78" stroke="${stroke}" stroke-width="1.8"/>
        <polygon points="20,7 10,20 17,20 15,29 26,16 19,16" fill="none" stroke="${stroke}" stroke-width="2.2" stroke-linejoin="round"/>
    </svg>`;
}

// Task 1: Dictionary of inline SVG data URIs for each node type
const SVG_ICONS = {
    energy: toSvgDataUri(createTerminalSvg('energy')),
    health: toSvgDataUri(createTerminalSvg('health')),
    comms: toSvgDataUri(createTerminalSvg('comms')),
    water: toSvgDataUri(createTerminalSvg('water')),
    transport: toSvgDataUri(createTerminalSvg('transport'))
};

/**
 * Returns the appropriate inline SVG data URI for a given node type and optional status stroke color.
 */
function getNodeSvgIcon(nodeType = 'energy', strokeOverride = null) {
    if (strokeOverride) {
        return toSvgDataUri(createTerminalSvg(nodeType, strokeOverride));
    }
    const type = String(nodeType).toLowerCase();
    if (type.includes('water')) return SVG_ICONS.water;
    if (type.includes('transport')) return SVG_ICONS.transport;
    if (type.includes('health')) return SVG_ICONS.health;
    if (type.includes('comms') || type.includes('telecom')) return SVG_ICONS.comms;
    return SVG_ICONS.energy;
}

/**
 * Task 2: Truncates a node label to max 15 characters with ellipsis (...)
 */
function truncateLabel(name = '', maxLen = 15) {
    const str = String(name).trim();
    return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
}

/**
 * Projects geographic (lon, lat) or raw (x, y) coordinates onto locked canvas coordinates
 * aligned with the Miami background map bounding box.
 */
function projectNodeCoordinates(rawX, rawY) {
    const x = Number(rawX) || 0;
    const y = Number(rawY) || 0;

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
 * Gently pushes apart nearby nodes whose labels would overlap on screen
 * while preserving their relative geographic layout.
 */
function declusterNodePositions(nodes, minDx = 135, minDy = 64, iterations = 35) {
    for (let iter = 0; iter < iterations; iter++) {
        let moved = false;
        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                const a = nodes[i];
                const b = nodes[j];
                let dx = b.x - a.x;
                let dy = b.y - a.y;

                if (Math.abs(dx) < minDx && Math.abs(dy) < minDy) {
                    moved = true;
                    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
                        dx = (i % 2 === 0 ? 1 : -1) * 10;
                        dy = (j % 2 === 0 ? 1 : -1) * 10;
                    }
                    const overlapX = (minDx - Math.abs(dx)) * 0.25 * (dx >= 0 ? 1 : -1);
                    const overlapY = (minDy - Math.abs(dy)) * 0.35 * (dy >= 0 ? 1 : -1);
                    a.x -= overlapX;
                    b.x += overlapX;
                    a.y -= overlapY;
                    b.y += overlapY;
                }
            }
        }
        if (!moved) break;
    }
}

/**
 * Calculates the bounding box dimensions across all projected nodes to center the map.
 */
function calculateMapBounds(nodes) {
    if (!nodes || nodes.length === 0) {
        return { centerX: 0, centerY: 0, width: 1800, height: 1425 };
    }

    const hasGeoNodes = nodes.some(
        n => n.rawX <= -79.0 && n.rawX >= -82.0 && n.rawY >= 24.5 && n.rawY <= 27.0
    );
    if (hasGeoNodes) {
        return { centerX: 0, centerY: 0, width: 1800, height: 1425 };
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
 * Resets all nodes and edges to their initial inline SVG icon state.
 */
function resetGraphState() {
    if (!nodesDataSet || !edgesDataSet) return;

    const nodeUpdates = topologyNodes.map(node => ({
        id: node.id,
        label: truncateLabel(node.name, 15),
        title: node.name,
        size: 18,
        shape: 'image',
        image: getNodeSvgIcon(node.type)
    }));
    nodesDataSet.update(nodeUpdates);

    const edgeUpdates = edgesDataSet.get().map(edge => ({
        id: edge.id,
        width: 1.4,
        color: { color: 'rgba(88, 166, 255, 0.25)', highlight: '#00ff00', hover: '#58a6ff' }
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
        const targetNode = topologyNodes.find(n => n.id === nodeIdentifier || n.name === nodeIdentifier);
        nodesDataSet.update({
            id: nodeIdentifier,
            size: 24,
            image: getNodeSvgIcon(targetNode ? targetNode.type : 'energy', '#00FF00')
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
 * Task 1 & Task 2: Fetch topology from GET /api/v1/topology, map each node to its
 * inline SVG icon with truncated 15-char labels and full native hover tooltips.
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

        topologyNodes = rawNodes.map(node => {
            const nodeName = node.name || node.label || String(node.id);
            const nodeId = String(node.id ?? nodeName);
            const nodeType = node.type || node.group || 'energy';
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

        declusterNodePositions(topologyNodes);
        mapBounds = calculateMapBounds(topologyNodes);

        if (nodeCountBadge) {
            nodeCountBadge.textContent = `${topologyNodes.length} nodes`;
        }

        // Map backend nodes into vis.DataSet with shape: 'image', SVG data URIs, and 15-char truncated labels
        nodesDataSet = new vis.DataSet(
            topologyNodes.map(node => ({
                id: node.id,
                label: truncateLabel(node.name, 15),
                title: node.name,
                group: node.type,
                shape: 'image',
                image: getNodeSvgIcon(node.type),
                x: node.x,
                y: node.y
            }))
        );

        edgesDataSet = new vis.DataSet(
            rawEdges.map((edge, idx) => ({
                id: `edge_${idx}`,
                from: String(edge.source ?? edge.from),
                to: String(edge.target ?? edge.to)
            }))
        );

        // Task 2: Global vis.Network options with dark-halo font stroke and native hover tooltips
        const options = {
            nodes: {
                shape: 'image',
                size: 18,
                font: {
                    color: '#ffffff',
                    strokeWidth: 4,
                    strokeColor: '#0d1117',
                    size: 12,
                    face: 'Courier New'
                }
            },
            edges: {
                width: 1.4,
                color: { color: 'rgba(88, 166, 255, 0.25)', highlight: '#00ff00', hover: '#58a6ff' },
                arrows: { to: { enabled: true, scaleFactor: 0.55 } },
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
                tooltipDelay: 200
            }
        };

        network = new vis.Network(
            container,
            { nodes: nodesDataSet, edges: edgesDataSet },
            options
        );

        // Synchronized Miami dark map rendering behind nodes
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

        // Update 'Epicenter Node' when user clicks a node on the canvas
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
            `Rendered Miami map topology: ${topologyNodes.length} SVG nodes and ${rawEdges.length} directed edges.`,
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
        const nodeType = matchingNode ? matchingNode.type : (step.node_type || 'energy');
        const shortName = truncateLabel(nodeName, 15);

        if (nodesDataSet && nodesDataSet.get(nodeId)) {
            nodesDataSet.update({
                id: nodeId,
                label: `${shortName}\n[EVAL...]`,
                size: 23,
                image: getNodeSvgIcon(nodeType, '#d29922')
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

        const statusBadge = survived ? '[OK]' : '[FAIL]';
        const statusStroke = survived ? '#00FF00' : '#f85149';

        if (nodesDataSet && nodesDataSet.get(nodeId)) {
            nodesDataSet.update({
                id: nodeId,
                label: `${shortName}\n${statusBadge}`,
                size: survived ? 19 : 22,
                image: getNodeSvgIcon(nodeType, statusStroke)
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

    const sidebar = document.getElementById('control-sidebar');
    const sidebarToggleBtn = document.getElementById('sidebar-toggle-btn');
    const consoleDrawer = document.getElementById('console-drawer');
    const consoleHeader = document.getElementById('console-header');
    const consoleToggleBtn = document.getElementById('console-toggle-btn');

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
