// frontend/app.js

let network = null;
let nodesDataSet = null;
let edgesDataSet = null;
let topologyNodes = [];
let isSimulating = false;
let activeDropdownIndex = -1;

// ── AUTH ──
const AUTH_TOKEN_KEY = 'weatherfall_token';
const AUTH_USER_KEY = 'weatherfall_username';
const AUTH_ADMIN_KEY = 'weatherfall_is_admin';

function updateAuthBar() {
    const token = localStorage.getItem(AUTH_TOKEN_KEY);
    const username = localStorage.getItem(AUTH_USER_KEY) || 'guest';
    const isAdmin = localStorage.getItem(AUTH_ADMIN_KEY) === 'true';

    const userEl = document.getElementById('auth-user');
    const adminLink = document.getElementById('auth-admin-link');
    const loginLink = document.getElementById('auth-login-link');
    const logoutBtn = document.getElementById('auth-logout-btn');

    if (!userEl || !adminLink || !loginLink || !logoutBtn) return;

    if (token) {
        userEl.textContent = `${username}${isAdmin ? '@admin' : ''}`;
        adminLink.classList.toggle('hidden', !isAdmin);
        loginLink.classList.add('hidden');
        logoutBtn.classList.remove('hidden');
    } else {
        userEl.textContent = 'guest';
        adminLink.classList.add('hidden');
        loginLink.classList.remove('hidden');
        logoutBtn.classList.add('hidden');
    }
}

function handleLogout() {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_USER_KEY);
    localStorage.removeItem(AUTH_ADMIN_KEY);
    updateAuthBar();
    appendLog('[AUTH] Session terminated.', 'system-msg');
}
// ── /AUTH ──

const mapImage = new Image();
mapImage.src = '/static/miami-dark-map.png';

const MIAMI_GEO_BOUNDS = {
    minLon: -80.32,
    maxLon: -80.12,
    minLat: 25.71,
    maxLat: 25.86
};

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

