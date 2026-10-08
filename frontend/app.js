// frontend/app.js — WeatherFall SaaS Command Center Frontend (Interactive Leaflet GIS Edition)

let leafletMap = null;
let baseTileLayer = null;
let edgesLayerGroup = null;
let nodesLayerGroup = null;

let topologyNodes = [];
let topologyEdges = [];
let nodeMarkersMap = new Map();
let nodeStateMap = new Map();
let edgeLayersMap = new Map();

let isSimulating = false;
let feedEventCount = 0;
let cartoApiKey = '';

const savedNodeIds = new Set();
let impactNodeId = null;

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

// ── MAP TILE CONFIGURATION (Full Interactive City & World Map) ──
const DARK_TILE_URL = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
const LIGHT_TILE_URL = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';
const ESRI_DARK_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}';
const ESRI_LIGHT_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}';
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';

const THEME_STORAGE_KEY = 'weatherfall_theme';
let currentTheme = localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark';

function isLightMode() {
    return currentTheme === 'light';
}

function getTileUrl(theme) {
    if (cartoApiKey) {
        const base = theme === 'light' ? LIGHT_TILE_URL : DARK_TILE_URL;
        return `${base}?key=${encodeURIComponent(cartoApiKey)}`;
    }
    return theme === 'light' ? ESRI_LIGHT_URL : ESRI_DARK_URL;
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[ch]));
}

function toSvgDataUri(svgString) {
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgString.trim());
}

/**
 * Refined Map Node Aesthetics — softer, UI-friendly SaaS colors & crisp badge icons.
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
    const innerFill = isLightMode() ? '#ffffff' : '#0f172a';
    const haloOpacity = isLightMode() ? '0.24' : '0.18';

    const baseBadge = (innerPath) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="38" height="38">
        <circle cx="20" cy="20" r="18" fill="${accent}" fill-opacity="${haloOpacity}"/>
        <circle cx="20" cy="20" r="14.8" fill="${innerFill}" fill-opacity="0.96" stroke="${accent}" stroke-width="2.3"/>
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

function getNodeSvgIcon(nodeType = 'energy', strokeOverride = null) {
    return toSvgDataUri(createModernNodeSvg(nodeType, strokeOverride));
}

function applyTheme(theme) {
    currentTheme = theme === 'light' ? 'light' : 'dark';
    localStorage.setItem(THEME_STORAGE_KEY, currentTheme);

    if (currentTheme === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
        document.body.setAttribute('data-theme', 'light');
    } else {
        document.documentElement.removeAttribute('data-theme');
        document.body.removeAttribute('data-theme');
    }

    const sunIcon = document.getElementById('theme-icon-sun');
    const moonIcon = document.getElementById('theme-icon-moon');
    const labelEl = document.getElementById('theme-toggle-label');

    if (sunIcon && moonIcon && labelEl) {
        if (currentTheme === 'light') {
            sunIcon.classList.add('hidden');
            moonIcon.classList.remove('hidden');
            labelEl.textContent = 'Dark';
        } else {
            sunIcon.classList.remove('hidden');
            moonIcon.classList.add('hidden');
            labelEl.textContent = 'Light';
        }
    }

    if (leafletMap && baseTileLayer) {
        baseTileLayer.setUrl(getTileUrl(currentTheme));
        refreshAllMapVisuals();
    }
}

function toggleTheme() {
    applyTheme(isLightMode() ? 'dark' : 'light');
}

function buildPopoverHtml(node, statusText = 'Operational') {
    const sector = String(node.type || 'energy').toUpperCase();
    const accent = getSectorAccentColor(node.type);
    const coords = `${Number(node.lat || 0).toFixed(4)}° N, ${Math.abs(Number(node.lon || 0)).toFixed(4)}° W`;
    return `
        <div class="gis-popup">
            <div class="gis-popup-header">
                <span class="gis-popup-sector" style="background:${accent}22;color:${accent};border:1px solid ${accent}55;">${escapeHtml(sector)}</span>
                <span class="gis-popup-id">${escapeHtml(statusText)}</span>
            </div>
            <div class="gis-popup-title">${escapeHtml(node.name)}</div>
            <div class="gis-popup-coords">${escapeHtml(coords)}</div>
        </div>
    `;
}

function truncateLabel(name = '', maxLen = 16) {
    const str = String(name).trim();
    return str.length > maxLen ? str.slice(0, maxLen) + '…' : str;
}

/**
 * Ensures every node has valid geographic coordinates in Miami (lat, lon)
 * and slightly separates identical/overlapping coordinates so markers remain legible.
 */
function normalizeGeoCoordinates(rawX, rawY, index = 0) {
    const lon = Number(rawX);
    const lat = Number(rawY);
    if (Number.isFinite(lon) && Number.isFinite(lat) && lon <= -79.0 && lon >= -82.0 && lat >= 24.5 && lat <= 27.0) {
        return { lat, lon };
    }
    const angle = (index * 137.5 * Math.PI) / 180;
    const radius = 0.012 + (index % 5) * 0.006;
    return {
        lat: 25.778 + Math.sin(angle) * radius,
        lon: -80.205 + Math.cos(angle) * radius
    };
}

function declusterGeoPositions(nodes, minDLat = 0.0022, minDLon = 0.0028, iterations = 25) {
    for (let iter = 0; iter < iterations; iter++) {
        let moved = false;
        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                const a = nodes[i];
                const b = nodes[j];
                let dLat = b.lat - a.lat;
                let dLon = b.lon - a.lon;

                if (Math.abs(dLat) < minDLat && Math.abs(dLon) < minDLon) {
                    moved = true;
                    if (Math.abs(dLat) < 0.0001 && Math.abs(dLon) < 0.0001) {
                        dLat = (i % 2 === 0 ? 1 : -1) * 0.0006;
                        dLon = (j % 2 === 0 ? 1 : -1) * 0.0006;
                    }
                    const pushLat = (minDLat - Math.abs(dLat)) * 0.28 * (dLat >= 0 ? 1 : -1);
                    const pushLon = (minDLon - Math.abs(dLon)) * 0.28 * (dLon >= 0 ? 1 : -1);
                    a.lat -= pushLat;
                    b.lat += pushLat;
                    a.lon -= pushLon;
                    b.lon += pushLon;
                }
            }
        }
        if (!moved) break;
    }
}

