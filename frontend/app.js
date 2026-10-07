// frontend/app.js — WeatherFall SaaS Command Center Frontend

let network = null;
let nodesDataSet = null;
let edgesDataSet = null;
let topologyNodes = [];
let isSimulating = false;
let feedEventCount = 0;

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
        userEl.textContent = `${username}${isAdmin ? ' (Admin)' : ''}`;
        adminLink.classList.toggle('hidden', !isAdmin);
        loginLink.classList.add('hidden');
        logoutBtn.classList.remove('hidden');
    } else {
        userEl.textContent = 'Guest Operator';
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
    appendSystemCard('Operator Session Ended', 'You have signed out of the operator session.');
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

/**
 * Task 3: Refined Map Node Aesthetics — softer, UI-friendly SaaS colors & crisp badge icons.
 */
function getSectorAccentColor(nodeType = 'energy') {
    const type = String(nodeType).toLowerCase();
    if (type.includes('water') || type.includes('sanitation')) return '#06b6d4'; // Cyan
    if (type.includes('transport')) return '#f97316'; // Orange
    if (type.includes('health')) return '#10b981'; // Emerald
    if (type.includes('comms') || type.includes('telecom')) return '#8b5cf6'; // Violet
    return '#f59e0b'; // Amber (Energy)
}

function createModernNodeSvg(nodeType = 'energy', strokeOverride = null) {
    const type = String(nodeType).toLowerCase();
    const accent = strokeOverride || getSectorAccentColor(type);

    const baseBadge = (innerPath) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">
        <circle cx="20" cy="20" r="18" fill="${accent}" fill-opacity="0.16"/>
        <circle cx="20" cy="20" r="15" fill="#0f172a" fill-opacity="0.92" stroke="${accent}" stroke-width="2.2"/>
        ${innerPath}
    </svg>`;

    if (type.includes('water') || type.includes('sanitation')) {
        return baseBadge(`
            <path d="M20 10 C20 10 13 18.5 13 23 A7 7 0 0 0 27 23 C27 18.5 20 10 20 10 Z" fill="none" stroke="${accent}" stroke-width="2" stroke-linejoin="round"/>
            <path d="M16.5 23.5 A3.5 3.5 0 0 0 20 26.5" fill="none" stroke="${accent}" stroke-width="1.6" stroke-linecap="round"/>
        `);
    }

    if (type.includes('transport')) {
        return baseBadge(`
            <path d="M10 25 L30 25 M13.5 25 L13.5 16 M26.5 25 L26.5 16 M10 20.5 Q20 12.5 30 20.5" fill="none" stroke="${accent}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            <line x1="20" y1="16" x2="20" y2="25" stroke="${accent}" stroke-width="1.5" stroke-dasharray="2,2"/>
        `);
    }

    if (type.includes('health')) {
        return baseBadge(`
            <path d="M17.5 12 H22.5 V17.5 H28 V22.5 H22.5 V28 H17.5 V22.5 H12 V17.5 H17.5 Z" fill="none" stroke="${accent}" stroke-width="2" stroke-linejoin="round"/>
        `);
    }

    if (type.includes('comms') || type.includes('telecom')) {
        return baseBadge(`
            <path d="M20 16.5 L14.5 28.5 M20 16.5 L25.5 28.5 M16.2 24.5 H23.8" fill="none" stroke="${accent}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
            <circle cx="20" cy="14.5" r="2" fill="${accent}"/>
            <path d="M14.5 12 A7.5 7.5 0 0 1 25.5 12" fill="none" stroke="${accent}" stroke-width="1.6" stroke-linecap="round"/>
        `);
    }

    return baseBadge(`
        <polygon points="21.5,10 13,21 19,21 17.5,30 27,18.5 21,18.5" fill="none" stroke="${accent}" stroke-width="2" stroke-linejoin="round"/>
    `);
}

const SVG_ICONS = {
    energy: toSvgDataUri(createModernNodeSvg('energy')),
    health: toSvgDataUri(createModernNodeSvg('health')),
    comms: toSvgDataUri(createModernNodeSvg('comms')),
    water: toSvgDataUri(createModernNodeSvg('water')),
    transport: toSvgDataUri(createModernNodeSvg('transport'))
};

function getNodeSvgIcon(nodeType = 'energy', strokeOverride = null) {
    if (strokeOverride) {
        return toSvgDataUri(createModernNodeSvg(nodeType, strokeOverride));
    }
    const type = String(nodeType).toLowerCase();
    if (type.includes('water')) return SVG_ICONS.water;
    if (type.includes('transport')) return SVG_ICONS.transport;
    if (type.includes('health')) return SVG_ICONS.health;
    if (type.includes('comms') || type.includes('telecom')) return SVG_ICONS.comms;
    return SVG_ICONS.energy;
}

function buildPopoverTooltip(node, statusText = 'Operational') {
    const sector = String(node.type || 'energy').toUpperCase();
    const coords = `${Number(node.rawY || 0).toFixed(4)}° N, ${Math.abs(Number(node.rawX || 0)).toFixed(4)}° W`;
    return `${node.name}\nSector: ${sector} • Status: ${statusText}\nCoordinates: ${coords}`;
}

function truncateLabel(name = '', maxLen = 16) {
    const str = String(name).trim();
    return str.length > maxLen ? str.slice(0, maxLen) + '…' : str;
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

// =========================================================
// TASK 2: INCIDENT TIMELINE / LIVE FEED NOTIFICATION CARDS
// =========================================================

const FEED_SVGS = {
    system: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
    impact: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
    fail: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
    survive: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
    shield: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>`
};

function updateFeedCounter() {
    const badge = document.getElementById('feed-count-badge');
    if (badge) {
        badge.textContent = feedEventCount > 0 ? `${feedEventCount} events` : 'Standby';
    }
}

function appendFeedCard({
    variant = 'system',
    iconSvg = FEED_SVGS.system,
    iconClass = 'system-icon',
    title = '',
    pillText = '',
    pillClass = '',
    description = '',
    technicalCommand = null,
    pdfSummary = ''
}) {
    const consoleLog = document.getElementById('console-log');
    if (!consoleLog) return;

    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
    const card = document.createElement('div');
    card.className = `feed-card feed-card-${variant} log-line`;
    card.dataset.pdfSummary = pdfSummary || `[${timestamp}] ${title}${pillText ? ` [${pillText}]` : ''}: ${description}`;

    const iconDiv = document.createElement('div');
    iconDiv.className = `feed-card-icon ${iconClass}`;
    iconDiv.innerHTML = iconSvg;

    const bodyDiv = document.createElement('div');
    bodyDiv.className = 'feed-card-body';

    const headerDiv = document.createElement('div');
    headerDiv.className = 'feed-card-header';

    const titleGroup = document.createElement('div');
    titleGroup.className = 'feed-card-title-group';

    const titleSpan = document.createElement('span');
    titleSpan.className = 'feed-card-title';
    titleSpan.textContent = title;
    titleGroup.appendChild(titleSpan);

    if (pillText) {
        const pillSpan = document.createElement('span');
        pillSpan.className = `feed-status-pill ${pillClass}`;
        pillSpan.textContent = pillText;
        titleGroup.appendChild(pillSpan);
    }

    const timeSpan = document.createElement('span');
    timeSpan.className = 'feed-card-time';
    timeSpan.textContent = timestamp;

    headerDiv.appendChild(titleGroup);
    headerDiv.appendChild(timeSpan);
    bodyDiv.appendChild(headerDiv);

    const descP = document.createElement('p');
    descP.className = 'feed-card-desc';
    descP.textContent = description;
    bodyDiv.appendChild(descP);

    if (technicalCommand) {
        const detailsEl = document.createElement('details');
        detailsEl.className = 'tech-details';
        const summaryEl = document.createElement('summary');
        summaryEl.textContent = 'Technical Details';
        const codeEl = document.createElement('code');
        codeEl.className = 'tech-cmd';
        codeEl.textContent = `$ ${technicalCommand}`;
        detailsEl.appendChild(summaryEl);
        detailsEl.appendChild(codeEl);
        bodyDiv.appendChild(detailsEl);
    }

    card.appendChild(iconDiv);
    card.appendChild(bodyDiv);
    consoleLog.appendChild(card);
    consoleLog.scrollTop = consoleLog.scrollHeight;

    feedEventCount++;
    updateFeedCounter();
}

function appendSystemCard(title, description) {
    appendFeedCard({
        variant: 'system',
        iconSvg: FEED_SVGS.system,
        iconClass: 'system-icon',
        title,
        description
    });
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

    const exportPdfBtn = document.getElementById('export-pdf-btn');
    if (exportPdfBtn) {
        exportPdfBtn.disabled = true;
    }

    const nodeUpdates = topologyNodes.map(node => ({
        id: node.id,
        label: truncateLabel(node.name, 16),
        title: buildPopoverTooltip(node, 'Operational'),
        size: 19,
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
        width: 1.5,
        dashes: false,
        color: { color: 'rgba(148, 163, 184, 0.3)', highlight: '#38bdf8', hover: '#60a5fa' }
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
                label: truncateLabel(node.name, 16),
                title: buildPopoverTooltip(node, 'Operational'),
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
                size: 19,
                shadow: {
                    enabled: true,
                    color: 'rgba(2, 6, 23, 0.65)',
                    size: 12,
                    x: 0,
                    y: 3
                },
                font: {
                    color: '#f8fafc',
                    strokeWidth: 3.5,
                    strokeColor: '#0f172a',
                    size: 11,
                    face: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif'
                }
            },
            edges: {
                width: 1.5,
                color: {
                    color: 'rgba(148, 163, 184, 0.3)',
                    highlight: '#38bdf8',
                    hover: '#60a5fa'
                },
                arrows: { to: { enabled: true, scaleFactor: 0.5 } },
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
                tooltipDelay: 120
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
                ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
                ctx.lineWidth = 1.5;
                ctx.strokeRect(drawX, drawY, mapBounds.width, mapBounds.height);
                ctx.restore();
            }
        });

        network.on('afterDrawing', function (ctx) {
            if (savedNodeIds.size === 0 && !impactNodeId) return;
            const t = performance.now() / 1000;
            const pulse = 0.5 + 0.5 * Math.sin(t * 4.0);

            ctx.save();

            if (impactNodeId) {
                const impactPositions = network.getPositions([impactNodeId]);
                const impactPos = impactPositions[impactNodeId];
                if (impactPos) {
                    const shockRadius = 24 + ((t * 26) % 26);
                    const shockAlpha = Math.max(0.12, 0.78 - ((shockRadius - 24) / 26) * 0.65);
                    ctx.beginPath();
                    ctx.arc(impactPos.x, impactPos.y, shockRadius, 0, Math.PI * 2);
                    ctx.strokeStyle = `rgba(245, 158, 11, ${shockAlpha.toFixed(2)})`;
                    ctx.lineWidth = 2.5;
                    ctx.shadowColor = '#ef4444';
                    ctx.shadowBlur = 16;
                    ctx.stroke();
                }
            }

            if (savedNodeIds.size > 0) {
                const positions = network.getPositions(Array.from(savedNodeIds));
                savedNodeIds.forEach(nodeId => {
                    const pos = positions[nodeId];
                    if (!pos) return;
                    const radius = 22 + pulse * 9;
                    const alpha = 0.25 + (1 - pulse) * 0.45;

                    ctx.beginPath();
                    ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
                    ctx.strokeStyle = `rgba(56, 189, 248, ${alpha.toFixed(2)})`;
                    ctx.lineWidth = 2.2;
                    ctx.shadowColor = '#38bdf8';
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

        appendSystemCard(
            'Miami Infrastructure Grid Loaded',
            `Connected ${topologyNodes.length} critical facilities across ${rawEdges.length} street-routed dependency links.`
        );
    } catch (error) {
        appendFeedCard({
            variant: 'fail',
            iconSvg: FEED_SVGS.fail,
            iconClass: 'fail-icon',
            title: 'Topology Load Error',
            pillText: 'Error',
            pillClass: 'pill-fail',
            description: `Could not load Miami topology: ${error.message}`
        });
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
        if (sidebarToggleBtn) sidebarToggleBtn.textContent = 'Controls';
    }

    isSimulating = true;
    if (runBtn) runBtn.disabled = true;
    if (resetBtn) resetBtn.disabled = true;
    if (loadingSpinner) loadingSpinner.classList.remove('hidden');

    resetGraphState();
    if (consoleLog) {
        consoleLog.innerHTML = '';
        feedEventCount = 0;
        updateFeedCounter();
    }

    updateTelemetry({
        state: 'RUNNING',
        evaluated: 0,
        total: topologyNodes.length,
        failed: 0,
        survived: 0
    });

    appendSystemCard(
        `Simulation Initiated — ${disasterType}`,
        `Evaluating "${trajectory}" at intensity ${magnitude} across the Miami street network.`
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

        await animateExecutionTrace(executionTrace);
    } catch (error) {
        if (loadingSpinner) loadingSpinner.classList.add('hidden');
        updateTelemetry({ state: 'ERROR' });
        appendFeedCard({
            variant: 'fail',
            iconSvg: FEED_SVGS.fail,
            iconClass: 'fail-icon',
            title: 'Simulation Interrupted',
            pillText: 'Error',
            pillClass: 'pill-fail',
            description: error.message
        });
    } finally {
        isSimulating = false;
        if (runBtn) runBtn.disabled = false;
        if (resetBtn) resetBtn.disabled = false;
    }
}

async function flashImpactNode(nodeId, nodeType, shortName, matchingNode) {
    if (!nodesDataSet || !nodesDataSet.get(nodeId)) return;

    impactNodeId = nodeId;
    startCanvasPulseLoop();

    network.focus(nodeId, {
        scale: 1.25,
        animation: { duration: 450, easingFunction: 'easeInOutQuad' }
    });

    const flashColors = ['#f59e0b', '#ef4444', '#f59e0b', '#ef4444', '#f59e0b', '#ef4444'];
    for (let f = 0; f < flashColors.length; f++) {
        nodesDataSet.update({
            id: nodeId,
            label: `${shortName}\n• Impact`,
            size: f % 2 === 0 ? 26 : 21,
            image: getNodeSvgIcon(nodeType, flashColors[f])
        });
        await new Promise(resolve => setTimeout(resolve, 150));
    }

    nodesDataSet.update({
        id: nodeId,
        label: `${shortName}\n• Epicenter`,
        title: matchingNode ? buildPopoverTooltip(matchingNode, 'Epicenter Impact (Failed)') : nodeId,
        size: 24,
        image: getNodeSvgIcon(nodeType, '#ef4444')
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
        const shortName = truncateLabel(nodeName, 16);

        if (step.step === 'impact') {
            failedCount++;
            evaluatedSet.add(nodeId);

            appendFeedCard({
                variant: 'impact',
                iconSvg: FEED_SVGS.impact,
                iconClass: 'impact-icon',
                title: nodeName,
                pillText: 'Epicenter Impact',
                pillClass: 'pill-impact',
                description: step.reasoning,
                pdfSummary: `[STEP 1/${trace.length}] [EPICENTER IMPACT] ${nodeName}: ${step.reasoning}`
            });

            await flashImpactNode(nodeId, nodeType, shortName, matchingNode);

            updateTelemetry({
                state: 'RUNNING',
                evaluated: stepNum,
                total: trace.length,
                failed: failedCount,
                survived: survivedCount
            });

            await new Promise(resolve => setTimeout(resolve, 600));
            continue;
        }

        if (nodesDataSet && nodesDataSet.get(nodeId)) {
            nodesDataSet.update({
                id: nodeId,
                label: `${shortName}\n• Evaluating…`,
                size: 23,
                image: getNodeSvgIcon(nodeType, '#eab308')
            });

            network.focus(nodeId, {
                scale: 1.1,
                animation: { duration: 380, easingFunction: 'easeInOutQuad' }
            });
        }

        await new Promise(resolve => setTimeout(resolve, 380));

        const survived = Boolean(step.status);
        if (survived) {
            survivedCount++;
        } else {
            failedCount++;
        }
        evaluatedSet.add(nodeId);

        const statusBadge = survived ? '• Intact' : '• Failed';
        const statusStroke = survived ? '#10b981' : '#ef4444';

        if (nodesDataSet && nodesDataSet.get(nodeId)) {
            nodesDataSet.update({
                id: nodeId,
                label: `${shortName}\n${statusBadge}`,
                title: matchingNode
                    ? buildPopoverTooltip(matchingNode, survived ? 'Operational (Survived)' : 'Cascade Failure')
                    : nodeName,
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
                    width: 2.6,
                    color: {
                        color: survived ? '#10b981' : '#ef4444',
                        highlight: survived ? '#34d399' : '#f87171'
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

        const connectionContext = step.parent_node
            ? `${step.parent_node} → ${nodeName}`
            : nodeName;

        if (survived) {
            appendFeedCard({
                variant: 'survive',
                iconSvg: FEED_SVGS.survive,
                iconClass: 'survive-icon',
                title: nodeName,
                pillText: 'Survived',
                pillClass: 'pill-survive',
                description: `${step.reasoning} (Dependency: ${connectionContext})`,
                pdfSummary: `[STEP ${stepNum}/${trace.length}] ${connectionContext} [SURVIVED]: ${step.reasoning}`
            });
        } else {
            appendFeedCard({
                variant: 'fail',
                iconSvg: FEED_SVGS.fail,
                iconClass: 'fail-icon',
                title: nodeName,
                pillText: 'Cascade Failure',
                pillClass: 'pill-fail',
                description: `${step.reasoning} (Upstream failure: ${step.parent_node || 'Epicenter'})`,
                pdfSummary: `[STEP ${stepNum}/${trace.length}] ${connectionContext} [FAILED]: ${step.reasoning}`
            });
        }

        if (step.new_edge && step.new_edge.source && step.new_edge.target && edgesDataSet) {
            await new Promise(resolve => setTimeout(resolve, 320));

            const healEdgeId = `heal_edge_${stepNum}_${step.new_edge.source}_${step.new_edge.target}`;
            if (!edgesDataSet.get(healEdgeId)) {
                edgesDataSet.add({
                    id: healEdgeId,
                    from: step.new_edge.source,
                    to: step.new_edge.target,
                    color: { color: '#38bdf8', highlight: '#7dd3fc' },
                    dashes: [6, 5],
                    arrows: 'to',
                    width: 2.8
                });
            }

            savedNodeIds.add(nodeId);
            startCanvasPulseLoop();

            if (nodesDataSet && nodesDataSet.get(nodeId)) {
                nodesDataSet.update({
                    id: nodeId,
                    label: `${shortName}\n• AI Restored`,
                    title: matchingNode
                        ? buildPopoverTooltip(matchingNode, `AI Restored via ${step.new_edge.source}`)
                        : nodeName,
                    size: 22,
                    image: getNodeSvgIcon(nodeType, '#38bdf8')
                });
            }

            const estCost = step.new_edge.estimated_cost ?? step.estimated_cost;
            const recTimeMs = step.new_edge.recovery_time_ms ?? step.recovery_time_ms;
            const metricsSuffix = (estCost !== undefined && estCost !== null && recTimeMs !== undefined && recTimeMs !== null)
                ? ` (Est. Cost: $${Number(estCost).toLocaleString()} • Latency: ${recTimeMs} ms)`
                : '';
            const rerouteSummary = `Emergency supply rerouted from ${step.new_edge.source} to ${step.new_edge.target} — service restored.${metricsSuffix}`;
            appendFeedCard({
                variant: 'recovery',
                iconSvg: FEED_SVGS.shield,
                iconClass: 'recovery-icon',
                title: 'AI Rerouting Active',
                pillText: `${step.new_edge.source} → ${step.new_edge.target}`,
                pillClass: 'pill-recovery',
                description: rerouteSummary,
                technicalCommand: step.recovery_command || `ln -s /city/grid/${step.new_edge.source} /city/grid/${step.new_edge.target}`,
                pdfSummary: `[AI REROUTING ACTIVE] ${rerouteSummary}${step.recovery_command ? ` | CMD: $ ${step.recovery_command}` : ''}`
            });

            await new Promise(resolve => setTimeout(resolve, 750));
        } else if (step.recovery_command) {
            await new Promise(resolve => setTimeout(resolve, 300));
            appendFeedCard({
                variant: 'recovery',
                iconSvg: FEED_SVGS.shield,
                iconClass: 'recovery-icon',
                title: 'AI Rerouting Active',
                pillText: nodeName,
                pillClass: 'pill-recovery',
                description: `Automated emergency rerouting protocol executed for ${nodeName}.`,
                technicalCommand: step.recovery_command,
                pdfSummary: `[AI REROUTING ACTIVE] Emergency protocol executed for ${nodeName} | CMD: $ ${step.recovery_command}`
            });
            await new Promise(resolve => setTimeout(resolve, 550));
        } else {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }

    updateTelemetry({
        state: 'COMPLETE',
        evaluated: trace.length,
        total: trace.length,
        failed: failedCount,
        survived: survivedCount
    });

    appendSystemCard(
        'Cascade Assessment Complete',
        `${failedCount} nodes impacted (${savedNodeIds.size} automatically restored via AI rerouting), ${survivedCount} remained intact.`
    );

    if (network) {
        network.fit({ animation: { duration: 750, easingFunction: 'easeInOutQuad' } });
    }

    const exportPdfBtn = document.getElementById('export-pdf-btn');
    if (exportPdfBtn) {
        exportPdfBtn.disabled = false;
    }
}

/**
 * Captures the vis-network canvas snapshot and Incident Timeline feed,
 * populates #pdf-template, and generates a downloadable WeatherFall_Report.pdf via html2pdf.js.
 */
async function exportPDFReport() {
    const pdfTemplate = document.getElementById('pdf-template');
    const mapSnapshotImg = document.getElementById('pdf-map-snapshot');
    const traceLogPre = document.getElementById('pdf-trace-log');
    const consoleLog = document.getElementById('console-log');
    const exportPdfBtn = document.getElementById('export-pdf-btn');

    if (!pdfTemplate || !mapSnapshotImg || !traceLogPre) return;

    if (typeof html2pdf === 'undefined') {
        appendSystemCard('PDF Export Unavailable', 'The html2pdf.js library could not be loaded.');
        return;
    }

    const originalBtnHTML = exportPdfBtn ? exportPdfBtn.innerHTML : 'Export Incident Report (PDF)';
    if (exportPdfBtn) {
        exportPdfBtn.disabled = true;
        exportPdfBtn.textContent = 'Generating PDF Report…';
    }

    try {
        // 1. Populate incident metadata placeholders
        const disasterSelect = document.getElementById('disaster-type');
        const magnitudeInput = document.getElementById('disaster-magnitude');
        const trajectoryInput = document.getElementById('disaster-trajectory');
        const statFailed = document.getElementById('stat-failed');
        const statSurvived = document.getElementById('stat-survived');

        const pdfTimestamp = document.getElementById('pdf-timestamp');
        const pdfDisasterType = document.getElementById('pdf-disaster-type');
        const pdfMagnitude = document.getElementById('pdf-disaster-magnitude');
        const pdfTrajectory = document.getElementById('pdf-disaster-trajectory');
        const pdfOutcome = document.getElementById('pdf-cascade-outcome');

        if (pdfTimestamp) pdfTimestamp.textContent = new Date().toLocaleString('en-US', { hour12: false });
        if (pdfDisasterType) pdfDisasterType.textContent = disasterSelect ? disasterSelect.value : 'Hurricane';
        if (pdfMagnitude) pdfMagnitude.textContent = magnitudeInput ? magnitudeInput.value : 'Category 5';
        if (pdfTrajectory) pdfTrajectory.textContent = trajectoryInput ? trajectoryInput.value : 'Atlantic East Coast';
        if (pdfOutcome) {
            const failedVal = statFailed ? statFailed.textContent : '0';
            const survivedVal = statSurvived ? statSurvived.textContent : '0';
            pdfOutcome.textContent = `${failedVal} Impacted (${savedNodeIds.size} Restored by AI) / ${survivedVal} Intact`;
        }

        // 2. Extract structured timeline entries from #console-log into #pdf-trace-log
        if (consoleLog) {
            const rawLines = Array.from(consoleLog.querySelectorAll('.log-line'))
                .map(el => (el.dataset && el.dataset.pdfSummary) ? el.dataset.pdfSummary : el.textContent.trim())
                .filter(Boolean);
            const linesToRender = rawLines.length > 0
                ? rawLines
                : consoleLog.innerText.split('\n').map(l => l.trim()).filter(Boolean);

            traceLogPre.innerHTML = '';
            linesToRender.forEach((lineText) => {
                const lineDiv = document.createElement('div');
                lineDiv.className = 'pdf-trace-line';
                if (lineText.includes('[AI REROUTING ACTIVE]') || lineText.includes('[AI OVERRIDE]')) {
                    lineDiv.classList.add('pdf-trace-cmd');
                } else if (lineText.includes('[FAILED]') || lineText.includes('[EPICENTER IMPACT]')) {
                    lineDiv.classList.add('pdf-trace-fail');
                } else if (lineText.includes('[SURVIVED]')) {
                    lineDiv.classList.add('pdf-trace-ok');
                }

                const tokens = lineText.split(/\s+/);
                tokens.forEach((token, idx) => {
                    const subParts = token.split(/(?<=\/)/);
                    subParts.forEach((part) => {
                        if (!part) return;
                        const wordSpan = document.createElement('span');
                        wordSpan.className = 'pdf-word';
                        wordSpan.textContent = part;
                        lineDiv.appendChild(wordSpan);
                    });
                    if (idx < tokens.length - 1) {
                        lineDiv.appendChild(document.createTextNode(' '));
                    }
                });

                traceLogPre.appendChild(lineDiv);
            });
        }

        // 3. Fit and capture the vis-network canvas onto a properly proportioned dark snapshot canvas
        if (network) {
            network.fit({ animation: false });
            network.redraw();
        }
        const rawCanvas = network.canvas.getContext().canvas;
        const snapshotCanvas = document.createElement('canvas');
        const targetWidth = 1200;
        const targetHeight = 520;
        snapshotCanvas.width = targetWidth;
        snapshotCanvas.height = targetHeight;
        const sCtx = snapshotCanvas.getContext('2d');
        sCtx.fillStyle = '#090d14';
        sCtx.fillRect(0, 0, targetWidth, targetHeight);

        if (rawCanvas && rawCanvas.width > 0 && rawCanvas.height > 0) {
            const pad = 16;
            const availW = targetWidth - pad * 2;
            const availH = targetHeight - pad * 2;
            const scale = Math.min(availW / rawCanvas.width, availH / rawCanvas.height);
            const drawW = rawCanvas.width * scale;
            const drawH = rawCanvas.height * scale;
            const offsetX = (targetWidth - drawW) / 2;
            const offsetY = (targetHeight - drawH) / 2;
            sCtx.drawImage(rawCanvas, offsetX, offsetY, drawW, drawH);
        }

        const canvasData = snapshotCanvas.toDataURL('image/png');
        await new Promise((resolve) => {
            mapSnapshotImg.onload = resolve;
            mapSnapshotImg.onerror = resolve;
            mapSnapshotImg.src = canvasData;
        });

        // 4. Temporarily display #pdf-template, generate PDF via html2pdf.js, and hide again
        pdfTemplate.style.display = 'block';

        await html2pdf()
            .set({
                margin: 10,
                filename: 'WeatherFall_Report.pdf',
                image: { type: 'jpeg', quality: 0.98 },
                pagebreak: {
                    mode: ['css', 'legacy'],
                    avoid: [
                        '.pdf-report-header',
                        '.pdf-summary-grid',
                        '.pdf-snapshot-frame',
                        '.pdf-section-title',
                        '.pdf-trace-line'
                    ]
                },
                html2canvas: {
                    scale: 2,
                    useCORS: true,
                    backgroundColor: '#ffffff'
                },
                jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
            })
            .from(pdfTemplate)
            .save();

        appendSystemCard('Incident Report Exported', 'Downloaded WeatherFall_Report.pdf successfully.');
    } catch (err) {
        appendFeedCard({
            variant: 'fail',
            iconSvg: FEED_SVGS.fail,
            iconClass: 'fail-icon',
            title: 'PDF Export Error',
            pillText: 'Error',
            pillClass: 'pill-fail',
            description: `Failed to export PDF report: ${err.message}`
        });
    } finally {
        pdfTemplate.style.display = 'none';
        if (exportPdfBtn) {
            exportPdfBtn.disabled = false;
            exportPdfBtn.innerHTML = originalBtnHTML;
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    fetchAndRenderTopology();
    updateAuthBar();

    const logoutBtn = document.getElementById('auth-logout-btn');
    if (logoutBtn) logoutBtn.addEventListener('click', handleLogout);

    const runBtn = document.getElementById('run-btn');
    const resetBtn = document.getElementById('reset-btn');
    const exportPdfBtn = document.getElementById('export-pdf-btn');
    const trajectoryInput = document.getElementById('disaster-trajectory');
    const clearSearchBtn = document.getElementById('clear-search-btn');
    const quickTrajectoriesContainer = document.getElementById('quick-trajectories');

    const sidebar = document.getElementById('control-sidebar');
    const sidebarToggleBtn = document.getElementById('sidebar-toggle-btn');
    const consoleDrawer = document.getElementById('console-drawer');
    const consoleResizer = document.getElementById('console-resizer');
    const consoleHeader = document.getElementById('console-header');
    const consoleToggleBtn = document.getElementById('console-toggle-btn');

    let lastExpandedHeight = window.innerWidth <= 768 ? Math.round(window.innerHeight * 0.38) : 260;

    if (window.innerWidth <= 768 && consoleDrawer && consoleToggleBtn) {
        consoleDrawer.classList.add('collapsed');
        consoleToggleBtn.textContent = 'Expand';
    }

    if (sidebarToggleBtn && sidebar) {
        sidebarToggleBtn.addEventListener('click', () => {
            const isCollapsed = sidebar.classList.toggle('collapsed');
            sidebarToggleBtn.textContent = isCollapsed ? 'Controls' : 'Hide';
        });
    }

    function toggleConsoleDrawer() {
        if (!consoleDrawer || !consoleToggleBtn) return;
        const isCollapsed = consoleDrawer.classList.toggle('collapsed');
        if (!isCollapsed) {
            consoleDrawer.style.height = `${lastExpandedHeight}px`;
            consoleToggleBtn.textContent = 'Collapse';
        } else {
            consoleToggleBtn.textContent = 'Expand';
        }
        setTimeout(() => {
            if (network) network.redraw();
        }, 260);
    }

    if (consoleToggleBtn) {
        consoleToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleConsoleDrawer();
        });
    }

    if (consoleDrawer && (consoleResizer || consoleHeader)) {
        let isDragging = false;
        let didMove = false;
        let startY = 0;
        let startHeight = 260;

        const onPointerDown = (e) => {
            if (e.target.closest('#console-toggle-btn')) return;
            if (e.button !== undefined && e.button !== 0) return;

            isDragging = true;
            didMove = false;
            startY = e.clientY;
            startHeight = consoleDrawer.getBoundingClientRect().height;

            if (e.currentTarget.setPointerCapture) {
                try {
                    e.currentTarget.setPointerCapture(e.pointerId);
                } catch (_) {}
            }
        };

        const onPointerMove = (e) => {
            if (!isDragging) return;
            const deltaY = startY - e.clientY;

            if (!didMove && Math.abs(deltaY) < 4) return;
            didMove = true;

            consoleDrawer.classList.add('is-resizing');
            document.body.classList.add('resizing-drawer');

            const maxAllowed = Math.floor(window.innerHeight * 0.82);
            const rawHeight = startHeight + deltaY;

            if (rawHeight <= 64) {
                consoleDrawer.classList.add('collapsed');
                if (consoleToggleBtn) consoleToggleBtn.textContent = 'Expand';
            } else {
                const clampedHeight = Math.min(maxAllowed, Math.max(96, Math.round(rawHeight)));
                lastExpandedHeight = clampedHeight;
                consoleDrawer.classList.remove('collapsed');
                consoleDrawer.style.height = `${clampedHeight}px`;
                if (consoleToggleBtn) consoleToggleBtn.textContent = 'Collapse';
            }

            if (network) {
                network.redraw();
            }
        };

        const stopDragging = (e) => {
            if (!isDragging) return;
            const wasHeaderClick = !didMove && e.currentTarget === consoleHeader;
            isDragging = false;
            didMove = false;

            consoleDrawer.classList.remove('is-resizing');
            document.body.classList.remove('resizing-drawer');

            if (wasHeaderClick) {
                toggleConsoleDrawer();
            } else if (network) {
                network.redraw();
            }
        };

        [consoleResizer, consoleHeader].forEach(handle => {
            if (!handle) return;
            handle.addEventListener('pointerdown', onPointerDown);
            handle.addEventListener('pointermove', onPointerMove);
            handle.addEventListener('pointerup', stopDragging);
            handle.addEventListener('pointercancel', stopDragging);
        });
    }

    if (runBtn) {
        runBtn.addEventListener('click', runSimulation);
    }

    if (exportPdfBtn) {
        exportPdfBtn.addEventListener('click', exportPDFReport);
    }

    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            if (isSimulating) return;
            resetGraphState();
            if (network) network.fit({ animation: { duration: 500 } });
            appendSystemCard('Map Reset', 'Topology state restored to operational standby.');
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
        });
    }
});