function toSvgDataUri(svgString) {
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgString.trim());
}

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

    const stroke = strokeOverride || '#00FF00';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" width="36" height="36">
        <circle cx="18" cy="18" r="16" fill="#060c14" fill-opacity="0.78" stroke="${stroke}" stroke-width="1.8"/>
        <polygon points="20,7 10,20 17,20 15,29 26,16 19,16" fill="none" stroke="${stroke}" stroke-width="2.2" stroke-linejoin="round"/>
    </svg>`;
}

const SVG_ICONS = {
    energy: toSvgDataUri(createTerminalSvg('energy')),
    health: toSvgDataUri(createTerminalSvg('health')),
    comms: toSvgDataUri(createTerminalSvg('comms')),
    water: toSvgDataUri(createTerminalSvg('water')),
    transport: toSvgDataUri(createTerminalSvg('transport'))
};

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

function truncateLabel(name = '', maxLen = 15) {
    const str = String(name).trim();
    return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
}

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

const savedNodeIds = new Set();
let impactNodeId = null;
let pulseAnimFrame = null;

function startCanvasPulseLoop() {
    if (pulseAnimFrame) return;
    function tick() {
        if (savedNodeIds.size === 0 && !impactNodeId) {
            pulseAnimFrame = null;
            return;
        }
        if (network) {
            network.redraw();
        }
        pulseAnimFrame = requestAnimationFrame(tick);
    }
    pulseAnimFrame = requestAnimationFrame(tick);
}

async function typewriterLog(commandText, charDelay = 22) {
    const consoleLog = document.getElementById('console-log');
    if (!consoleLog) return;

    const el = document.createElement('div');
    el.className = 'log-line recovery-cmd typing';
    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
    const prefix = `[${timestamp}] [AI OVERRIDE] $ `;
    el.textContent = prefix;
    consoleLog.appendChild(el);
    consoleLog.scrollTop = consoleLog.scrollHeight;

    const fullCmd = String(commandText);
    for (let c = 0; c < fullCmd.length; c++) {
        el.textContent = prefix + fullCmd.slice(0, c + 1);
        consoleLog.scrollTop = consoleLog.scrollHeight;
        await new Promise(resolve => setTimeout(resolve, charDelay));
    }

    el.classList.remove('typing');
}

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

function resetGraphState() {
    if (!nodesDataSet || !edgesDataSet) return;

    savedNodeIds.clear();
    impactNodeId = null;

    const nodeUpdates = topologyNodes.map(node => ({
        id: node.id,
        label: truncateLabel(node.name, 15),
        title: node.name,
        size: 18,
        shape: 'image',
        image: getNodeSvgIcon(node.type)
    }));
    nodesDataSet.update(nodeUpdates);

    const existingEdges = edgesDataSet.get();
    const dynamicIds = existingEdges.filter(e => String(e.id).startsWith('heal_edge_')).map(e => e.id);
    if (dynamicIds.length > 0) {
        edgesDataSet.remove(dynamicIds);
    }

    const edgeUpdates = edgesDataSet.get().map(edge => ({
        id: edge.id,
        width: 1.4,
        dashes: false,
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

function setTrajectoryInput(trajectoryText) {
    const trajectoryInput = document.getElementById('disaster-trajectory');
    if (trajectoryInput) {
        trajectoryInput.value = trajectoryText;
    }

    document.querySelectorAll('#quick-trajectories .chip').forEach(btn => {
        btn.classList.toggle('active-chip', btn.dataset.trajectory === trajectoryText);
    });
}

async function fetchAndRenderTopology() {
    const container = document.getElementById('network-canvas');
    const nodeCountBadge = document.getElementById('node-count-badge');

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

        nodesDataSet = new vis.DataSet(
            topologyNodes.map(node => ({
                id: node.id,
                label: truncateLabel(node.name, 15),
                title: `${node.name} (${node.type}) [${node.rawX.toFixed(3)}, ${node.rawY.toFixed(3)}]`,
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

        network.on('afterDrawing', function (ctx) {
            if (savedNodeIds.size === 0 && !impactNodeId) return;
            const t = performance.now() / 1000;
            const pulse = 0.5 + 0.5 * Math.sin(t * 4.5);

            ctx.save();

            if (impactNodeId) {
                const impactPositions = network.getPositions([impactNodeId]);
                const impactPos = impactPositions[impactNodeId];
                if (impactPos) {
                    const shockRadius = 24 + ((t * 28) % 26);
                    const shockAlpha = Math.max(0.15, 0.85 - ((shockRadius - 24) / 26) * 0.7);
                    ctx.beginPath();
                    ctx.arc(impactPos.x, impactPos.y, shockRadius, 0, Math.PI * 2);
                    ctx.strokeStyle = `rgba(255, 234, 0, ${shockAlpha.toFixed(2)})`;
                    ctx.lineWidth = 2.8;
                    ctx.shadowColor = '#f85149';
                    ctx.shadowBlur = 18;
                    ctx.stroke();
                }
            }

            if (savedNodeIds.size > 0) {
                const positions = network.getPositions(Array.from(savedNodeIds));
                savedNodeIds.forEach(nodeId => {
                    const pos = positions[nodeId];
                    if (!pos) return;
                    const radius = 22 + pulse * 10;
                    const alpha = 0.25 + (1 - pulse) * 0.45;

                    ctx.beginPath();
                    ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
                    ctx.strokeStyle = `rgba(0, 255, 255, ${alpha.toFixed(2)})`;
                    ctx.lineWidth = 2.4;
                    ctx.shadowColor = '#00FFFF';
                    ctx.shadowBlur = 14;
                    ctx.stroke();
                });
            }

            ctx.restore();
        });

        network.fit({ animation: { duration: 400 } });

        updateTelemetry({
            state: 'READY',
            evaluated: 0,
            total: topologyNodes.length,
            failed: 0,
            survived: 0
        });

        appendLog(
            `Rendered Miami map topology: ${topologyNodes.length} SVG nodes and ${rawEdges.length} directed edges.`,
            'system-msg'
        );
    } catch (error) {
        appendLog(`[ERROR] Could not load topology: ${error.message}`, 'trace-fail');
    }
}

async function runSimulation() {
    if (isSimulating) return;

    const disasterSelect = document.getElementById('disaster-type');
    const magnitudeInput = document.getElementById('disaster-magnitude');
    const trajectoryInput = document.getElementById('disaster-trajectory');
    const runBtn = document.getElementById('run-btn');
    const resetBtn = document.getElementById('reset-btn');
    const loadingSpinner = document.getElementById('loading-spinner');
    const consoleLog = document.getElementById('console-log');
    const sidebar = document.getElementById('control-sidebar');
    const sidebarToggleBtn = document.getElementById('sidebar-toggle-btn');

    const disasterType = disasterSelect ? disasterSelect.value : 'Hurricane';
    const magnitude = (magnitudeInput && magnitudeInput.value.trim()) ? magnitudeInput.value.trim() : 'Category 5';
    const trajectory = (trajectoryInput && trajectoryInput.value.trim())
        ? trajectoryInput.value.trim()
        : 'Coming from the Atlantic East coast';

    if (window.innerWidth <= 768 && sidebar && !sidebar.classList.contains('collapsed')) {
        sidebar.classList.add('collapsed');
        if (sidebarToggleBtn) sidebarToggleBtn.textContent = '[ CONTROLS ▼ ]';
    }

    isSimulating = true;
    if (runBtn) runBtn.disabled = true;
    if (resetBtn) resetBtn.disabled = true;
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
        `[INIT] Simulating ${disasterType} (${magnitude}) | Trajectory: "${trajectory}"...`,
        'system-msg'
    );

    try {
        const response = await fetch('/api/v1/simulate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                disaster_type: disasterType,
                magnitude: magnitude,
                trajectory: trajectory
            })
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.detail || `Simulation failed (HTTP ${response.status})`);
        }

        const executionTrace = await response.json();
        if (loadingSpinner) loadingSpinner.classList.add('hidden');

        appendLog(
            `[TRACE RECEIVED] Animating meteorological impact + ${Math.max(0, executionTrace.length - 1)} cascade evaluations...`,
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

async function flashImpactNode(nodeId, nodeType, shortName) {
    if (!nodesDataSet || !nodesDataSet.get(nodeId)) return;

    impactNodeId = nodeId;
    startCanvasPulseLoop();

    network.focus(nodeId, {
        scale: 1.25,
        animation: { duration: 450, easingFunction: 'easeInOutQuad' }
    });

    const flashColors = ['#ffea00', '#f85149', '#ffea00', '#f85149', '#ffea00', '#f85149'];
    for (let f = 0; f < flashColors.length; f++) {
        nodesDataSet.update({
            id: nodeId,
            label: `${shortName}\n[IMPACT ⚡]`,
            size: f % 2 === 0 ? 27 : 22,
            image: getNodeSvgIcon(nodeType, flashColors[f])
        });
        await new Promise(resolve => setTimeout(resolve, 160));
    }

    nodesDataSet.update({
        id: nodeId,
        label: `${shortName}\n[EPICENTER]`,
        size: 24,
        image: getNodeSvgIcon(nodeType, '#f85149')
    });
}

async function animateExecutionTrace(trace) {
    let failedCount = 0;
    let survivedCount = 0;
    const evaluatedSet = new Set();

    for (let i = 0; i < trace.length; i++) {
        const step = trace[i];
        const stepNum = i + 1;
        const nodeName = step.node || step.child_node || step.node_name;
        const matchingNode = topologyNodes.find(n => n.name === nodeName || n.id === nodeName);
        const nodeId = matchingNode ? matchingNode.id : nodeName;
        const nodeType = matchingNode ? matchingNode.type : (step.node_type || 'energy');
        const shortName = truncateLabel(nodeName, 15);

        if (step.step === 'impact') {
            failedCount++;
            evaluatedSet.add(nodeId);

            appendLog(
                `[METEOROLOGICAL IMPACT] AI Epicenter Selected: "${nodeName}" — ${step.reasoning}`,
                'trace-impact'
            );

            await flashImpactNode(nodeId, nodeType, shortName);

            updateTelemetry({
                state: 'RUNNING',
                evaluated: stepNum,
                total: trace.length,
                failed: failedCount,
                survived: survivedCount
            });

            await new Promise(resolve => setTimeout(resolve, 650));
            continue;
        }

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
                    return (
                        (edge.from === step.parent_node && edge.to === nodeId) ||
                        (edge.from === nodeId && edge.to === step.parent_node)
                    );
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

        if (step.recovery_command) {
            await typewriterLog(step.recovery_command, 20);
        }

        if (step.new_edge && step.new_edge.source && step.new_edge.target && edgesDataSet) {
            const healEdgeId = `heal_edge_${stepNum}_${step.new_edge.source}_${step.new_edge.target}`;
            if (!edgesDataSet.get(healEdgeId)) {
                edgesDataSet.add({
                    id: healEdgeId,
                    from: step.new_edge.source,
                    to: step.new_edge.target,
                    color: { color: '#00FFFF', highlight: '#00FFFF' },
                    dashes: true,
                    arrows: 'to',
                    width: 2.8
                });
            }

            savedNodeIds.add(nodeId);
            startCanvasPulseLoop();

            if (nodesDataSet && nodesDataSet.get(nodeId)) {
                nodesDataSet.update({
                    id: nodeId,
                    label: `${shortName}\n[SAVED]`,
                    size: 22,
                    image: getNodeSvgIcon(nodeType, '#00FFFF')
                });
            }

            appendLog(
                `Node saved by rerouting (${step.new_edge.source} ➔ ${step.new_edge.target}).`,
                'trace-saved node-saved'
            );

            await new Promise(resolve => setTimeout(resolve, 900));
        } else if (step.recovery_command) {
            appendLog('Node saved by rerouting.', 'trace-saved node-saved');
            await new Promise(resolve => setTimeout(resolve, 650));
        } else {
            await new Promise(resolve => setTimeout(resolve, 550));
        }
    }

    updateTelemetry({
        state: 'COMPLETE',
        evaluated: trace.length,
        total: trace.length,
        failed: failedCount,
        survived: survivedCount
    });

    appendLog(
        `[COMPLETE] Simulation finished — ${failedCount} failed (${savedNodeIds.size} rerouted by AI), ${survivedCount} survived intact.`,
        'system-msg'
    );

    if (network) {
        network.fit({ animation: { duration: 800, easingFunction: 'easeInOutQuad' } });
    }
}

document.addEventListener('DOMContentLoaded', () => {
    fetchAndRenderTopology();
    updateAuthBar();                                        // ── AUTH ──

    const logoutBtn = document.getElementById('auth-logout-btn');   // ── AUTH ──
    if (logoutBtn) logoutBtn.addEventListener('click', handleLogout);

    const runBtn = document.getElementById('run-btn');
    const resetBtn = document.getElementById('reset-btn');
    const trajectoryInput = document.getElementById('disaster-trajectory');
    const clearSearchBtn = document.getElementById('clear-search-btn');
    const quickTrajectoriesContainer = document.getElementById('quick-trajectories');

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

    if (trajectoryInput) {
        trajectoryInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                runSimulation();
            }
        });
        trajectoryInput.addEventListener('input', (e) => {
            setTrajectoryInput(e.target.value);
        });
    }

    if (clearSearchBtn && trajectoryInput) {
        clearSearchBtn.addEventListener('click', () => {
            setTrajectoryInput('');
            trajectoryInput.focus();
        });
    }

    if (quickTrajectoriesContainer) {
        quickTrajectoriesContainer.addEventListener('click', (e) => {
            const chip = e.target.closest('.chip');
            if (!chip || isSimulating) return;
            const traj = chip.dataset.trajectory || '';
            setTrajectoryInput(traj);
            appendLog(`[TRAJECTORY SET] "${traj}"`, 'system-msg');
        });
    }
});