function initLeafletCommandMap() {
    const container = document.getElementById('network-canvas');
    if (!container || typeof L === 'undefined') return;
    if (leafletMap) return;

    leafletMap = L.map('network-canvas', {
        center: [25.778, -80.205],
        zoom: 12,
        zoomControl: true
    });

    baseTileLayer = L.tileLayer(getTileUrl(currentTheme), {
        attribution: TILE_ATTRIBUTION,
        subdomains: 'abcd',
        maxZoom: 19
    }).addTo(leafletMap);

    let fallbackTriggered = false;
    baseTileLayer.on('tileerror', () => {
        if (!fallbackTriggered) {
            fallbackTriggered = true;
            cartoApiKey = '';
            baseTileLayer.setUrl(getTileUrl(currentTheme));
        }
    });

    edgesLayerGroup = L.layerGroup().addTo(leafletMap);
    nodesLayerGroup = L.layerGroup().addTo(leafletMap);

    setTimeout(() => {
        if (leafletMap) leafletMap.invalidateSize();
    }, 120);
    setTimeout(() => {
        if (leafletMap) leafletMap.invalidateSize();
    }, 450);

    if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => {
            if (leafletMap) leafletMap.invalidateSize();
        });
        ro.observe(container);
    }
}

function buildNodeLeafletDivIcon(node, state = {}) {
    const strokeOverride = state.strokeOverride || null;
    const statusBadge = state.statusBadge || '';
    const statusColor = state.statusColor || '#94a3b8';
    const isImpact = impactNodeId === node.id;
    const isSaved = savedNodeIds.has(node.id);
    const isFailed = Boolean(state.isFailed || (isImpact && !isSaved));
    const glitchBurst = Boolean(state.glitchBurst);
    const svgHtml = createModernNodeSvg(node.type, strokeOverride);
    const shortName = escapeHtml(truncateLabel(node.name, 16));

    const markerStateClasses = [
        'wf-node-marker',
        isFailed ? 'wf-node-glitch-container' : '',
        glitchBurst ? 'wf-node-glitch-burst' : ''
    ].filter(Boolean).join(' ');

    const badgeStateClasses = [
        'wf-node-badge-wrap',
        isFailed ? 'wf-badge-crt-distort' : '',
        glitchBurst ? 'wf-badge-crt-burst' : ''
    ].filter(Boolean).join(' ');

    const ringOrGlitchHtml = isSaved
        ? `<span class="wf-saved-ring"></span>`
        : isFailed
        ? `
            <span class="wf-crt-scanlines" aria-hidden="true"></span>
            <span class="wf-glitch-layer wf-glitch-cyan" aria-hidden="true">${svgHtml}</span>
            <span class="wf-glitch-layer wf-glitch-red" aria-hidden="true">${svgHtml}</span>
            <span class="wf-crt-tear-bar" aria-hidden="true"></span>
        `
        : '';

    const statusHtml = statusBadge
        ? `<span class="wf-node-status" style="color:${statusColor};">${escapeHtml(statusBadge)}</span>`
        : '';

    const html = `
        <div class="${markerStateClasses}">
            <div class="${badgeStateClasses}">
                ${ringOrGlitchHtml}
                <div class="wf-badge-core">${svgHtml}</div>
            </div>
            <div class="wf-node-label ${isFailed ? 'wf-label-glitch' : ''}">
                ${shortName}
                ${statusHtml}
            </div>
        </div>
    `;

    return L.divIcon({
        className: 'wf-leaflet-div-icon',
        html,
        iconSize: [0, 0],
        iconAnchor: [0, 0],
        popupAnchor: [0, -18],
        tooltipAnchor: [0, -16]
    });
}

function setNodeVisualState(nodeId, partialState = {}) {
    const node = topologyNodes.find(n => n.id === nodeId);
    if (!node) return;

    const prev = nodeStateMap.get(nodeId) || {
        statusText: 'Operational',
        statusBadge: '',
        statusColor: '#94a3b8',
        strokeOverride: null,
        isFailed: false,
        glitchBurst: false
    };
    const next = { ...prev, ...partialState };
    nodeStateMap.set(nodeId, next);

    const marker = nodeMarkersMap.get(nodeId);
    if (marker) {
        marker.setIcon(buildNodeLeafletDivIcon(node, next));
        const popupHtml = buildPopoverHtml(node, next.statusText);
        marker.setPopupContent(popupHtml);
        marker.setTooltipContent(`${node.name} — ${next.statusText}`);
    }
}

function getDefaultEdgeColor() {
    return isLightMode() ? 'rgba(51, 65, 85, 0.52)' : 'rgba(148, 163, 184, 0.34)';
}

function getEdgeFlowColor(edge, srcNode) {
    if (edge.isDynamic) return '#38bdf8';
    if (edge.customColor && edge.color) return edge.color;
    return getSectorAccentColor(srcNode ? srcNode.type : 'energy');
}

function createEdgeArrowMarker(srcNode, tgtNode, color, isSevered = false) {
    const midLat = srcNode.lat + (tgtNode.lat - srcNode.lat) * 0.62;
    const midLon = srcNode.lon + (tgtNode.lon - srcNode.lon) * 0.62;
    const dLat = tgtNode.lat - srcNode.lat;
    const dLon = (tgtNode.lon - srcNode.lon) * Math.cos((midLat * Math.PI) / 180);
    const angleDeg = (Math.atan2(dLon, dLat) * 180) / Math.PI;

    const arrowSvg = `
        <div class="wf-edge-arrow-wrap ${isSevered ? 'wf-arrow-severed' : ''}" style="transform: translate(-50%, -50%) rotate(${angleDeg.toFixed(1)}deg); width:14px; height:14px; display:flex; align-items:center; justify-content:center;">
            <svg width="12" height="12" viewBox="0 0 12 12">
                <path d="M6 1 L10.5 10 L6 7.8 L1.5 10 Z" fill="${color}"/>
            </svg>
        </div>
    `;

    return L.marker([midLat, midLon], {
        icon: L.divIcon({
            className: 'wf-edge-arrow-icon',
            html: arrowSvg,
            iconSize: [0, 0]
        }),
        interactive: false
    });
}

