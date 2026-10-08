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

async function updateAuthBar() {
    const token = localStorage.getItem(AUTH_TOKEN_KEY);

    const userEl = document.getElementById('auth-user');
    const adminLink = document.getElementById('auth-admin-link');
    const loginLink = document.getElementById('auth-login-link');
    const logoutBtn = document.getElementById('auth-logout-btn');

    if (!userEl || !adminLink || !loginLink || !logoutBtn) return;

    if (!token) {
        userEl.textContent = 'Guest Operator';
        adminLink.classList.add('hidden');
        loginLink.classList.remove('hidden');
        logoutBtn.classList.add('hidden');
        return;
    }

    try {
        const resp = await fetch('/api/v1/auth/me', {
            method: 'GET',
            credentials: 'same-origin',
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!resp.ok) {
            throw new Error('Invalid session');
        }
        const user = await resp.json();
        const isAdmin = Boolean(user.is_admin && user.is_active);
        localStorage.setItem(AUTH_USER_KEY, user.username);
        localStorage.setItem(AUTH_ADMIN_KEY, String(isAdmin));

        userEl.textContent = `${user.username}${isAdmin ? ' (Admin)' : ''}`;
        adminLink.classList.toggle('hidden', !isAdmin);
        loginLink.classList.add('hidden');
        logoutBtn.classList.remove('hidden');
    } catch (_) {
        localStorage.removeItem(AUTH_TOKEN_KEY);
        localStorage.removeItem(AUTH_USER_KEY);
        localStorage.removeItem(AUTH_ADMIN_KEY);
        userEl.textContent = 'Guest Operator';
        adminLink.classList.add('hidden');
        loginLink.classList.remove('hidden');
        logoutBtn.classList.add('hidden');
    }
}

async function handleLogout() {
    const token = localStorage.getItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_USER_KEY);
    localStorage.removeItem(AUTH_ADMIN_KEY);
    try {
        await fetch('/api/v1/auth/logout', {
            method: 'POST',
            credentials: 'same-origin',
            headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
    } catch (_) {
        // Ignore network errors during logout
    }
    await updateAuthBar();
    appendSystemCard('Operator Session Ended', 'You have signed out and your session token has been revoked.');
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

function getSviBadgeMeta(sviScore) {
    if (sviScore === null || sviScore === undefined || !Number.isFinite(Number(sviScore))) {
        return null;
    }
    const val = Math.max(0.0, Math.min(1.0, Number(sviScore)));
    const sviFormatted = val.toFixed(2);
    if (val < 0.3) {
        return {
            value: val,
            sviFormatted,
            riskLabel: 'Low Risk',
            pillClass: 'svi-badge-low',
            badgeText: `SVI: ${sviFormatted} - Low Risk`
        };
    }
    if (val <= 0.7) {
        return {
            value: val,
            sviFormatted,
            riskLabel: 'Moderate Risk',
            pillClass: 'svi-badge-moderate',
            badgeText: `SVI: ${sviFormatted} - Moderate Risk`
        };
    }
    return {
        value: val,
        sviFormatted,
        riskLabel: 'High Risk',
        pillClass: 'svi-badge-high',
        badgeText: `SVI: ${sviFormatted} - High Risk`
    };
}

function buildPopoverHtml(node, statusText = 'Operational') {
    const sector = String(node.type || 'energy').toUpperCase();
    const accent = getSectorAccentColor(node.type);
    const coords = `${Number(node.lat || 0).toFixed(4)}° N, ${Math.abs(Number(node.lon || 0)).toFixed(4)}° W`;
    const sviMeta = getSviBadgeMeta(node.sviScore);
    const popVal = Number(node.populationServed || 0);
    const demoHtml = sviMeta
        ? `<div class="gis-popup-demographics">
               <span class="feed-svi-pill ${sviMeta.pillClass}">${escapeHtml(sviMeta.badgeText)}</span>
               ${popVal > 0 ? `<span class="feed-pop-pill">Pop: ${popVal.toLocaleString()}</span>` : ''}
           </div>`
        : '';
    return `
        <div class="gis-popup">
            <div class="gis-popup-header">
                <span class="gis-popup-sector" style="background:${accent}22;color:${accent};border:1px solid ${accent}55;">${escapeHtml(sector)}</span>
                <span class="gis-popup-id">${escapeHtml(statusText)}</span>
            </div>
            <div class="gis-popup-title">${escapeHtml(node.name)}</div>
            <div class="gis-popup-coords">${escapeHtml(coords)}</div>
            ${demoHtml}
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
    const isCriticalBattery = Boolean(state.isCriticalBattery);
    const isFailed = Boolean(!isCriticalBattery && (state.isFailed || (isImpact && !isSaved)));
    const isEvaluating = Boolean(!isCriticalBattery && statusBadge && statusBadge.includes('Evaluating'));
    const svgHtml = createModernNodeSvg(node.type, strokeOverride);
    const shortName = escapeHtml(truncateLabel(node.name, 16));

    const ringHtml = isSaved
        ? `<span class="wf-saved-ring"></span>`
        : isCriticalBattery
        ? `<span class="wf-critical-battery-ring"></span>`
        : isFailed
        ? `<span class="wf-shockwave-ring"></span>`
        : isEvaluating
        ? `<span class="wf-evaluating-ring"></span>`
        : '';

    const statusHtml = statusBadge
        ? `<span class="wf-node-status" style="color:${statusColor};">${escapeHtml(statusBadge)}</span>`
        : '';

    const markerStateClass = isCriticalBattery ? ' wf-node-critical-battery' : '';

    const html = `
        <div class="wf-node-marker${markerStateClass}">
            <div class="wf-node-badge-wrap">
                ${ringHtml}
                <div class="wf-badge-core">${svgHtml}</div>
            </div>
            <div class="wf-node-label">
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
        isCriticalBattery: false,
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

function createEdgeArrowMarker(srcNode, tgtNode, color) {
    const midLat = srcNode.lat + (tgtNode.lat - srcNode.lat) * 0.62;
    const midLon = srcNode.lon + (tgtNode.lon - srcNode.lon) * 0.62;
    const dLat = tgtNode.lat - srcNode.lat;
    const dLon = (tgtNode.lon - srcNode.lon) * Math.cos((midLat * Math.PI) / 180);
    const angleDeg = (Math.atan2(dLon, dLat) * 180) / Math.PI;

    const arrowSvg = `
        <div class="wf-edge-arrow-wrap" style="transform: translate(-50%, -50%) rotate(${angleDeg.toFixed(1)}deg); width:14px; height:14px; display:flex; align-items:center; justify-content:center;">
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

    const isHeal = Boolean(edge.isDynamic);
    const edgeColor = getEdgeFlowColor(edge, srcNode);

    const polyline = L.polyline(latLngs, {
        color: edgeColor,
        weight: isHeal ? 3.2 : (edge.weight || 2.3),
        opacity: edge.customColor ? 0.92 : 0.78,
        dashArray: edge.dashArray || null,
        className: 'wf-edge-conduit'
    }).addTo(edgesLayerGroup);

    const arrow = createEdgeArrowMarker(srcNode, tgtNode, edgeColor).addTo(edgesLayerGroup);
    edgeLayersMap.set(edge.id, { polyline, arrow });
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
            isCriticalBattery: false,
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
// GLOBAL SIMULATION CLOCK (DES SYNCHRONOUS CLOCK)
// =========================================================

let currentSimulationClockHours = 0.0;

function formatSimulationClock(hoursFloat) {
    const safeHours = Math.max(0, Number(hoursFloat) || 0);
    const totalMinutes = Math.round(safeHours * 60);
    const hh = Math.floor(totalMinutes / 60);
    const mm = totalMinutes % 60;
    return `T+${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function ensureGlobalClockElement() {
    let clockEl = document.getElementById('global-sim-clock');
    if (!clockEl) {
        const sidebar = document.getElementById('control-sidebar');
        const sidebarHeader = sidebar ? sidebar.querySelector('.sidebar-header') : null;
        if (sidebar && sidebarHeader) {
            const bar = document.createElement('div');
            bar.className = 'global-sim-clock-bar';
            bar.id = 'global-sim-clock-bar';
            bar.setAttribute('role', 'timer');
            bar.setAttribute('aria-live', 'polite');
            bar.innerHTML = `
                <div class="sim-clock-label-group">
                    <span class="sim-clock-indicator" id="sim-clock-indicator"></span>
                    <span class="sim-clock-label">Global Simulation Clock</span>
                </div>
                <span class="sim-clock-value" id="global-sim-clock">T+00:00</span>
            `;
            sidebarHeader.insertAdjacentElement('afterend', bar);
            clockEl = document.getElementById('global-sim-clock');
        }
    }
    return clockEl;
}

function setGlobalSimulationClock(hoursFloat, isRunning = false) {
    currentSimulationClockHours = Math.max(0, Number(hoursFloat) || 0);
    const formatted = formatSimulationClock(currentSimulationClockHours);
    const clockEl = ensureGlobalClockElement();
    if (clockEl) {
        clockEl.textContent = formatted;
    }
    const clockBar = document.getElementById('global-sim-clock-bar');
    if (clockBar) {
        clockBar.classList.toggle('clock-running', Boolean(isRunning));
    }
    const statClock = document.getElementById('stat-clock');
    if (statClock) {
        statClock.textContent = formatted;
    }
}

async function tickGlobalSimulationClockTo(targetHours, isRunning = true) {
    const target = Math.max(0, Number(targetHours) || 0);
    const start = currentSimulationClockHours;
    const delta = target - start;
    if (delta <= 0.01) {
        setGlobalSimulationClock(target, isRunning);
        return;
    }
    const frames = Math.min(8, Math.max(3, Math.ceil(delta * 3)));
    for (let f = 1; f <= frames; f++) {
        const interp = start + (delta * f) / frames;
        setGlobalSimulationClock(interp, isRunning);
        await new Promise(resolve => setTimeout(resolve, 35));
    }
    setGlobalSimulationClock(target, isRunning);
}

// =========================================================
// INCIDENT TIMELINE / LIVE FEED NOTIFICATION CARDS
// =========================================================

const FEED_SVGS = {
    system: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
    impact: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
    warning: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="16" height="10" rx="2" ry="2"/><line x1="22" y1="11" x2="22" y2="13"/><line x1="6" y1="11" x2="6" y2="13"/><line x1="10" y1="11" x2="10" y2="13"/></svg>`,
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
    pdfSummary = '',
    simTimeText = '',
    sviScore = null,
    populationServed = null
}) {
    const consoleLog = document.getElementById('console-log');
    if (!consoleLog) return;

    const timestamp = simTimeText || new Date().toLocaleTimeString('en-US', { hour12: false });
    const sviMeta = getSviBadgeMeta(sviScore);
    const popVal = populationServed !== null && populationServed !== undefined ? Number(populationServed) : 0;

    const card = document.createElement('div');
    card.className = `feed-card feed-card-${variant} log-line`;
    const sviPdfTag = sviMeta ? ` [${sviMeta.badgeText}${popVal > 0 ? ` | Pop: ${popVal.toLocaleString()}` : ''}]` : '';
    card.dataset.pdfSummary = pdfSummary || `[${timestamp}] ${title}${pillText ? ` [${pillText}]` : ''}${sviPdfTag}: ${description}`;

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

    if (sviMeta) {
        const sviSpan = document.createElement('span');
        sviSpan.className = `feed-svi-pill ${sviMeta.pillClass}`;
        sviSpan.textContent = sviMeta.badgeText;
        sviSpan.title = popVal > 0
            ? `Social Vulnerability Index: ${sviMeta.sviFormatted} (${sviMeta.riskLabel}) • Population Served: ${popVal.toLocaleString()} residents`
            : `Social Vulnerability Index: ${sviMeta.sviFormatted} (${sviMeta.riskLabel})`;
        titleGroup.appendChild(sviSpan);

        if (popVal > 0) {
            const popSpan = document.createElement('span');
            popSpan.className = 'feed-pop-pill';
            popSpan.textContent = `Pop: ${popVal.toLocaleString()}`;
            popSpan.title = `Estimated residents served: ${popVal.toLocaleString()}`;
            titleGroup.appendChild(popSpan);
        }
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

function appendSystemCard(title, description, simTimeText = '') {
    appendFeedCard({
        variant: 'system',
        iconSvg: FEED_SVGS.system,
        iconClass: 'system-icon',
        title,
        description,
        simTimeText
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

function updateTelemetry({ state, evaluated, total, failed, survived, budget, crews, clockHours }) {
    const statState = document.getElementById('stat-state');
    const statEvaluated = document.getElementById('stat-evaluated');
    const statFailed = document.getElementById('stat-failed');
    const statSurvived = document.getElementById('stat-survived');
    const statBudget = document.getElementById('stat-budget');
    const statCrews = document.getElementById('stat-crews');

    if (state !== undefined) currentTelemetryState.state = state;
    if (evaluated !== undefined) currentTelemetryState.evaluated = evaluated;
    if (total !== undefined) currentTelemetryState.total = total;
    if (failed !== undefined) currentTelemetryState.failed = failed;
    if (survived !== undefined) currentTelemetryState.survived = survived;

    if (clockHours !== undefined && clockHours !== null) {
        setGlobalSimulationClock(clockHours, state === 'RUNNING');
    }

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
    if (statBudget && budget !== undefined && budget !== null) {
        statBudget.textContent = `$${Math.max(0, Math.round(Number(budget))).toLocaleString()}`;
    }
    if (statCrews && crews !== undefined && crews !== null) {
        statCrews.textContent = String(Math.max(0, Math.round(Number(crews))));
    }

    updateVolumetricLighting();
}

let lastSimulationTrace = [];

function resetGraphState() {
    savedNodeIds.clear();
    impactNodeId = null;
    lastSimulationTrace = [];
    setGlobalSimulationClock(0.0, false);

    const exportPdfBtn = document.getElementById('export-pdf-btn');
    if (exportPdfBtn) {
        exportPdfBtn.disabled = true;
    }

    const budgetInput = document.getElementById('emergency-budget');
    const crewsInput = document.getElementById('active-repair-crews');
    const initBudget = budgetInput ? Number(budgetInput.value || 5000000) : 5000000;
    const initCrews = crewsInput ? Number(crewsInput.value || 3) : 3;

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
            isCriticalBattery: false,
            glitchBurst: false
        });
    });

    refreshAllMapVisuals();

    updateTelemetry({
        state: 'READY',
        evaluated: 0,
        total: topologyNodes.length,
        failed: 0,
        survived: 0,
        budget: initBudget,
        crews: initCrews,
        clockHours: 0.0
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
        ensureGlobalClockElement();
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
            const sviScore = Number(node.svi_score ?? node.social_vulnerability_index ?? 0.5);
            const populationServed = Number(node.population_served ?? 12000);

            return {
                id: nodeId,
                name: nodeName,
                type: nodeType,
                rawX,
                rawY,
                lat: geo.lat,
                lon: geo.lon,
                sviScore,
                populationServed
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
                strokeOverride: null,
                isFailed: false,
                isCriticalBattery: false
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
            survived: 0,
            clockHours: 0.0
        });

        appendSystemCard(
            'Miami Infrastructure Grid Loaded',
            `Connected ${topologyNodes.length} critical facilities across ${rawEdges.length} street-routed dependency links.`,
            'T+00:00'
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

function setSimulationLoadingBanner(visible, text = 'Simulation in Progress...') {
    const loadingSpinner = document.getElementById('loading-spinner');
    if (!loadingSpinner) return;

    const textSpans = loadingSpinner.querySelectorAll('span:not(.spinner-ring)');
    if (textSpans.length > 0) {
        textSpans[0].textContent = text;
    }

    if (visible) {
        loadingSpinner.classList.remove('hidden');
    } else {
        loadingSpinner.classList.add('hidden');
    }
}

async function pollSimulationTask(taskId, pollIntervalMs = 2000, maxAttempts = 150) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

        const elapsedSec = Math.round((attempt * pollIntervalMs) / 1000);
        setSimulationLoadingBanner(
            true,
            `Simulation in Progress (Task ${String(taskId).slice(0, 8)}… • ${elapsedSec}s elapsed)`
        );

        const pollResp = await fetch(`/api/v1/simulate/${encodeURIComponent(taskId)}`);
        if (!pollResp.ok) {
            const errData = await pollResp.json().catch(() => ({}));
            throw new Error(
                errData.detail || errData.error || `Simulation polling failed (HTTP ${pollResp.status})`
            );
        }

        const statusData = await pollResp.json();
        if (Array.isArray(statusData)) {
            return statusData;
        }

        const status = String(statusData.status || '').toLowerCase();
        const state = String(statusData.state || '').toUpperCase();

        if (status === 'completed' || state === 'SUCCESS') {
            const trace = statusData.result || statusData.execution_trace;
            if (Array.isArray(trace)) {
                return trace;
            }
            return [];
        }

        if (status === 'failed' || state === 'FAILURE') {
            throw new Error(statusData.error || statusData.detail || 'Background simulation task failed.');
        }
    }

    throw new Error('Simulation timed out waiting for background Celery worker.');
}

async function runSimulation() {
    if (isSimulating) return;

    // Failsafe check against live Topological Integrity Validator before dispatching simulation
    const issues = await validateCommandTopology({ silent: true });
    const criticalIssues = issues.filter((i) => i.level === 'critical');
    if (criticalIssues.length > 0 || isTopologyCriticalLocked) {
        openCommandDiagnosticModal(issues);
        appendFeedCard({
            variant: 'fail',
            iconSvg: FEED_SVGS.fail,
            iconClass: 'fail-icon',
            title: 'Simulation Blocked — Critical Topology Error',
            pillText: `${criticalIssues.length} Critical`,
            pillClass: 'pill-fail',
            description: `Failsafe engaged: ${criticalIssues[0]?.message || 'Circular dependencies or lifeline orphans detected.'} Resolve critical errors in the Admin Console before starting a simulation.`
        });
        return;
    }

    const disasterSelect = document.getElementById('disaster-type');
    const magnitudeInput = document.getElementById('disaster-magnitude');
    const trajectoryInput = document.getElementById('disaster-trajectory');
    const budgetInput = document.getElementById('emergency-budget');
    const crewsInput = document.getElementById('active-repair-crews');
    const runBtn = document.getElementById('run-btn');
    const resetBtn = document.getElementById('reset-btn');
    const consoleLog = document.getElementById('console-log');
    const sidebar = document.getElementById('control-sidebar');
    const sidebarToggleBtn = document.getElementById('sidebar-toggle-btn');

    const disasterType = disasterSelect ? disasterSelect.value : 'Hurricane';
    const magnitude = (magnitudeInput && magnitudeInput.value.trim()) ? magnitudeInput.value.trim() : 'Category 5';
    const trajectory = (trajectoryInput && trajectoryInput.value.trim())
        ? trajectoryInput.value.trim()
        : 'Coming from the Atlantic East coast';
    const emergencyBudget = budgetInput ? Math.max(0, Number(budgetInput.value || 5000000)) : 5000000;
    const activeRepairCrews = crewsInput ? Math.max(0, parseInt(crewsInput.value || '3', 10)) : 3;

    if (window.innerWidth <= 768 && sidebar && !sidebar.classList.contains('collapsed')) {
        sidebar.classList.add('collapsed');
        if (sidebarToggleBtn) sidebarToggleBtn.textContent = 'Controls';
    }

    isSimulating = true;
    if (runBtn) runBtn.disabled = true;
    if (resetBtn) resetBtn.disabled = true;
    setSimulationLoadingBanner(true, 'Simulation in Progress — Dispatching task...');

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
        survived: 0,
        budget: emergencyBudget,
        crews: activeRepairCrews,
        clockHours: 0.0
    });

    appendSystemCard(
        `DES Simulation Initiated — ${disasterType}`,
        `Evaluating "${trajectory}" at intensity ${magnitude} with Knapsack Budget $${emergencyBudget.toLocaleString()} and ${activeRepairCrews} Repair Crew(s). Global Clock initialized at T+00:00.`,
        'T+00:00'
    );

    try {
        const response = await fetch('/api/v1/simulate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                disaster_type: disasterType,
                magnitude: magnitude,
                disaster_direction: trajectory,
                trajectory: trajectory,
                emergency_budget: emergencyBudget,
                active_repair_crews: activeRepairCrews
            })
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.detail || errData.error || `Simulation failed (HTTP ${response.status})`);
        }

        const dispatchPayload = await response.json();
        let executionTrace = [];

        if (Array.isArray(dispatchPayload)) {
            executionTrace = dispatchPayload;
        } else if (dispatchPayload && dispatchPayload.task_id) {
            const taskId = String(dispatchPayload.task_id);
            setSimulationLoadingBanner(
                true,
                `Simulation in Progress (Task ${taskId.slice(0, 8)}…)`
            );
            appendSystemCard(
                'Simulation in Progress — Async Worker Queued',
                `Task ID ${taskId} dispatched to Celery/Redis queue (status: ${dispatchPayload.status || 'processing'}). Polling /api/v1/simulate/${taskId.slice(0, 8)}… every 2s.`,
                'T+00:00'
            );
            executionTrace = await pollSimulationTask(taskId, 2000);
        } else if (dispatchPayload && Array.isArray(dispatchPayload.result)) {
            executionTrace = dispatchPayload.result;
        }

        setSimulationLoadingBanner(false);
        await animateExecutionTrace(executionTrace);
    } catch (error) {
        setSimulationLoadingBanner(false);
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
        if (runBtn) runBtn.disabled = Boolean(isTopologyCriticalLocked);
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
            isCriticalBattery: false,
            glitchBurst: true
        });
        await new Promise(resolve => setTimeout(resolve, 140));
    }

    setNodeVisualState(nodeId, {
        statusText: 'Epicenter Impact (OFFLINE at T+00:00)',
        statusBadge: '• OFFLINE (T+00:00)',
        statusColor: '#ef4444',
        strokeOverride: '#ef4444',
        isFailed: true,
        isCriticalBattery: false,
        glitchBurst: true
    });
}

async function animateExecutionTrace(trace) {
    lastSimulationTrace = Array.isArray(trace) ? trace : [];
    const impactedNodesSet = new Set();
    const offlineNodesSet = new Set();
    const criticalBatteryNodesSet = new Set();

    setGlobalSimulationClock(0.0, true);

    for (let i = 0; i < trace.length; i++) {
        const step = trace[i];
        const stepNum = i + 1;
        const nodeName = step.node || step.child_node || step.node_name;
        const matchingNode = topologyNodes.find(n => n.name === nodeName || n.id === nodeName);
        const nodeId = matchingNode ? matchingNode.id : nodeName;
        const nodeType = matchingNode ? matchingNode.type : (step.node_type || 'energy');
        const shortName = truncateLabel(nodeName, 16);

        const stepSvi = step.svi_score !== undefined && step.svi_score !== null
            ? Number(step.svi_score)
            : (step.social_vulnerability_index !== undefined && step.social_vulnerability_index !== null
                ? Number(step.social_vulnerability_index)
                : (matchingNode ? matchingNode.sviScore : null));
        const stepPop = step.population_served !== undefined && step.population_served !== null
            ? Number(step.population_served)
            : (matchingNode ? matchingNode.populationServed : null);

        if (matchingNode) {
            if (stepSvi !== null && Number.isFinite(stepSvi)) matchingNode.sviScore = stepSvi;
            if (stepPop !== null && Number.isFinite(stepPop)) matchingNode.populationServed = stepPop;
        }

        const eventTime = Number(step.event_time ?? 0.0);
        const clockStr = formatSimulationClock(eventTime);
        const evType = String(step.event_type || '').toUpperCase();
        const nodeState = String(step.node_state || '').toUpperCase();

        // Advance the Global Simulation Clock synchronously with this DES event
        await tickGlobalSimulationClockTo(eventTime, true);

        // 1. EPICENTER IMPACT (T+00:00 -> OFFLINE)
        if (step.step === 'impact' || evType === 'EPICENTER_IMPACT') {
            impactedNodesSet.add(nodeId);
            offlineNodesSet.add(nodeId);

            appendFeedCard({
                variant: 'impact',
                iconSvg: FEED_SVGS.impact,
                iconClass: 'impact-icon',
                title: nodeName,
                pillText: `EPICENTER • OFFLINE (${clockStr})`,
                pillClass: 'pill-impact',
                description: step.reasoning,
                simTimeText: clockStr,
                sviScore: stepSvi,
                populationServed: stepPop,
                pdfSummary: `[${clockStr}] [STEP ${stepNum}/${trace.length}] [EPICENTER IMPACT — OFFLINE] ${nodeName}: ${step.reasoning}`
            });

            await flashImpactNode(nodeId, nodeType, shortName, matchingNode);

            updateTelemetry({
                state: 'RUNNING',
                evaluated: stepNum,
                total: trace.length,
                failed: impactedNodesSet.size,
                survived: savedNodeIds.size,
                budget: step.remaining_budget,
                crews: step.remaining_crews
            });

            await new Promise(resolve => setTimeout(resolve, 480));
            continue;
        }

        // 2. CRITICAL_BATTERY EVENT (Node lost upstream lifeline at T -> races against battery_deadline)
        if (step.step === 'critical_battery' || evType === 'CRITICAL_BATTERY' || nodeState === 'CRITICAL_BATTERY') {
            impactedNodesSet.add(nodeId);
            criticalBatteryNodesSet.add(nodeId);

            const deadlineHours = step.battery_deadline !== undefined && step.battery_deadline !== null
                ? Number(step.battery_deadline)
                : eventTime + Number(step.battery_backup_hours ?? 2.5);
            const deadlineStr = formatSimulationClock(deadlineHours);
            const backupHrs = Number(step.battery_backup_hours ?? Math.max(0.5, deadlineHours - eventTime)).toFixed(1);

            // Highlight severed upstream edge in urgent amber while on backup battery
            topologyEdges.forEach(edge => {
                const matches = step.parent_node
                    ? (edge.from === step.parent_node && edge.to === nodeId) ||
                      (edge.from === nodeId && edge.to === step.parent_node)
                    : edge.to === nodeId && offlineNodesSet.has(edge.from);
                if (matches) {
                    edge.color = '#f59e0b';
                    edge.customColor = true;
                    edge.weight = 3.0;
                    renderSingleEdgeOnMap(edge);
                }
            });

            if (matchingNode) {
                setNodeVisualState(nodeId, {
                    statusText: `CRITICAL_BATTERY (${backupHrs}h backup • Dies ${deadlineStr})`,
                    statusBadge: `• CRITICAL BATTERY (${deadlineStr})`,
                    statusColor: '#f59e0b',
                    strokeOverride: '#f59e0b',
                    isFailed: false,
                    isCriticalBattery: true,
                    glitchBurst: false
                });

                if (leafletMap) {
                    leafletMap.panTo([matchingNode.lat, matchingNode.lon], {
                        animate: true,
                        duration: 0.32
                    });
                }
            }

            updateTelemetry({
                state: 'RUNNING',
                evaluated: stepNum,
                total: trace.length,
                failed: impactedNodesSet.size,
                survived: savedNodeIds.size,
                budget: step.remaining_budget,
                crews: step.remaining_crews
            });

            const critRemStr = (step.remaining_budget !== undefined && step.remaining_crews !== undefined)
                ? ` [Remaining Budget: $${Math.round(Number(step.remaining_budget)).toLocaleString()} | Crews Left: ${step.remaining_crews}]`
                : '';
            const critDesc = `[${clockStr}] Upstream lifeline from ${step.parent_node || 'Epicenter'} severed. Entered CRITICAL_BATTERY (${backupHrs}h UPS reserve; deadline ${deadlineStr}). ${step.reasoning || ''}${critRemStr}`.trim();

            appendFeedCard({
                variant: 'warning',
                iconSvg: FEED_SVGS.warning,
                iconClass: 'warning-icon',
                title: `${nodeName} — Critical Battery`,
                pillText: `CRITICAL_BATTERY • Dies ${deadlineStr}`,
                pillClass: 'pill-warning',
                description: critDesc,
                simTimeText: clockStr,
                sviScore: stepSvi,
                populationServed: stepPop,
                pdfSummary: `[${clockStr}] [STEP ${stepNum}/${trace.length}] [CRITICAL_BATTERY] ${nodeName}: ${critDesc}`
            });

            await new Promise(resolve => setTimeout(resolve, 480));
            continue;
        }

        // 3. RECOVERY_COMPLETED EVENT (Field crew finishes before battery_deadline -> ONLINE & Crew released)
        const hasRecoveryEdge = Boolean(step.new_edge && step.new_edge.source && step.new_edge.target);
        if (step.step === 'recovery_completed' || evType === 'RECOVERY_COMPLETED' || (step.status && hasRecoveryEdge)) {
            criticalBatteryNodesSet.delete(nodeId);
            impactedNodesSet.add(nodeId);
            savedNodeIds.add(nodeId);

            if (matchingNode && leafletMap) {
                leafletMap.panTo([matchingNode.lat, matchingNode.lon], {
                    animate: true,
                    duration: 0.32
                });
            }

            const estCost = step.new_edge ? (step.new_edge.cost ?? step.new_edge.estimated_cost ?? step.estimated_cost) : step.estimated_cost;
            const crewsUsed = step.new_edge ? (step.new_edge.crews_used ?? 1) : 1;
            const recTimeMin = step.new_edge ? (step.new_edge.recovery_time_ms ?? step.recovery_time_ms) : step.recovery_time_ms;
            const recTimeDisplay = (step.new_edge && step.new_edge.recovery_time_display) || (
                recTimeMin !== undefined && recTimeMin !== null
                    ? (Number(recTimeMin) >= 60
                        ? `${Math.floor(Number(recTimeMin) / 60)}h${Number(recTimeMin) % 60 > 0 ? ` ${Number(recTimeMin) % 60}m` : ''}`
                        : `${Number(recTimeMin)} min`)
                    : '1h 30m'
            );

            if (hasRecoveryEdge) {
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
                        isDynamic: true,
                        estimatedCost: estCost,
                        crewsUsed: crewsUsed,
                        recoveryTimeDisplay: recTimeDisplay,
                        targetSector: nodeType,
                        restoredAtClock: clockStr
                    };
                    topologyEdges.push(newHealEdge);
                    renderSingleEdgeOnMap(newHealEdge);
                }
            }

            if (matchingNode) {
                const srcName = hasRecoveryEdge ? step.new_edge.source : 'Backup Feed';
                setNodeVisualState(nodeId, {
                    statusText: `ONLINE — AI Restored via ${srcName} at ${clockStr}`,
                    statusBadge: `• AI Restored (${clockStr})`,
                    statusColor: '#38bdf8',
                    strokeOverride: '#38bdf8',
                    isFailed: false,
                    isCriticalBattery: false,
                    glitchBurst: false
                });
            }

            updateTelemetry({
                state: 'RUNNING',
                evaluated: stepNum,
                total: trace.length,
                failed: impactedNodesSet.size,
                survived: savedNodeIds.size,
                budget: step.remaining_budget,
                crews: step.remaining_crews
            });

            const crewReleaseText = (step.remaining_budget !== undefined && step.remaining_crews !== undefined)
                ? `Crew released. Remaining Budget: $${Math.round(Number(step.remaining_budget)).toLocaleString()} | Crews Left: ${step.remaining_crews}`
                : '';
            const rawReasoning = String(step.reasoning || '').trim();
            const reasoningWithRelease = (crewReleaseText && !rawReasoning.includes('Crew released.'))
                ? `${rawReasoning} ${crewReleaseText}`.trim()
                : rawReasoning;
            const metricsSuffix = (estCost !== undefined && estCost !== null)
                ? ` (Cost: $${Number(estCost).toLocaleString()} • Crews Used: ${crewsUsed} • Field Time: ${recTimeDisplay})`
                : '';
            const routeText = hasRecoveryEdge ? `${step.new_edge.source} → ${step.new_edge.target}` : nodeName;
            const rerouteSummary = `[${clockStr}] RECOVERY_COMPLETED before battery deadline: Rerouted ${routeText}.${metricsSuffix} ${reasoningWithRelease}`.trim();

            appendFeedCard({
                variant: 'recovery',
                iconSvg: FEED_SVGS.shield,
                iconClass: 'recovery-icon',
                title: `${nodeName} — Recovery Completed`,
                pillText: `ONLINE • ${routeText}`,
                pillClass: 'pill-recovery',
                description: rerouteSummary,
                simTimeText: clockStr,
                sviScore: stepSvi,
                populationServed: stepPop,
                pdfSummary: `[${clockStr}] [STEP ${stepNum}/${trace.length}] [RECOVERY_COMPLETED] ${rerouteSummary}`
            });

            await new Promise(resolve => setTimeout(resolve, 520));
            continue;
        }

        // 4. BATTERY_DEPLETED EVENT (Backup battery expired before recovery -> OFFLINE & cascades downstream)
        criticalBatteryNodesSet.delete(nodeId);
        impactedNodesSet.add(nodeId);
        offlineNodesSet.add(nodeId);

        topologyEdges.forEach(edge => {
            const matches = step.parent_node
                ? (edge.from === step.parent_node && edge.to === nodeId) ||
                  (edge.from === nodeId && edge.to === step.parent_node)
                : edge.to === nodeId && offlineNodesSet.has(edge.from);

            if (matches) {
                edge.color = '#ef4444';
                edge.customColor = true;
                edge.weight = 3.0;
                renderSingleEdgeOnMap(edge);
            }
        });

        if (matchingNode) {
            if (leafletMap) {
                leafletMap.panTo([matchingNode.lat, matchingNode.lon], {
                    animate: true,
                    duration: 0.32
                });
            }
            setNodeVisualState(nodeId, {
                statusText: `OFFLINE — Battery Depleted at ${clockStr}`,
                statusBadge: `• OFFLINE (${clockStr})`,
                statusColor: '#ef4444',
                strokeOverride: '#ef4444',
                isFailed: true,
                isCriticalBattery: false,
                glitchBurst: true
            });
        }

        updateTelemetry({
            state: 'RUNNING',
            evaluated: stepNum,
            total: trace.length,
            failed: impactedNodesSet.size,
            survived: savedNodeIds.size,
            budget: step.remaining_budget,
            crews: step.remaining_crews
        });

        const remStateStr = (step.remaining_budget !== undefined && step.remaining_crews !== undefined)
            ? ` [Remaining Budget: $${Math.round(Number(step.remaining_budget)).toLocaleString()} | Crews Left: ${step.remaining_crews}]`
            : '';
        const failureDesc = `[${clockStr}] BATTERY_DEPLETED — Transitioned to OFFLINE and cascading failure downstream. ${step.reasoning || ''} (Severed upstream: ${step.parent_node || 'Epicenter'})${remStateStr}`.trim();

        appendFeedCard({
            variant: 'fail',
            iconSvg: FEED_SVGS.fail,
            iconClass: 'fail-icon',
            title: `${nodeName} — Battery Depleted`,
            pillText: `OFFLINE (${clockStr})`,
            pillClass: 'pill-fail',
            description: failureDesc,
            simTimeText: clockStr,
            sviScore: stepSvi,
            populationServed: stepPop,
            pdfSummary: `[${clockStr}] [STEP ${stepNum}/${trace.length}] [BATTERY_DEPLETED — OFFLINE] ${nodeName}: ${failureDesc}`
        });

        await new Promise(resolve => setTimeout(resolve, 480));
    }

    const lastStep = trace.length > 0 ? trace[trace.length - 1] : {};
    const finalClockHours = Number(lastStep.event_time ?? currentSimulationClockHours);
    const finalClockStr = formatSimulationClock(finalClockHours);
    setGlobalSimulationClock(finalClockHours, false);

    updateTelemetry({
        state: 'COMPLETE',
        evaluated: trace.length,
        total: trace.length,
        failed: impactedNodesSet.size,
        survived: savedNodeIds.size,
        budget: lastStep.remaining_budget,
        crews: lastStep.remaining_crews
    });

    const finalBudgetStr = lastStep.remaining_budget !== undefined
        ? `$${Math.round(Number(lastStep.remaining_budget)).toLocaleString()}`
        : 'N/A';
    const finalCrewsStr = lastStep.remaining_crews !== undefined
        ? `${lastStep.remaining_crews}`
        : 'N/A';

    appendSystemCard(
        `DES Cascade Complete at ${finalClockStr}`,
        `${impactedNodesSet.size} facilities impacted across ${trace.length} discrete events: ${savedNodeIds.size} restored before battery depletion, ${offlineNodesSet.size} collapsed to OFFLINE. Final Clock: ${finalClockStr} • Remaining Budget: ${finalBudgetStr} • Remaining Crews: ${finalCrewsStr}.`,
        finalClockStr
    );

    fitAllNodesBounds(true);

    const exportPdfBtn = document.getElementById('export-pdf-btn');
    if (exportPdfBtn) {
        exportPdfBtn.disabled = false;
    }
}

/**
 * Renders a high-resolution vector canvas snapshot of the Miami city topology,
 * prominently highlighting the NEW AI-RESTORED CONNECTIONS, severed cascade links,
 * and failed/restored nodes for the PDF Incident Report.
 */
function renderTopologySnapshotCanvas(targetWidth = 1400, targetHeight = 680) {
    const snapshotCanvas = document.createElement('canvas');
    snapshotCanvas.width = targetWidth;
    snapshotCanvas.height = targetHeight;
    const ctx = snapshotCanvas.getContext('2d');

    // Deep slate GIS background
    ctx.fillStyle = '#090d14';
    ctx.fillRect(0, 0, targetWidth, targetHeight);

    // Subtle GIS grid lines
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.08)';
    ctx.lineWidth = 1;
    for (let x = 60; x < targetWidth; x += 60) {
        ctx.beginPath();
        ctx.moveTo(x, 46);
        ctx.lineTo(x, targetHeight - 40);
        ctx.stroke();
    }
    for (let y = 60; y < targetHeight - 40; y += 60) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(targetWidth, y);
        ctx.stroke();
    }

    // Top Map Banner
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, targetWidth, 44);
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.35)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, 44);
    ctx.lineTo(targetWidth, 44);
    ctx.stroke();

    const restoredEdgesCount = topologyEdges.filter(e => e.isDynamic).length;
    ctx.font = '700 14px Inter, sans-serif';
    ctx.fillStyle = '#f8fafc';
    ctx.textAlign = 'left';
    ctx.fillText('MIAMI INFRASTRUCTURE GRID — NEW AI-RESTORED CONNECTIONS & CASCADE MAP', 20, 27);

    ctx.font = '700 12px Inter, sans-serif';
    ctx.fillStyle = '#38bdf8';
    ctx.textAlign = 'right';
    ctx.fillText(
        `${restoredEdgesCount} New Restored Connection${restoredEdgesCount === 1 ? '' : 's'} • ${savedNodeIds.size} Restored Nodes • ${topologyNodes.length} Total Nodes`,
        targetWidth - 20,
        27
    );

    if (topologyNodes.length === 0) return snapshotCanvas;

    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    topologyNodes.forEach(n => {
        if (n.lat < minLat) minLat = n.lat;
        if (n.lat > maxLat) maxLat = n.lat;
        if (n.lon < minLon) minLon = n.lon;
        if (n.lon > maxLon) maxLon = n.lon;
    });

    const padX = 110;
    const padTop = 82;
    const padBottom = 82;
    const latSpan = Math.max(0.01, maxLat - minLat);
    const lonSpan = Math.max(0.01, maxLon - minLon);

    const project = (node) => ({
        x: padX + ((node.lon - minLon) / lonSpan) * (targetWidth - padX * 2),
        y: padTop + ((maxLat - node.lat) / latSpan) * (targetHeight - padTop - padBottom)
    });

    function drawDirectedEdge(p1, p2, color, width, dashed = false, glow = false, calloutText = '') {
        ctx.save();
        if (glow) {
            ctx.beginPath();
            ctx.strokeStyle = 'rgba(56, 189, 248, 0.28)';
            ctx.lineWidth = width + 5;
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.stroke();
        }

        ctx.beginPath();
        if (dashed) {
            ctx.setLineDash([10, 6]);
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
        ctx.setLineDash([]);

        // Directional arrowhead at 62% along the edge
        const mx = p1.x + (p2.x - p1.x) * 0.62;
        const my = p1.y + (p2.y - p1.y) * 0.62;
        const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
        const arrowLen = dashed ? 10 : 7;

        ctx.beginPath();
        ctx.moveTo(mx + Math.cos(angle) * arrowLen, my + Math.sin(angle) * arrowLen);
        ctx.lineTo(mx + Math.cos(angle - 2.5) * arrowLen * 0.75, my + Math.sin(angle - 2.5) * arrowLen * 0.75);
        ctx.lineTo(mx + Math.cos(angle + 2.5) * arrowLen * 0.75, my + Math.sin(angle + 2.5) * arrowLen * 0.75);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();

        if (calloutText) {
            const cx = p1.x + (p2.x - p1.x) * 0.5;
            const cy = p1.y + (p2.y - p1.y) * 0.5;
            ctx.font = '700 9.5px Inter, sans-serif';
            const textW = ctx.measureText(calloutText).width + 10;
            ctx.fillStyle = 'rgba(8, 47, 73, 0.94)';
            ctx.strokeStyle = '#38bdf8';
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.roundRect(cx - textW / 2, cy - 9, textW, 18, 4);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = '#e0f2fe';
            ctx.textAlign = 'center';
            ctx.fillText(calloutText, cx, cy + 3.5);
        }
        ctx.restore();
    }

    const baseEdges = topologyEdges.filter(e => !e.isDynamic && !e.customColor);
    const cascadeEdges = topologyEdges.filter(e => !e.isDynamic && e.customColor);
    const restoredEdges = topologyEdges.filter(e => e.isDynamic);

    // 1. Draw baseline intact edges (subtle)
    baseEdges.forEach(edge => {
        const src = topologyNodes.find(n => n.id === edge.from || n.name === edge.from);
        const tgt = topologyNodes.find(n => n.id === edge.to || n.name === edge.to);
        if (!src || !tgt) return;
        drawDirectedEdge(project(src), project(tgt), 'rgba(148, 163, 184, 0.25)', 1.5, false, false);
    });

    // 2. Draw severed / evaluated cascade edges
    cascadeEdges.forEach(edge => {
        const src = topologyNodes.find(n => n.id === edge.from || n.name === edge.from);
        const tgt = topologyNodes.find(n => n.id === edge.to || n.name === edge.to);
        if (!src || !tgt) return;
        drawDirectedEdge(project(src), project(tgt), edge.color || '#ef4444', 2.4, false, false);
    });

    // 3. Draw NEW AI-RESTORED CONNECTIONS prominently on top
    restoredEdges.forEach(edge => {
        const src = topologyNodes.find(n => n.id === edge.from || n.name === edge.from);
        const tgt = topologyNodes.find(n => n.id === edge.to || n.name === edge.to);
        if (!src || !tgt) return;
        const label = edge.recoveryTimeDisplay ? `AI RESTORED (${edge.recoveryTimeDisplay})` : 'AI RESTORED';
        drawDirectedEdge(project(src), project(tgt), '#38bdf8', 3.4, true, true, label);
    });

    // 4. Draw nodes & status rings
    topologyNodes.forEach(node => {
        const pt = project(node);
        const st = nodeStateMap.get(node.id) || {};
        const isEpicenter = impactNodeId === node.id;
        const isRestored = savedNodeIds.has(node.id);
        const isFailed = Boolean(st.isFailed || (isEpicenter && !isRestored));
        const color = isRestored
            ? '#38bdf8'
            : isFailed
            ? '#ef4444'
            : (st.strokeOverride || getSectorAccentColor(node.type));

        ctx.save();

        // Outer ring for Restored or Failed/Epicenter nodes
        if (isRestored || isFailed) {
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, 18, 0, Math.PI * 2);
            ctx.strokeStyle = isRestored ? 'rgba(56, 189, 248, 0.75)' : 'rgba(239, 68, 68, 0.8)';
            ctx.lineWidth = 2.2;
            ctx.stroke();
        }

        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 12.5, 0, Math.PI * 2);
        ctx.fillStyle = '#0f172a';
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = color;
        ctx.stroke();

        // Inner sector dot
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = getSectorAccentColor(node.type);
        ctx.fill();

        ctx.font = '600 10.5px Inter, sans-serif';
        ctx.fillStyle = '#f8fafc';
        ctx.textAlign = 'center';
        ctx.fillText(truncateLabel(node.name, 20), pt.x, pt.y + 27);
        if (st.statusBadge) {
            ctx.font = '700 9.5px Inter, sans-serif';
            ctx.fillStyle = st.statusColor || color;
            ctx.fillText(st.statusBadge, pt.x, pt.y + 39);
        }
        ctx.restore();
    });

    // Bottom Legend Bar
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, targetHeight - 38, targetWidth, 38);
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, targetHeight - 38);
    ctx.lineTo(targetWidth, targetHeight - 38);
    ctx.stroke();

    ctx.font = '600 11px Inter, sans-serif';
    ctx.textAlign = 'left';
    const legendY = targetHeight - 15;

    ctx.fillStyle = '#38bdf8';
    ctx.fillText('━━━ (Dashed Cyan) New AI-Restored Connection', 20, legendY);

    ctx.fillStyle = '#f87171';
    ctx.fillText('━━━ (Solid Red) Severed Upstream Dependency', 330, legendY);

    ctx.fillStyle = '#94a3b8';
    ctx.fillText('━━━ (Slate) Intact Grid Link', 640, legendY);

    ctx.fillStyle = '#38bdf8';
    ctx.fillText('◎ Cyan Ring: AI-Restored Facility', 855, legendY);

    ctx.fillStyle = '#f87171';
    ctx.fillText('◎ Red Ring: Epicenter / Failed Facility', 1105, legendY);

    return snapshotCanvas;
}

/**
 * Captures the restored-connections topology snapshot, populates the New Restored Connections
 * table and the Complete Failed Nodes Trace table in #pdf-template, and generates WeatherFall_Report.pdf.
 */
async function exportPDFReport() {
    const pdfTemplate = document.getElementById('pdf-template');
    const mapSnapshotImg = document.getElementById('pdf-map-snapshot');
    const traceLogPre = document.getElementById('pdf-trace-log');
    const restoredEdgesBody = document.getElementById('pdf-restored-edges-body');
    const failedNodesBody = document.getElementById('pdf-failed-nodes-body');
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
        const pdfRestoredCount = document.getElementById('pdf-restored-count');
        const pdfTotalMetrics = document.getElementById('pdf-total-recovery-metrics');

        // Compute aggregate recovery metrics from lastSimulationTrace
        let totalCostUsd = 0;
        let totalCrewsUsed = 0;
        let maxRecoveryMin = 0;
        const restoredSteps = [];
        const failedSteps = [];

        lastSimulationTrace.forEach((step, idx) => {
            const isImpact = step.step === 'impact' || step.event_type === 'EPICENTER_IMPACT';
            const isCritBattery = step.step === 'critical_battery' || step.event_type === 'CRITICAL_BATTERY';
            const hasReroute = Boolean(step.new_edge && step.new_edge.source && step.new_edge.target);
            const isFailed = isImpact || isCritBattery || step.status === false || hasReroute;
            if (isFailed) {
                failedSteps.push({ ...step, stepNumber: idx + 1 });
            }
            if (hasReroute) {
                const c = Number(step.new_edge.cost ?? step.new_edge.estimated_cost ?? step.estimated_cost ?? 0);
                const crews = Number(step.new_edge.crews_used ?? 1);
                const m = Number(step.new_edge.recovery_time_ms ?? step.recovery_time_ms ?? 0);
                if (Number.isFinite(c) && c > 0) totalCostUsd += c;
                if (Number.isFinite(crews) && crews > 0) totalCrewsUsed += crews;
                if (Number.isFinite(m) && m > maxRecoveryMin) maxRecoveryMin = m;
                restoredSteps.push({
                    stepNumber: idx + 1,
                    eventClock: formatSimulationClock(step.event_time ?? 0),
                    source: step.new_edge.source,
                    target: step.new_edge.target,
                    sector: (step.node_type || 'energy').toUpperCase(),
                    costUsd: c,
                    crewsUsed: crews,
                    recoveryMin: m,
                    recoveryDisplay: step.new_edge.recovery_time_display || (
                        m >= 60 ? `${Math.floor(m / 60)}h${m % 60 > 0 ? ` ${m % 60}m` : ''}` : `${m} min`
                    )
                });
            }
        });

        const maxRecDisplay = maxRecoveryMin > 0
            ? (maxRecoveryMin >= 60
                ? `${Math.floor(maxRecoveryMin / 60)}h${maxRecoveryMin % 60 > 0 ? ` ${maxRecoveryMin % 60}m` : ''}`
                : `${maxRecoveryMin} min`)
            : 'N/A';

        if (pdfTimestamp) pdfTimestamp.textContent = new Date().toLocaleString('en-US', { hour12: false });
        if (pdfDisasterType) pdfDisasterType.textContent = disasterSelect ? disasterSelect.value : 'Hurricane';
        if (pdfMagnitude) pdfMagnitude.textContent = magnitudeInput ? magnitudeInput.value : 'Category 5';
        if (pdfTrajectory) pdfTrajectory.textContent = trajectoryInput ? trajectoryInput.value : 'Atlantic East Coast';
        if (pdfOutcome) {
            const failedVal = statFailed ? statFailed.textContent : String(failedSteps.length);
            const unrecoveredVal = Math.max(0, Number(failedVal) - savedNodeIds.size);
            pdfOutcome.textContent = `${failedVal} Impacted (${savedNodeIds.size} Saved / ${unrecoveredVal} Offline)`;
        }
        if (pdfRestoredCount) {
            pdfRestoredCount.textContent = `${restoredSteps.length} Links (${totalCrewsUsed} Crews Assigned)`;
        }
        if (pdfTotalMetrics) {
            pdfTotalMetrics.textContent = totalCostUsd > 0
                ? `$${totalCostUsd.toLocaleString()} • Peak Est. ${maxRecDisplay}`
                : 'No Rerouting Executed';
        }

        // Populate Section 1.1: New AI-Restored City Connections Table
        if (restoredEdgesBody) {
            if (restoredSteps.length === 0) {
                restoredEdgesBody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#64748b;">No emergency AI-restored connections were created in this run.</td></tr>`;
            } else {
                restoredEdgesBody.innerHTML = restoredSteps.map((r, i) => `
                    <tr class="pdf-row-restored">
                        <td><strong>#${i + 1}</strong> (${escapeHtml(r.eventClock)})</td>
                        <td><strong>${escapeHtml(r.source)}</strong></td>
                        <td><strong>${escapeHtml(r.target)}</strong></td>
                        <td>${escapeHtml(r.sector)}</td>
                        <td><strong>$${Number(r.costUsd).toLocaleString()}</strong> (${r.crewsUsed} crew${r.crewsUsed === 1 ? '' : 's'})</td>
                        <td><strong>${escapeHtml(r.recoveryDisplay)}</strong></td>
                    </tr>
                `).join('');
            }
        }

        // Populate Section 2: Complete Trace of Failed & Impacted Nodes Table
        if (failedNodesBody) {
            if (failedSteps.length === 0) {
                failedNodesBody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#64748b;">No failed nodes recorded.</td></tr>`;
            } else {
                failedNodesBody.innerHTML = failedSteps.map(f => {
                    const nodeName = f.node || f.child_node || f.node_name || 'Unknown';
                    const sector = (f.node_type || 'energy').toUpperCase();
                    const evClock = formatSimulationClock(f.event_time ?? 0);
                    const isImpact = f.step === 'impact' || f.event_type === 'EPICENTER_IMPACT';
                    const isCritBattery = f.step === 'critical_battery' || f.event_type === 'CRITICAL_BATTERY';
                    const hasReroute = Boolean(f.new_edge && f.new_edge.source && f.new_edge.target);
                    const rowClass = isImpact ? 'pdf-row-epicenter' : (hasReroute ? 'pdf-row-restored' : '');
                    const parentLabel = isImpact ? 'Direct Disaster Impact (Epicenter)' : (f.parent_node || 'Upstream Supply');

                    const statusPill = isImpact
                        ? `<span class="pdf-status-pill pdf-pill-epicenter">EPICENTER (${escapeHtml(evClock)})</span>`
                        : isCritBattery
                        ? `<span class="pdf-status-pill pdf-pill-epicenter">CRITICAL BATTERY (${escapeHtml(evClock)})</span>`
                        : hasReroute
                        ? `<span class="pdf-status-pill pdf-pill-restored">AI RESTORED (${escapeHtml(evClock)})</span>`
                        : `<span class="pdf-status-pill pdf-pill-failed">OFFLINE (${escapeHtml(evClock)})</span>`;

                    let rerouteCell = '—';
                    if (hasReroute) {
                        const costVal = Number(f.new_edge.cost ?? f.new_edge.estimated_cost ?? f.estimated_cost ?? 0);
                        const crewsVal = Number(f.new_edge.crews_used ?? 1);
                        const minVal = Number(f.new_edge.recovery_time_ms ?? f.recovery_time_ms ?? 0);
                        const dispVal = f.new_edge.recovery_time_display || (
                            minVal >= 60 ? `${Math.floor(minVal / 60)}h${minVal % 60 > 0 ? ` ${minVal % 60}m` : ''}` : `${minVal} min`
                        );
                        rerouteCell = `<strong>${escapeHtml(f.new_edge.source)} → ${escapeHtml(f.new_edge.target)}</strong><br><span style="color:#0369a1;font-weight:600;">Cost: $${costVal.toLocaleString()} • Crews: ${crewsVal} • Time: ${escapeHtml(dispVal)}</span>`;
                    }

                    return `
                        <tr class="${rowClass}">
                            <td><strong>#${f.stepNumber}</strong><br><small>${escapeHtml(evClock)}</small></td>
                            <td><strong>${escapeHtml(nodeName)}</strong></td>
                            <td>${escapeHtml(sector)}</td>
                            <td>${escapeHtml(parentLabel)}</td>
                            <td>${statusPill}</td>
                            <td>${rerouteCell}</td>
                            <td>${escapeHtml(f.reasoning || '')}</td>
                        </tr>
                    `;
                }).join('');
            }
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

        const snapshotCanvas = renderTopologySnapshotCanvas(1400, 680);
        const canvasData = snapshotCanvas.toDataURL('image/png');
        await new Promise((resolve) => {
            mapSnapshotImg.onload = resolve;
            mapSnapshotImg.onerror = resolve;
            mapSnapshotImg.src = canvasData;
        });

        pdfTemplate.style.display = 'block';

        await html2pdf()
            .set({
                margin: 9,
                filename: 'WeatherFall_Report.pdf',
                image: { type: 'jpeg', quality: 0.98 },
                pagebreak: {
                    mode: ['css', 'legacy'],
                    avoid: [
                        '.pdf-report-header',
                        '.pdf-summary-grid',
                        '.pdf-snapshot-frame',
                        '.pdf-section-title',
                        '.pdf-subsection-title',
                        '.pdf-data-table tr',
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

        appendSystemCard('Incident Report Exported', 'Downloaded WeatherFall_Report.pdf with restored city connections map and complete failed nodes trace.');
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

    // Topological Integrity Validator & Cross-App Failsafe Lock
    const runDiagBtn = document.getElementById('run-diagnostics-btn');
    if (runDiagBtn) {
        runDiagBtn.addEventListener('click', () => {
            validateCommandTopology({ silent: false });
        });
    }

    const openDiagModalBtn = document.getElementById('open-diagnostics-modal-btn');
    if (openDiagModalBtn) {
        openDiagModalBtn.addEventListener('click', () => {
            openCommandDiagnosticModal(latestDiagnosticIssues);
        });
    }

    const rerunDiagBtn = document.getElementById('diagnostic-rerun-btn');
    if (rerunDiagBtn) {
        rerunDiagBtn.addEventListener('click', () => {
            validateCommandTopology({ silent: false });
        });
    }

    const closeDiagBtn = document.getElementById('diagnostic-modal-close');
    if (closeDiagBtn) {
        closeDiagBtn.addEventListener('click', closeCommandDiagnosticModal);
    }

    const dismissDiagBtn = document.getElementById('diagnostic-dismiss-btn');
    if (dismissDiagBtn) {
        dismissDiagBtn.addEventListener('click', closeCommandDiagnosticModal);
    }

    const diagBackdrop = document.getElementById('diagnostic-modal-backdrop');
    if (diagBackdrop) {
        diagBackdrop.addEventListener('click', (e) => {
            if (e.target === diagBackdrop) {
                closeCommandDiagnosticModal();
            }
        });
    }

    // Perform initial background validation to enforce failsafe on load
    validateCommandTopology({ silent: true });

    // Re-validate when returning to this tab or when Admin tab broadcasts a lock change
    window.addEventListener('focus', () => {
        validateCommandTopology({ silent: true });
    });
    window.addEventListener('storage', (e) => {
        if (e.key === 'weatherfall_topology_critical_lock') {
            validateCommandTopology({ silent: true });
        }
    });
});

let isTopologyCriticalLocked = false;
let latestDiagnosticIssues = [];
let commandToastTimer = null;

function showCommandTopologyToast(message = 'Topology Valid - System Go', variant = 'success') {
    const toastEl = document.getElementById('topology-toast');
    const textEl = document.getElementById('topology-toast-text');
    const iconEl = document.getElementById('topology-toast-icon');
    if (!toastEl || !textEl) return;

    textEl.textContent = message;
    if (iconEl) {
        iconEl.textContent = variant === 'error' ? '✕' : '✓';
    }
    toastEl.className = `topology-toast topology-toast-${variant}`;
    toastEl.classList.remove('hidden');

    if (commandToastTimer) {
        clearTimeout(commandToastTimer);
    }
    commandToastTimer = setTimeout(() => {
        toastEl.classList.add('hidden');
    }, 4200);
}

/**
 * Enforces the Task 3 Failsafe:
 * If any 'critical' errors exist, strictly disables the 'Start Simulation' (#run-btn)
 * button across the app to prevent the simulation loop and Celery workers from
 * encountering an infinite loop or null reference.
 */
function applyCommandFailsafeLock(issues) {
    latestDiagnosticIssues = Array.isArray(issues) ? issues : [];
    const criticalIssues = latestDiagnosticIssues.filter((i) => i.level === 'critical');
    const warningIssues = latestDiagnosticIssues.filter((i) => i.level === 'warning');
    isTopologyCriticalLocked = criticalIssues.length > 0;

    localStorage.setItem('weatherfall_topology_critical_lock', isTopologyCriticalLocked ? 'true' : 'false');

    const runBtn = document.getElementById('run-btn');
    const runBtnSpan = runBtn ? runBtn.querySelector('span') : null;
    const failsafeBanner = document.getElementById('topology-failsafe-banner');
    const failsafeCount = document.getElementById('topology-failsafe-count');
    const pillEl = document.getElementById('diagnostics-status-pill');
    const diagBtn = document.getElementById('run-diagnostics-btn');

    if (runBtn) {
        if (isTopologyCriticalLocked) {
            runBtn.disabled = true;
            runBtn.classList.add('run-button-locked');
            runBtn.title = `Start Simulation Disabled — ${criticalIssues.length} critical topological error(s) detected`;
            if (runBtnSpan) {
                runBtnSpan.textContent = 'Start Simulation Locked';
            }
        } else {
            if (!isSimulating) {
                runBtn.disabled = false;
            }
            runBtn.classList.remove('run-button-locked');
            runBtn.title = 'Start Simulation';
            if (runBtnSpan) {
                runBtnSpan.textContent = 'Start Simulation';
            }
        }
    }

    if (failsafeBanner) {
        failsafeBanner.classList.toggle('hidden', !isTopologyCriticalLocked);
        if (failsafeCount && isTopologyCriticalLocked) {
            failsafeCount.textContent = `${criticalIssues.length} Critical Error${criticalIssues.length === 1 ? '' : 's'}`;
        }
    }

    if (pillEl && diagBtn) {
        diagBtn.classList.remove('diag-btn-valid', 'diag-btn-warning', 'diag-btn-critical');
        if (criticalIssues.length > 0) {
            pillEl.textContent = `${criticalIssues.length} Critical`;
            pillEl.className = 'diagnostics-status-pill pill-critical';
            diagBtn.classList.add('diag-btn-critical');
        } else if (warningIssues.length > 0) {
            pillEl.textContent = `${warningIssues.length} Warning${warningIssues.length > 1 ? 's' : ''}`;
            pillEl.className = 'diagnostics-status-pill pill-warning';
            diagBtn.classList.add('diag-btn-warning');
        } else {
            pillEl.textContent = 'System Go';
            pillEl.className = 'diagnostics-status-pill pill-valid';
            diagBtn.classList.add('diag-btn-valid');
        }
    }
}

async function validateCommandTopology({ silent = false } = {}) {
    const diagBtn = document.getElementById('run-diagnostics-btn');
    const labelEl = document.getElementById('run-diagnostics-label');

    if (!silent && diagBtn && labelEl) {
        diagBtn.disabled = true;
        labelEl.textContent = 'Validating Graph…';
    }

    try {
        const resp = await fetch('/api/v1/topology/validate');
        if (!resp.ok) {
            throw new Error(`HTTP ${resp.status}`);
        }
        const issues = await resp.json();
        const normalized = Array.isArray(issues) ? issues : [];
        applyCommandFailsafeLock(normalized);

        if (!silent) {
            if (normalized.length === 0) {
                closeCommandDiagnosticModal();
                showCommandTopologyToast('Topology Valid - System Go', 'success');
                appendSystemCard(
                    'Topology Valid - System Go',
                    'NetworkX Topological Integrity Validator confirmed 0 circular dependencies, 0 lifeline orphans, and 0 supplier bottlenecks.'
                );
            } else {
                openCommandDiagnosticModal(normalized);
            }
        }
        return normalized;
    } catch (err) {
        if (!silent) {
            showCommandTopologyToast(`Diagnostics Error: ${err.message}`, 'error');
        }
        return latestDiagnosticIssues;
    } finally {
        if (!silent && diagBtn && labelEl) {
            diagBtn.disabled = false;
            labelEl.textContent = 'Run Network Diagnostics';
        }
    }
}

function openCommandDiagnosticModal(issues) {
    const backdrop = document.getElementById('diagnostic-modal-backdrop');
    const listEl = document.getElementById('diagnostic-issues-list');
    const critBadge = document.getElementById('diag-summary-critical');
    const warnBadge = document.getElementById('diag-summary-warning');
    const failsafeBanner = document.getElementById('diagnostic-failsafe-banner');
    const timestampEl = document.getElementById('diagnostic-timestamp');

    if (!backdrop || !listEl) return;

    const safeIssues = Array.isArray(issues) ? issues : [];
    const criticalIssues = safeIssues.filter((i) => i.level === 'critical');
    const warningIssues = safeIssues.filter((i) => i.level === 'warning');

    if (critBadge) {
        critBadge.textContent = `${criticalIssues.length} Critical`;
    }
    if (warnBadge) {
        warnBadge.textContent = `${warningIssues.length} Warning${warningIssues.length === 1 ? '' : 's'}`;
    }
    if (failsafeBanner) {
        failsafeBanner.classList.toggle('hidden', criticalIssues.length === 0);
    }
    if (timestampEl) {
        timestampEl.textContent = `Diagnostic scan completed at ${new Date().toLocaleTimeString()} · ${safeIssues.length} issue(s) detected`;
    }

    listEl.innerHTML = safeIssues
        .map((issue) => {
            const isCritical = issue.level === 'critical';
            const badgeClass = isCritical ? 'diag-badge-critical' : 'diag-badge-warning';
            const cardClass = isCritical ? 'diag-issue-card diag-card-critical' : 'diag-issue-card diag-card-warning';
            const badgeText = isCritical ? 'CRITICAL' : 'WARNING';

            const msgText = String(issue.message || '');
            let categoryLabel = isCritical ? 'Topological Error' : 'Capacity Bottleneck';
            if (msgText.toLowerCase().includes('cycle') || msgText.toLowerCase().includes('deadlock')) {
                categoryLabel = 'Cycle Deadlock';
            } else if (msgText.toLowerCase().includes('orphan')) {
                categoryLabel = 'Lifeline Orphan';
            }

            const matchingNode = topologyNodes.find(
                (n) => String(n.name) === String(issue.node_id) || String(n.id) === String(issue.node_id)
            );

            return `
                <div class="${cardClass}">
                    <div class="diag-issue-header">
                        <div class="diag-issue-badges">
                            <span class="diag-badge ${badgeClass}">${badgeText}</span>
                            <span class="diag-category-tag">${escapeHtml(categoryLabel)}</span>
                            <span class="diag-node-chip">${escapeHtml(issue.node_id)}</span>
                        </div>
                        ${
                            matchingNode
                                ? `<button type="button" class="diag-locate-btn" data-node-id="${escapeHtml(matchingNode.id)}" title="Pan map to ${escapeHtml(matchingNode.name)}">Locate on Map</button>`
                                : ''
                        }
                    </div>
                    <p class="diag-issue-message">${escapeHtml(issue.message)}</p>
                </div>
            `;
        })
        .join('');

    listEl.querySelectorAll('.diag-locate-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const nodeId = btn.dataset.nodeId;
            const node = topologyNodes.find((n) => String(n.id) === String(nodeId));
            if (node && leafletMap) {
                closeCommandDiagnosticModal();
                leafletMap.flyTo([node.lat, node.lon], 15, { duration: 0.65 });
            }
        });
    });

    backdrop.classList.remove('hidden');
}

function closeCommandDiagnosticModal() {
    const backdrop = document.getElementById('diagnostic-modal-backdrop');
    if (backdrop) {
        backdrop.classList.add('hidden');
    }
}