function renderSingleEdgeOnMap(edge) {
    if (!edgesLayerGroup) return;

    const existing = edgeLayersMap.get(edge.id);
    if (existing) {
        if (existing.polyline) edgesLayerGroup.removeLayer(existing.polyline);
        if (existing.flowPolyline) edgesLayerGroup.removeLayer(existing.flowPolyline);
        if (existing.arrow) edgesLayerGroup.removeLayer(existing.arrow);
    }

    const srcNode = topologyNodes.find(n => n.id === edge.from || n.name === edge.from);
    const tgtNode = topologyNodes.find(n => n.id === edge.to || n.name === edge.to);
    if (!srcNode || !tgtNode) return;

    const latLngs = [
        [srcNode.lat, srcNode.lon],
        [tgtNode.lat, tgtNode.lon]
    ];

    const isSevered = edge.color === '#ef4444' || edge.severed === true;
    const isHeal = Boolean(edge.isDynamic);
    const isSurvived = edge.color === '#10b981';

    const conduitColor = isSevered
        ? 'rgba(239, 68, 68, 0.38)'
        : isHeal
        ? 'rgba(56, 189, 248, 0.35)'
        : isSurvived
        ? 'rgba(16, 185, 129, 0.35)'
        : getDefaultEdgeColor();

    // Base physical conduit layer
    const polyline = L.polyline(latLngs, {
        color: conduitColor,
        weight: (edge.weight || 2.0) + 0.6,
        opacity: isSevered ? 0.55 : 0.72,
        dashArray: isSevered ? '4, 7' : null,
        className: isSevered ? 'wf-edge-conduit wf-edge-conduit-severed' : 'wf-edge-conduit'
    }).addTo(edgesLayerGroup);

    // Animated flowing data/resource transmission layer
    const flowColor = getEdgeFlowColor(edge, srcNode);
    const flowClass = isSevered
        ? 'wf-edge-flow wf-edge-flow-severed'
        : isHeal
        ? 'wf-edge-flow wf-edge-flow-heal'
        : isSurvived
        ? 'wf-edge-flow wf-edge-flow-survive'
        : 'wf-edge-flow wf-edge-flow-active';

    const flowPolyline = L.polyline(latLngs, {
        color: flowColor,
        weight: isHeal ? 3.2 : isSurvived ? 2.8 : 2.3,
        opacity: isSevered ? 0.78 : 0.96,
        dashArray: isSevered ? '2, 12' : isHeal ? '10, 14' : '6, 16',
        className: flowClass,
        interactive: false
    }).addTo(edgesLayerGroup);

    const arrow = createEdgeArrowMarker(srcNode, tgtNode, flowColor, isSevered).addTo(edgesLayerGroup);
    edgeLayersMap.set(edge.id, { polyline, flowPolyline, arrow });
}

function refreshAllMapVisuals() {
    if (!nodesLayerGroup || !edgesLayerGroup) return;

    edgesLayerGroup.clearLayers();
    edgeLayersMap.clear();
    topologyEdges.forEach(edge => {
        if (!edge.customColor) {
            edge.color = getDefaultEdgeColor();
        }
        renderSingleEdgeOnMap(edge);
    });

    topologyNodes.forEach(node => {
        const st = nodeStateMap.get(node.id) || {
            statusText: 'Operational',
            statusBadge: '',
            statusColor: '#94a3b8',
            strokeOverride: null,
            isFailed: false,
            glitchBurst: false
        };
        setNodeVisualState(node.id, st);
    });
}

function fitAllNodesBounds(animate = true) {
    if (!leafletMap || topologyNodes.length === 0) return;
    const coords = topologyNodes.map(n => [n.lat, n.lon]);
    const bounds = L.latLngBounds(coords);
    if (bounds.isValid()) {
        leafletMap.fitBounds(bounds, {
            padding: [65, 65],
            maxZoom: 13,
            animate
        });
    }
}

// =========================================================
// INCIDENT TIMELINE / LIVE FEED NOTIFICATION CARDS
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

let currentTelemetryState = {
    state: 'READY',
    evaluated: 0,
    total: 0,
    failed: 0,
    survived: 0
};

function updateVolumetricLighting() {
    const rootStyle = document.documentElement.style;
    const totalNodes = Math.max(1, Number(currentTelemetryState.total) || topologyNodes.length || 1);
    const failedNodes = Number(currentTelemetryState.failed) || 0;
    const failureRatio = Math.min(1, Math.max(0, failedNodes / totalNodes));
    const isError = currentTelemetryState.state === 'ERROR';
    const isReady = currentTelemetryState.state === 'READY' || (failedNodes === 0 && !isError);

    if (isReady) {
        document.body.setAttribute('data-warroom-state', 'stable');
        rootStyle.setProperty('--reactive-border-glow', 'rgba(56, 189, 248, 0.34)');
        rootStyle.setProperty('--reactive-shadow-glow', 'rgba(6, 182, 212, 0.18)');
        rootStyle.setProperty('--reactive-inset-glow', 'rgba(56, 189, 248, 0.06)');
        rootStyle.setProperty('--reactive-ambient-vignette', 'rgba(6, 182, 212, 0.05)');
        return;
    }

    if (failureRatio > 0.30 || isError) {
        const severityScale = isError ? 1.0 : Math.min(1, 0.55 + (failureRatio - 0.30) * 0.65);
        document.body.setAttribute('data-warroom-state', 'critical');
        rootStyle.setProperty('--reactive-border-glow', `rgba(239, 68, 68, ${(0.55 + severityScale * 0.32).toFixed(2)})`);
        rootStyle.setProperty('--reactive-shadow-glow', `rgba(239, 68, 68, ${(0.28 + severityScale * 0.28).toFixed(2)})`);
        rootStyle.setProperty('--reactive-inset-glow', `rgba(239, 68, 68, ${(0.10 + severityScale * 0.10).toFixed(2)})`);
        rootStyle.setProperty('--reactive-ambient-vignette', `rgba(220, 38, 38, ${(0.14 + severityScale * 0.14).toFixed(2)})`);
        return;
    }

    // 0% < failureRatio <= 30%: transitional amber-crimson cascade alert
    const warnScale = failureRatio / 0.30;
    document.body.setAttribute('data-warroom-state', 'elevated');
    rootStyle.setProperty('--reactive-border-glow', `rgba(245, 158, 11, ${(0.38 + warnScale * 0.22).toFixed(2)})`);
    rootStyle.setProperty('--reactive-shadow-glow', `rgba(245, 158, 11, ${(0.18 + warnScale * 0.14).toFixed(2)})`);
    rootStyle.setProperty('--reactive-inset-glow', `rgba(245, 158, 11, ${(0.06 + warnScale * 0.05).toFixed(2)})`);
    rootStyle.setProperty('--reactive-ambient-vignette', `rgba(245, 158, 11, ${(0.07 + warnScale * 0.06).toFixed(2)})`);
}

function updateTelemetry({ state, evaluated, total, failed, survived }) {
    const statState = document.getElementById('stat-state');
    const statEvaluated = document.getElementById('stat-evaluated');
    const statFailed = document.getElementById('stat-failed');
    const statSurvived = document.getElementById('stat-survived');

    if (state !== undefined) currentTelemetryState.state = state;
    if (evaluated !== undefined) currentTelemetryState.evaluated = evaluated;
    if (total !== undefined) currentTelemetryState.total = total;
    if (failed !== undefined) currentTelemetryState.failed = failed;
    if (survived !== undefined) currentTelemetryState.survived = survived;

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

    updateVolumetricLighting();
}

function resetGraphState() {
    savedNodeIds.clear();
    impactNodeId = null;

    const exportPdfBtn = document.getElementById('export-pdf-btn');
    if (exportPdfBtn) {
        exportPdfBtn.disabled = true;
    }

    topologyEdges = topologyEdges
        .filter(e => !e.isDynamic)
        .map(e => ({
            ...e,
            color: getDefaultEdgeColor(),
            customColor: false,
            weight: 2.0,
            dashArray: null
        }));

    topologyNodes.forEach(node => {
        nodeStateMap.set(node.id, {
            statusText: 'Operational',
            statusBadge: '',
            statusColor: '#94a3b8',
            strokeOverride: null,
            isFailed: false,
            glitchBurst: false
        });
    });

    refreshAllMapVisuals();

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
    const nodeCountBadge = document.getElementById('node-count-badge');

    try {
        try {
            const cfgResp = await fetch('/api/v1/config/map');
            if (cfgResp.ok) {
                const cfg = await cfgResp.json();
                if (cfg.carto_api_key) {
                    cartoApiKey = cfg.carto_api_key;
                }
            }
        } catch (_) {
            // Continue with default tile configuration
        }

        initLeafletCommandMap();
        if (leafletMap && baseTileLayer) {
            baseTileLayer.setUrl(getTileUrl(currentTheme));
        }

        const response = await fetch('/api/v1/topology');
        if (!response.ok) {
            throw new Error(`Failed to fetch topology (HTTP ${response.status})`);
        }

        const data = await response.json();
        const rawNodes = Array.isArray(data.nodes) ? data.nodes : [];
        const rawEdges = Array.isArray(data.edges) ? data.edges : [];

        topologyNodes = rawNodes.map((node, idx) => {
            const nodeName = node.name || node.label || String(node.id);
            const nodeId = String(node.id ?? nodeName);
            const nodeType = node.type || node.group || 'energy';
            const rawX = Number(node.x ?? -80.205);
            const rawY = Number(node.y ?? 25.778);
            const geo = normalizeGeoCoordinates(rawX, rawY, idx);

            return {
                id: nodeId,
                name: nodeName,
                type: nodeType,
                rawX,
                rawY,
                lat: geo.lat,
                lon: geo.lon
            };
        });

        declusterGeoPositions(topologyNodes);

        if (nodeCountBadge) {
            nodeCountBadge.textContent = `${topologyNodes.length} nodes`;
        }

        topologyEdges = rawEdges.map((edge, idx) => ({
            id: `edge_${idx}`,
            from: String(edge.source ?? edge.from),
            to: String(edge.target ?? edge.to),
            color: getDefaultEdgeColor(),
            customColor: false,
            weight: 2.0,
            dashArray: null,
            isDynamic: false
        }));

        if (nodesLayerGroup) {
            nodesLayerGroup.clearLayers();
        }
        nodeMarkersMap.clear();
        nodeStateMap.clear();

        topologyNodes.forEach(node => {
            const initialState = {
                statusText: 'Operational',
                statusBadge: '',
                statusColor: '#94a3b8',
                strokeOverride: null
            };
            nodeStateMap.set(node.id, initialState);

            const marker = L.marker([node.lat, node.lon], {
                icon: buildNodeLeafletDivIcon(node, initialState)
            });

            marker.bindPopup(buildPopoverHtml(node, 'Operational'));
            marker.bindTooltip(`${node.name} — Operational`, {
                direction: 'top',
                offset: [0, -18],
                opacity: 0.92
            });

            if (nodesLayerGroup) {
                marker.addTo(nodesLayerGroup);
            }
            nodeMarkersMap.set(node.id, marker);
        });

        refreshAllMapVisuals();
        fitAllNodesBounds(false);

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
                disaster_direction: trajectory,
                trajectory: trajectory
            })
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.detail || errData.error || `Simulation failed (HTTP ${response.status})`);
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
    if (!matchingNode) return;

    impactNodeId = nodeId;
    if (leafletMap) {
        leafletMap.flyTo([matchingNode.lat, matchingNode.lon], Math.max(leafletMap.getZoom(), 13), {
            duration: 0.45
        });
    }

    const flashColors = ['#f59e0b', '#ef4444', '#f59e0b', '#ef4444'];
    for (let f = 0; f < flashColors.length; f++) {
        setNodeVisualState(nodeId, {
            statusText: 'Epicenter Impact',
            statusBadge: '• Impact',
            statusColor: flashColors[f],
            strokeOverride: flashColors[f],
            isFailed: true,
            glitchBurst: true
        });
        await new Promise(resolve => setTimeout(resolve, 140));
    }

    setNodeVisualState(nodeId, {
        statusText: 'Epicenter Impact (Failed)',
        statusBadge: '• Epicenter',
        statusColor: '#ef4444',
        strokeOverride: '#ef4444',
        isFailed: true,
        glitchBurst: true
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

        if (matchingNode) {
            setNodeVisualState(nodeId, {
                statusText: 'Evaluating…',
                statusBadge: '• Evaluating…',
                statusColor: '#eab308',
                strokeOverride: '#eab308',
                isFailed: false,
                glitchBurst: false
            });

            if (leafletMap) {
                leafletMap.panTo([matchingNode.lat, matchingNode.lon], {
                    animate: true,
                    duration: 0.35
                });
            }
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

        if (matchingNode) {
            setNodeVisualState(nodeId, {
                statusText: survived ? 'Operational (Survived)' : 'Cascade Failure',
                statusBadge,
                statusColor: statusStroke,
                strokeOverride: statusStroke,
                isFailed: !survived,
                glitchBurst: !survived
            });
        }

        topologyEdges.forEach(edge => {
            const matches = step.parent_node
                ? (edge.from === step.parent_node && edge.to === nodeId) ||
                  (edge.from === nodeId && edge.to === step.parent_node)
                : edge.to === nodeId && evaluatedSet.has(edge.from);

            if (matches) {
                edge.color = survived ? '#10b981' : '#ef4444';
                edge.customColor = true;
                edge.weight = 3.0;
                renderSingleEdgeOnMap(edge);
            }
        });

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
            const hasRecoveryEdge = Boolean(step.new_edge && step.new_edge.source && step.new_edge.target);
            const failureDesc = hasRecoveryEdge
                ? `Upstream dependency from ${step.parent_node || 'Epicenter'} was severed by the disaster impact.`
                : `${step.reasoning} (Upstream failure: ${step.parent_node || 'Epicenter'})`;
            appendFeedCard({
                variant: 'fail',
                iconSvg: FEED_SVGS.fail,
                iconClass: 'fail-icon',
                title: nodeName,
                pillText: 'Cascade Failure',
                pillClass: 'pill-fail',
                description: failureDesc,
                pdfSummary: `[STEP ${stepNum}/${trace.length}] ${connectionContext} [FAILED]: ${failureDesc}`
            });
        }

        if (step.new_edge && step.new_edge.source && step.new_edge.target) {
            await new Promise(resolve => setTimeout(resolve, 320));

            const healEdgeId = `heal_edge_${stepNum}_${step.new_edge.source}_${step.new_edge.target}`;
            if (!topologyEdges.some(e => e.id === healEdgeId)) {
                const newHealEdge = {
                    id: healEdgeId,
                    from: step.new_edge.source,
                    to: step.new_edge.target,
                    color: '#38bdf8',
                    customColor: true,
                    weight: 3.2,
                    dashArray: '8, 6',
                    isDynamic: true
                };
                topologyEdges.push(newHealEdge);
                renderSingleEdgeOnMap(newHealEdge);
            }

            savedNodeIds.add(nodeId);

            if (matchingNode) {
                setNodeVisualState(nodeId, {
                    statusText: `AI Restored via ${step.new_edge.source}`,
                    statusBadge: '• AI Restored',
                    statusColor: '#38bdf8',
                    strokeOverride: '#38bdf8',
                    isFailed: false,
                    glitchBurst: false
                });
            }

            const estCost = step.new_edge.estimated_cost ?? step.estimated_cost;
            const recTimeMs = step.new_edge.recovery_time_ms ?? step.recovery_time_ms;
            const metricsSuffix = (estCost !== undefined && estCost !== null && recTimeMs !== undefined && recTimeMs !== null)
                ? ` (Est. Cost: $${Number(estCost).toLocaleString()} • Latency: ${recTimeMs} ms)`
                : '';
            const llmRecoveryReason = step.reasoning ? ` AI Recovery Rationale: ${step.reasoning}` : '';
            const rerouteSummary = `Emergency supply rerouted from ${step.new_edge.source} to ${step.new_edge.target} — service restored.${metricsSuffix}${llmRecoveryReason}`;
            appendFeedCard({
                variant: 'recovery',
                iconSvg: FEED_SVGS.shield,
                iconClass: 'recovery-icon',
                title: 'AI Rerouting Active',
                pillText: `${step.new_edge.source} → ${step.new_edge.target}`,
                pillClass: 'pill-recovery',
                description: rerouteSummary,
                pdfSummary: `[AI REROUTING ACTIVE] ${rerouteSummary}`
            });

            await new Promise(resolve => setTimeout(resolve, 750));
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

    fitAllNodesBounds(true);

    const exportPdfBtn = document.getElementById('export-pdf-btn');
    if (exportPdfBtn) {
        exportPdfBtn.disabled = false;
    }
}

/**
 * Renders a high-resolution vector canvas snapshot of the Miami topology & self-healing links
 * for the PDF Incident Report (avoiding cross-origin tile taint issues).
 */
function renderTopologySnapshotCanvas(targetWidth = 1200, targetHeight = 520) {
    const snapshotCanvas = document.createElement('canvas');
    snapshotCanvas.width = targetWidth;
    snapshotCanvas.height = targetHeight;
    const ctx = snapshotCanvas.getContext('2d');

    ctx.fillStyle = '#090d14';
    ctx.fillRect(0, 0, targetWidth, targetHeight);

    // Subtle GIS grid lines
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.08)';
    ctx.lineWidth = 1;
    for (let x = 60; x < targetWidth; x += 60) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, targetHeight);
        ctx.stroke();
    }
    for (let y = 60; y < targetHeight; y += 60) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(targetWidth, y);
        ctx.stroke();
    }

    if (topologyNodes.length === 0) return snapshotCanvas;

    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    topologyNodes.forEach(n => {
        if (n.lat < minLat) minLat = n.lat;
        if (n.lat > maxLat) maxLat = n.lat;
        if (n.lon < minLon) minLon = n.lon;
        if (n.lon > maxLon) maxLon = n.lon;
    });

    const padX = 95;
    const padY = 65;
    const latSpan = Math.max(0.01, maxLat - minLat);
    const lonSpan = Math.max(0.01, maxLon - minLon);

    const project = (node) => ({
        x: padX + ((node.lon - minLon) / lonSpan) * (targetWidth - padX * 2),
        y: padY + ((maxLat - node.lat) / latSpan) * (targetHeight - padY * 2)
    });

    // Draw edges
    topologyEdges.forEach(edge => {
        const src = topologyNodes.find(n => n.id === edge.from || n.name === edge.from);
        const tgt = topologyNodes.find(n => n.id === edge.to || n.name === edge.to);
        if (!src || !tgt) return;
        const p1 = project(src);
        const p2 = project(tgt);

        ctx.save();
        ctx.beginPath();
        if (edge.dashArray) {
            ctx.setLineDash([8, 6]);
        }
        ctx.strokeStyle = edge.color || 'rgba(148, 163, 184, 0.45)';
        ctx.lineWidth = edge.weight || 2;
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
        ctx.restore();
    });

    // Draw nodes & labels
    topologyNodes.forEach(node => {
        const pt = project(node);
        const st = nodeStateMap.get(node.id) || {};
        const color = st.strokeOverride || getSectorAccentColor(node.type);

        ctx.save();
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 12, 0, Math.PI * 2);
        ctx.fillStyle = '#0f172a';
        ctx.fill();
        ctx.lineWidth = 2.8;
        ctx.strokeStyle = color;
        ctx.stroke();

        ctx.font = '600 11px Inter, sans-serif';
        ctx.fillStyle = '#f8fafc';
        ctx.textAlign = 'center';
        ctx.fillText(truncateLabel(node.name, 18), pt.x, pt.y + 26);
        if (st.statusBadge) {
            ctx.font = '700 10px Inter, sans-serif';
            ctx.fillStyle = st.statusColor || color;
            ctx.fillText(st.statusBadge, pt.x, pt.y + 39);
        }
        ctx.restore();
    });

    return snapshotCanvas;
}

/**
 * Captures the topology snapshot and Incident Timeline feed,
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

        const snapshotCanvas = renderTopologySnapshotCanvas(1200, 520);
        const canvasData = snapshotCanvas.toDataURL('image/png');
        await new Promise((resolve) => {
            mapSnapshotImg.onload = resolve;
            mapSnapshotImg.onerror = resolve;
            mapSnapshotImg.src = canvasData;
        });

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

// ── HAZARD SCENARIO & SEVERITY CATALOG ──
const SEVERITY_META = {
    1: { name: 'Minor', badgeClass: 'sev-level-1' },
    2: { name: 'Moderate', badgeClass: 'sev-level-2' },
    3: { name: 'Major', badgeClass: 'sev-level-3' },
    4: { name: 'Extreme', badgeClass: 'sev-level-4' },
    5: { name: 'Catastrophic', badgeClass: 'sev-level-5' }
};

const HAZARD_CATALOG = {
    'Hurricane': {
        category: 'Cyclonic',
        scaleHint: 'Saffir-Simpson Hurricane Wind Scale (Cat 1–5) & coastal storm surge.',
        trajectoryPlaceholder: 'e.g., Landfall from the Atlantic East coast across Biscayne Bay...',
        levels: [
            { level: 1, value: 'Category 1 (85 mph sustained winds, 4 ft surge)', label: 'L1 — Category 1 (85 mph • 4 ft surge)' },
            { level: 2, value: 'Category 2 (105 mph sustained winds, 7 ft surge)', label: 'L2 — Category 2 (105 mph • 7 ft surge)' },
            { level: 3, value: 'Category 3 Major (125 mph sustained winds, 11 ft surge)', label: 'L3 — Category 3 Major (125 mph • 11 ft surge)' },
            { level: 4, value: 'Category 4 Extreme (145 mph sustained winds, 15 ft surge)', label: 'L4 — Category 4 Extreme (145 mph • 15 ft surge)' },
            { level: 5, value: 'Category 5 Catastrophic (175 mph winds, 19 ft surge)', label: 'L5 — Category 5 Catastrophic (175 mph • 19 ft surge)' }
        ]
    },
    'Tornado Outbreak': {
        category: 'Meteorological',
        scaleHint: 'Enhanced Fujita (EF) Tornado Damage Scale (EF-1 to EF-5).',
        trajectoryPlaceholder: 'e.g., Supercell track sweeping SW to NE across Downtown Miami...',
        levels: [
            { level: 1, value: 'EF-1 Moderate Tornado (100 mph vortex winds)', label: 'L1 — EF-1 Tornado (100 mph winds)' },
            { level: 2, value: 'EF-2 Significant Tornado (125 mph vortex winds)', label: 'L2 — EF-2 Significant (125 mph winds)' },
            { level: 3, value: 'EF-3 Severe Multi-Vortex Tornado (155 mph winds)', label: 'L3 — EF-3 Severe (155 mph winds)' },
            { level: 4, value: 'EF-4 Devastating Tornado (185 mph winds)', label: 'L4 — EF-4 Devastating (185 mph winds)' },
            { level: 5, value: 'EF-5 Incredible Wedge Tornado (215 mph winds)', label: 'L5 — EF-5 Wedge Tornado (215 mph winds)' }
        ]
    },
    'Severe Derecho & Lightning Storm': {
        category: 'Meteorological',
        scaleHint: 'Straight-line convective wind gust speed & cloud-to-ground lightning density.',
        trajectoryPlaceholder: 'e.g., Squall line advancing rapidly from the North-West...',
        levels: [
            { level: 1, value: 'Severe Squall (65 mph gusts, localized lightning)', label: 'L1 — Severe Squall (65 mph gusts)' },
            { level: 2, value: 'Moderate Derecho (80 mph gusts, heavy lightning strikes)', label: 'L2 — Moderate Derecho (80 mph gusts)' },
            { level: 3, value: 'Major Derecho (95 mph microbursts, substation flashovers)', label: 'L3 — Major Derecho (95 mph microbursts)' },
            { level: 4, value: 'Extreme Derecho (115 mph winds, widespread tower collapse)', label: 'L4 — Extreme Derecho (115 mph winds)' },
            { level: 5, value: 'Catastrophic Super-Derecho (135 mph straight-line winds)', label: 'L5 — Super-Derecho (135 mph winds)' }
        ]
    },
    'Earthquake': {
        category: 'Seismic',
        scaleHint: 'Moment Magnitude Scale (Mw) & Modified Mercalli Intensity (MMI) ground shaking.',
        trajectoryPlaceholder: 'e.g., Shallow crustal rupture propagating from South-East offshore fault...',
        levels: [
            { level: 1, value: '5.2 Mw (MMI VI Strong Shaking, 0.12g PGA)', label: 'L1 — 5.2 Mw (MMI VI Strong • 0.12g PGA)' },
            { level: 2, value: '6.1 Mw (MMI VII Very Strong, 0.25g PGA, limestone fissuring)', label: 'L2 — 6.1 Mw (MMI VII Very Strong • 0.25g PGA)' },
            { level: 3, value: '6.9 Mw (MMI VIII Severe Shaking, 0.45g PGA, soil liquefaction)', label: 'L3 — 6.9 Mw (MMI VIII Severe • Liquefaction)' },
            { level: 4, value: '7.6 Mw (MMI IX Violent Shaking, 0.70g PGA, unreinforced collapse)', label: 'L4 — 7.6 Mw (MMI IX Violent • 0.70g PGA)' },
            { level: 5, value: '8.3 Mw Megathrust (MMI X+ Extreme, 1.05g PGA, widespread liquefaction)', label: 'L5 — 8.3 Mw Megathrust (MMI X+ Extreme)' }
        ]
    },
    'Tsunami': {
        category: 'Marine / Seismic',
        scaleHint: 'Coastal wave run-up height (meters) & hydrodynamic inland inundation velocity.',
        trajectoryPlaceholder: 'e.g., Atlantic Trench tsunami wave train striking the East Coast...',
        levels: [
            { level: 1, value: '1.8m Run-up (Strong coastal currents & marina flooding)', label: 'L1 — 1.8m Run-up (Coastal Surge)' },
            { level: 2, value: '3.5m Run-up (Barrier island & port inundation)', label: 'L2 — 3.5m Run-up (Barrier Island Flood)' },
            { level: 3, value: '6.0m Major Tsunami (2 km inland hydrodynamic bore)', label: 'L3 — 6.0m Major Tsunami (2 km Inland Bore)' },
            { level: 4, value: '10.0m Extreme Tsunami (4.5 km inland destructive wave train)', label: 'L4 — 10.0m Extreme Tsunami (4.5 km Inland)' },
            { level: 5, value: '16.0m Mega-Tsunami (Catastrophic basin-wide coastal obliteration)', label: 'L5 — 16.0m Mega-Tsunami (Basin Inundation)' }
        ]
    },
    'Karst Sinkhole Collapse': {
        category: 'Geological',
        scaleHint: 'Limestone cavern collapse diameter (meters) & subterranean utility shear depth.',
        trajectoryPlaceholder: 'e.g., Biscayne Aquifer karst dissolution zone along Brickell / Downtown...',
        levels: [
            { level: 1, value: 'Localized Subsidence (15m diameter, 1.5m road settlement)', label: 'L1 — 15m Subsidence (Localized Settlement)' },
            { level: 2, value: 'Moderate Sinkhole (35m diameter, buried water main shear)', label: 'L2 — 35m Sinkhole (Water Main Shear)' },
            { level: 3, value: 'Major Karst Collapse (75m crater, foundation & duct bank rupture)', label: 'L3 — 75m Karst Collapse (Foundation Shear)' },
            { level: 4, value: 'Multi-Block Cavern Failure (150m collapse zone, substation drop)', label: 'L4 — 150m Multi-Block Cavern Collapse' },
            { level: 5, value: 'Regional Karst Chain Collapse (300m+ corridor structural failure)', label: 'L5 — 300m+ Regional Karst Chain Collapse' }
        ]
    },
    'Storm Surge & Flash Flood': {
        category: 'Hydrological',
        scaleHint: 'Inundation depth (feet above grade) & extreme rainfall accumulation rate.',
        trajectoryPlaceholder: 'e.g., Biscayne Bay coastal surge converging with Miami River overflow...',
        levels: [
            { level: 1, value: '3 ft Street Flooding (6 in/hr rain, low-lying road closures)', label: 'L1 — 3 ft Flooding (6 in/hr Rainfall)' },
            { level: 2, value: '6 ft Urban Flash Flood (10 in/hr rain, ground-level vault flood)', label: 'L2 — 6 ft Flash Flood (Vault Submersion)' },
            { level: 3, value: '10 ft Major Storm Surge (Substation & pump station inundation)', label: 'L3 — 10 ft Major Surge (Substation Flood)' },
            { level: 4, value: '15 ft Extreme Surge (20 in rain, widespread critical grid submergence)', label: 'L4 — 15 ft Extreme Surge (20 in Rain)' },
            { level: 5, value: '22 ft Catastrophic Inundation (500-year compound coastal flood)', label: 'L5 — 22 ft Catastrophic 500-Yr Inundation' }
        ]
    },
    'King Tide & Saltwater Intrusion': {
        category: 'Coastal',
        scaleHint: 'Perigean spring tide elevation (ft MHHW) & underground saltwater conductivity.',
        trajectoryPlaceholder: 'e.g., Coastal Biscayne Aquifer & underground vault network from East...',
        levels: [
            { level: 1, value: '+2.5 ft MHHW King Tide (Minor coastal drainage backflow)', label: 'L1 — +2.5 ft MHHW (Drainage Backflow)' },
            { level: 2, value: '+3.8 ft MHHW Tide (Underground cable vault brine seepage)', label: 'L2 — +3.8 ft MHHW (Vault Brine Seepage)' },
            { level: 3, value: '+5.2 ft MHHW Compound Tide (Wellfield salinity spike & transformer arcing)', label: 'L3 — +5.2 ft MHHW (Wellfield Salinity Spike)' },
            { level: 4, value: '+6.8 ft MHHW Extreme Intrusion (Widespread underground grid corrosion)', label: 'L4 — +6.8 ft MHHW (Underground Grid Short)' },
            { level: 5, value: '+8.5 ft MHHW Catastrophic Brine Inundation (Aquifer & substation collapse)', label: 'L5 — +8.5 ft MHHW (Aquifer Contamination)' }
        ]
    },
    'Extreme Heatwave': {
        category: 'Climatological',
        scaleHint: 'Peak Heat Index (°F), wet-bulb temperature, and peak HVAC grid load surge.',
        trajectoryPlaceholder: 'e.g., Stagnant thermal dome centered over inland urban core...',
        levels: [
            { level: 1, value: '105°F Heat Index (3-day advisory, +12% peak power demand)', label: 'L1 — 105°F Heat Index (+12% Grid Load)' },
            { level: 2, value: '112°F Heat Index (5-day warning, +22% grid load, transformer derating)', label: 'L2 — 112°F Heat Index (Transformer Derating)' },
            { level: 3, value: '118°F Major Heat Dome (+35% load, line sag & forced brownouts)', label: 'L3 — 118°F Major Heat Dome (Line Sag)' },
            { level: 4, value: '125°F Extreme Wet-Bulb Crisis (Substation thermal trip & coolant loss)', label: 'L4 — 125°F Extreme Thermal Trip Crisis' },
            { level: 5, value: '134°F Catastrophic Grid Meltdown (Cascading transformer explosions)', label: 'L5 — 134°F Catastrophic Grid Meltdown' }
        ]
    },
    'Everglades Wildfire & Smoke Plume': {
        category: 'Environmental',
        scaleHint: 'Fireline intensity, ember cast distance, and PM2.5 conductive soot density.',
        trajectoryPlaceholder: 'e.g., Westerly wind driving Everglades crown fire & dense smoke East...',
        levels: [
            { level: 1, value: 'Red Flag Brush Fire (AQI 180, localized visibility drop)', label: 'L1 — Brush Fire (AQI 180 Smoke Plume)' },
            { level: 2, value: '2,500-Acre Wildfire (AQI 300, high-voltage transmission line ionization)', label: 'L2 — 2,500-Acre Fire (HV Line Ionization)' },
            { level: 3, value: '10,000-Acre Major Firestorm (AQI 450, HV line phase-to-phase faults)', label: 'L3 — 10,000-Acre Firestorm (HV Arcing)' },
            { level: 4, value: 'Extreme WUI Ember Storm (AQI 600+, hospital HVAC & substation shutdown)', label: 'L4 — Extreme Ember Storm (HVAC Failure)' },
            { level: 5, value: 'Catastrophic Fire Complex (Direct perimeter breach & corridor collapse)', label: 'L5 — Catastrophic Fire Complex Breach' }
        ]
    },
    'Solar Storm / Geomagnetic EMP': {
        category: 'Space Weather',
        scaleHint: 'NOAA Geomagnetic Storm Scale (G1–G5) & Geomagnetically Induced Currents (GIC).',
        trajectoryPlaceholder: 'e.g., High-latitude & coastal long-conductor transmission corridors...',
        levels: [
            { level: 1, value: 'G1 Minor Storm (Kp 5, minor grid voltage fluctuations)', label: 'L1 — G1 Minor Storm (Kp 5 Fluctuations)' },
            { level: 2, value: 'G2 Moderate Storm (Kp 6, HF comms degradation & transformer alarms)', label: 'L2 — G2 Moderate Storm (Kp 6 Alarms)' },
            { level: 3, value: 'G3 Strong Geomagnetic Storm (Kp 7, 150 A GIC harmonic distortion)', label: 'L3 — G3 Strong Storm (150 A GIC Harmonics)' },
            { level: 4, value: 'G4 Severe Superstorm (Kp 8+, 350 A GIC protective relay tripping)', label: 'L4 — G4 Severe Superstorm (Relay Tripping)' },
            { level: 5, value: 'G5 Carrington-Class EMP (Kp 9, 800+ A GIC permanent HV transformer burn)', label: 'L5 — G5 Carrington-Class EMP (HV Burnout)' }
        ]
    },
    'Cyber-Physical Grid Attack': {
        category: 'Technological',
        scaleHint: 'ICS/SCADA compromise depth, breaker trip synchronization & telemetry spoofing.',
        trajectoryPlaceholder: 'e.g., Coordinated SCADA payload targeting primary energy & water nodes...',
        levels: [
            { level: 1, value: 'Tier-1 Telemetry DDoS (SCADA polling latency, manual fallback)', label: 'L1 — Tier-1 SCADA Telemetry DDoS' },
            { level: 2, value: 'Tier-2 PLC Unauthorized Trip (Isolated distribution feeder lockout)', label: 'L2 — Tier-2 PLC Feeder Lockout' },
            { level: 3, value: 'Tier-3 Coordinated ICS Intrusion (Multi-substation relay manipulation)', label: 'L3 — Tier-3 Multi-Substation ICS Intrusion' },
            { level: 4, value: 'Tier-4 Destructive Firmware Attack (Aurora-style generator out-of-phase)', label: 'L4 — Tier-4 Aurora Physical Breaker Attack' },
            { level: 5, value: 'Tier-5 Zero-Day Blackout Worm (Simultaneous energy, water & comms wipe)', label: 'L5 — Tier-5 Zero-Day Multi-Sector Wipe' }
        ]
    }
};

let activeSeverityLevel = 5;

function initHazardAndMagnitudeSelectors() {
    const disasterSelect = document.getElementById('disaster-type');
    const categoryBadge = document.getElementById('hazard-category-badge');
    const severityBadge = document.getElementById('severity-level-badge');
    const severityTierBar = document.getElementById('severity-tier-bar');
    const magnitudeSelect = document.getElementById('disaster-magnitude-select');
    const magnitudeInput = document.getElementById('disaster-magnitude');
    const scaleHint = document.getElementById('hazard-scale-hint');
    const trajectoryInput = document.getElementById('disaster-trajectory');

    if (!disasterSelect || !magnitudeSelect || !magnitudeInput) return;

    function applySeverityBadgeAndSteps(levelOrCustom) {
        const steps = severityTierBar ? severityTierBar.querySelectorAll('.sev-step') : [];
        if (levelOrCustom === 'custom') {
            if (severityBadge) {
                severityBadge.textContent = 'Custom Scale';
                severityBadge.className = 'badge severity-badge sev-level-custom';
            }
            steps.forEach(btn => {
                btn.classList.remove('active', 'filled');
            });
            return;
        }

        const numericLevel = Math.min(5, Math.max(1, Number(levelOrCustom) || 5));
        activeSeverityLevel = numericLevel;
        const meta = SEVERITY_META[numericLevel] || SEVERITY_META[5];

        if (severityBadge) {
            severityBadge.textContent = `Level ${numericLevel} • ${meta.name}`;
            severityBadge.className = `badge severity-badge ${meta.badgeClass}`;
        }

        steps.forEach(btn => {
            const stepLvl = Number(btn.dataset.level);
            btn.classList.toggle('active', stepLvl === numericLevel);
            btn.classList.toggle('filled', stepLvl <= numericLevel);
        });
    }

    function populateMagnitudeOptions(hazardKey, targetLevel) {
        const catalogEntry = HAZARD_CATALOG[hazardKey] || HAZARD_CATALOG['Hurricane'];
        if (categoryBadge) {
            categoryBadge.textContent = catalogEntry.category;
        }
        if (scaleHint) {
            scaleHint.textContent = catalogEntry.scaleHint;
        }
        if (trajectoryInput && catalogEntry.trajectoryPlaceholder) {
            trajectoryInput.placeholder = catalogEntry.trajectoryPlaceholder;
        }

        magnitudeSelect.innerHTML = '';
        catalogEntry.levels.forEach(item => {
            const opt = document.createElement('option');
            opt.value = item.value;
            opt.textContent = item.label;
            opt.dataset.level = String(item.level);
            magnitudeSelect.appendChild(opt);
        });

        const customOpt = document.createElement('option');
        customOpt.value = '__custom__';
        customOpt.textContent = 'Custom Intensity / Magnitude...';
        magnitudeSelect.appendChild(customOpt);

        const chosen = catalogEntry.levels.find(l => l.level === targetLevel) || catalogEntry.levels[4];
        magnitudeSelect.value = chosen.value;
        magnitudeInput.value = chosen.value;
        magnitudeInput.classList.add('hidden');
        applySeverityBadgeAndSteps(chosen.level);
    }

    disasterSelect.addEventListener('change', () => {
        populateMagnitudeOptions(disasterSelect.value, activeSeverityLevel);
    });

    if (severityTierBar) {
        severityTierBar.addEventListener('click', (e) => {
            const stepBtn = e.target.closest('.sev-step');
            if (!stepBtn || isSimulating) return;
            const lvl = Number(stepBtn.dataset.level);
            if (!lvl) return;

            const catalogEntry = HAZARD_CATALOG[disasterSelect.value] || HAZARD_CATALOG['Hurricane'];
            const chosen = catalogEntry.levels.find(l => l.level === lvl);
            if (chosen) {
                magnitudeSelect.value = chosen.value;
                magnitudeInput.value = chosen.value;
                magnitudeInput.classList.add('hidden');
                applySeverityBadgeAndSteps(lvl);
            }
        });
    }

    magnitudeSelect.addEventListener('change', () => {
        if (magnitudeSelect.value === '__custom__') {
            magnitudeInput.classList.remove('hidden');
            applySeverityBadgeAndSteps('custom');
            magnitudeInput.focus();
            magnitudeInput.select();
        } else {
            const selectedOpt = magnitudeSelect.options[magnitudeSelect.selectedIndex];
            const lvl = selectedOpt ? Number(selectedOpt.dataset.level) : activeSeverityLevel;
            magnitudeInput.value = magnitudeSelect.value;
            magnitudeInput.classList.add('hidden');
            applySeverityBadgeAndSteps(lvl);
        }
    });

    populateMagnitudeOptions(disasterSelect.value, activeSeverityLevel);
}

document.addEventListener('DOMContentLoaded', () => {
    applyTheme(currentTheme);
    initHazardAndMagnitudeSelectors();
    fetchAndRenderTopology();
    updateAuthBar();

    const themeToggleBtn = document.getElementById('theme-toggle-btn');
    if (themeToggleBtn) {
        themeToggleBtn.addEventListener('click', toggleTheme);
    }

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
            setTimeout(() => {
                if (leafletMap) leafletMap.invalidateSize();
            }, 260);
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
            if (leafletMap) leafletMap.invalidateSize();
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

            if (leafletMap) {
                leafletMap.invalidateSize();
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
            } else if (leafletMap) {
                leafletMap.invalidateSize();
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
            fitAllNodesBounds(true);
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