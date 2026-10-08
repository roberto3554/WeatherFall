// frontend/admin.js — WeatherFall Interactive GIS & Topology Admin Console

const TOKEN_KEY = 'weatherfall_token';
const USER_KEY = 'weatherfall_username';
const ADMIN_KEY = 'weatherfall_is_admin';
const THEME_STORAGE_KEY = 'weatherfall_theme';

const DARK_TILE_URL = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
const LIGHT_TILE_URL = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';

const SECTOR_COLORS = {
    energy: '#f59e0b',
    power: '#f59e0b',
    water: '#06b6d4',
    health: '#10b981',
    transport: '#f97316',
    comms: '#8b5cf6',
};

let currentTheme = localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark';
let cartoApiKey = '';
let map = null;
let baseTileLayer = null;
let edgesLayerGroup = null;
let nodesLayerGroup = null;
let osmLayerGroup = null;
let editHighlightLayer = null;
let rubberBandLine = null;

let registeredNodes = [];
let registeredEdges = [];
let osmCandidates = [];

// Edit Mode State for visual connection drawing
let isEditMode = false;
let selectedSourceNode = null;

const ESRI_DARK_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}';
const ESRI_LIGHT_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}';

function getTileUrl(theme) {
    if (cartoApiKey) {
        const base = theme === 'light' ? LIGHT_TILE_URL : DARK_TILE_URL;
        return `${base}?key=${encodeURIComponent(cartoApiKey)}`;
    }
    return theme === 'light' ? ESRI_LIGHT_URL : ESRI_DARK_URL;
}

function getSectorColor(type) {
    const key = String(type || 'energy').toLowerCase();
    return SECTOR_COLORS[key] || '#3b82f6';
}

function applyTheme(theme) {
    currentTheme = theme === 'light' ? 'light' : 'dark';
    localStorage.setItem(THEME_STORAGE_KEY, currentTheme);
    document.documentElement.setAttribute('data-theme', currentTheme);
    if (document.body) {
        document.body.setAttribute('data-theme', currentTheme);
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

    if (map && baseTileLayer) {
        baseTileLayer.setUrl(getTileUrl(currentTheme));
        renderMapTopology();
    }
}

function toggleTheme() {
    applyTheme(currentTheme === 'light' ? 'dark' : 'light');
}

applyTheme(currentTheme);

function getToken() {
    return localStorage.getItem(TOKEN_KEY);
}

function authHeaders(extra = {}) {
    const token = getToken();
    return token ? { ...extra, 'Authorization': `Bearer ${token}` } : { ...extra };
}

function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(ADMIN_KEY);
}

function redirectToLogin() {
    clearSession();
    const next = encodeURIComponent(window.location.pathname || '/admin');
    window.location.replace(`/login?next=${next}`);
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    }[ch]));
}

function showMsg(text, kind = 'info') {
    const msg = document.getElementById('node-form-msg');
    if (!msg) return;
    msg.textContent = text;
    const cls = kind === 'success' ? 'form-msg-success' : kind === 'error' ? 'form-msg-error' : 'form-msg-info';
    msg.className = `form-msg ${cls}`;
    msg.classList.remove('hidden');
}

document.addEventListener('DOMContentLoaded', async () => {
    applyTheme(currentTheme);

    const themeToggleBtn = document.getElementById('theme-toggle-btn');
    if (themeToggleBtn) {
        themeToggleBtn.addEventListener('click', toggleTheme);
    }

    const token = getToken();
    const isAdmin = localStorage.getItem(ADMIN_KEY) === 'true';

    if (!token || !isAdmin) {
        redirectToLogin();
        return;
    }

    const userEl = document.getElementById('admin-user');
    if (userEl) {
        userEl.textContent = `${localStorage.getItem(USER_KEY) || 'user'}@admin`;
    }

    const logoutBtn = document.getElementById('admin-logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            clearSession();
            window.location.replace('/login');
        });
    }

    try {
        const cfgResp = await fetch('/api/v1/config/map');
        if (cfgResp.ok) {
            const cfg = await cfgResp.json();
            if (cfg.carto_api_key) {
                cartoApiKey = cfg.carto_api_key;
            }
        }
    } catch (_) {
        // Proceed with standard CARTO tile URL if config endpoint is unavailable
    }

    initLeafletMap();
    initControls();
    await loadAllTopology();
});

let hasInitialBoundsFit = false;

/**
 * Task 1: Initialize Interactive Leaflet Map centered on Miami.
 */
function initLeafletMap() {
    const mapEl = document.getElementById('admin-map');
    if (!mapEl || typeof L === 'undefined') return;

    map = L.map('admin-map', {
        center: [25.778, -80.205],
        zoom: 12,
        zoomControl: true,
    });

    baseTileLayer = L.tileLayer(getTileUrl(currentTheme), {
        attribution: TILE_ATTRIBUTION,
        subdomains: 'abcd',
        maxZoom: 19,
    }).addTo(map);

    // Fallback to Esri dark/light tiles if CARTO tile request fails
    let fallbackTriggered = false;
    baseTileLayer.on('tileerror', () => {
        if (!fallbackTriggered) {
            fallbackTriggered = true;
            cartoApiKey = '';
            baseTileLayer.setUrl(getTileUrl(currentTheme));
        }
    });

    edgesLayerGroup = L.layerGroup().addTo(map);
    nodesLayerGroup = L.layerGroup().addTo(map);
    osmLayerGroup = L.layerGroup().addTo(map);
    editHighlightLayer = L.layerGroup().addTo(map);

    // Ensure Leaflet recalculates container dimensions after layout settles
    setTimeout(() => {
        if (map) map.invalidateSize();
    }, 100);
    setTimeout(() => {
        if (map) map.invalidateSize();
    }, 450);

    if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => {
            if (map) map.invalidateSize();
        });
        ro.observe(mapEl);
    }

    // Update rubber-band line while moving cursor in Edit Mode with a selected source node
    map.on('mousemove', (e) => {
        if (isEditMode && selectedSourceNode && rubberBandLine) {
            rubberBandLine.setLatLngs([
                [Number(selectedSourceNode.y), Number(selectedSourceNode.x)],
                [e.latlng.lat, e.latlng.lng],
            ]);
        }
    });
}

function initControls() {
    // Live OSM Search button & sector dropdown
    const searchBtn = document.getElementById('osm-search-btn');
    if (searchBtn) {
        searchBtn.addEventListener('click', searchOsmInView);
    }

    const infraSelect = document.getElementById('osm-infra-type');
    if (infraSelect) {
        infraSelect.addEventListener('change', searchOsmInView);
    }

    // Clear temporary OSM markers
    const clearBtn = document.getElementById('osm-clear-btn');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            osmCandidates = [];
            if (osmLayerGroup) osmLayerGroup.clearLayers();
            updateOsmCount(0);
            showMsg('Cleared temporary OpenStreetMap candidate markers.', 'info');
        });
    }

    // Toggle Edit Connections Mode
    const editModeBtn = document.getElementById('edit-mode-btn');
    if (editModeBtn) {
        editModeBtn.addEventListener('click', () => {
            setEditMode(!isEditMode, null);
        });
    }

    const cancelEditBtn = document.getElementById('cancel-edit-mode-btn');
    if (cancelEditBtn) {
        cancelEditBtn.addEventListener('click', () => {
            setEditMode(false, null);
        });
    }

    // Inspector Tabs (Registered Nodes vs Dependency Edges)
    document.querySelectorAll('.inspector-tab').forEach((btn) => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            document.querySelectorAll('.inspector-tab').forEach((b) => b.classList.toggle('active', b === btn));
            document.getElementById('tab-panel-nodes').classList.toggle('hidden', tab !== 'nodes');
            document.getElementById('tab-panel-edges').classList.toggle('hidden', tab !== 'edges');
        });
    });

    // Filter registered nodes input
    const filterInput = document.getElementById('nodes-filter-input');
    if (filterInput) {
        filterInput.addEventListener('input', () => {
            renderNodesTable(registeredNodes);
        });
    }

    // Quick Manual Edge Form in Edges Tab
    const addEdgeBtn = document.getElementById('manual-edge-add-btn');
    if (addEdgeBtn) {
        addEdgeBtn.addEventListener('click', async () => {
            const srcId = Number(document.getElementById('manual-edge-source').value);
            const tgtId = Number(document.getElementById('manual-edge-target').value);
            if (!srcId || !tgtId) {
                showMsg('Select both a Source and a Target facility to create a connection.', 'error');
                return;
            }
            await createManualEdge(srcId, tgtId);
        });
    }
}

/**
 * Enters or exits interactive Connection Edit Mode.
 */
function setEditMode(enabled, initialSourceNode = null) {
    isEditMode = Boolean(enabled);
    selectedSourceNode = isEditMode ? initialSourceNode : null;

    const btn = document.getElementById('edit-mode-btn');
    const label = document.getElementById('edit-mode-label');
    const banner = document.getElementById('edit-mode-banner');
    const statusText = document.getElementById('edit-mode-status-text');

    if (btn && label) {
        btn.classList.toggle('active', isEditMode);
        label.textContent = isEditMode ? 'Edit Connections: ON' : 'Edit Connections: OFF';
    }

    if (banner && statusText) {
        banner.classList.toggle('hidden', !isEditMode);
        if (isEditMode) {
            if (selectedSourceNode) {
                statusText.innerHTML = `<strong>Source Selected:</strong> <span class="banner-highlight">${escapeHtml(selectedSourceNode.name)}</span> — Now click any destination node on the map to create a directed dependency edge.`;
            } else {
                statusText.innerHTML = `<strong>Connection Edit Mode Active:</strong> Click an imported node on the map to select the upstream <strong>Source</strong> facility.`;
            }
        }
    }

    updateEditHighlightLayer();
}

function updateEditHighlightLayer() {
    if (!editHighlightLayer || !map) return;
    editHighlightLayer.clearLayers();
    rubberBandLine = null;

    if (isEditMode && selectedSourceNode) {
        const lat = Number(selectedSourceNode.y);
        const lon = Number(selectedSourceNode.x);
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
            L.circleMarker([lat, lon], {
                radius: 15,
                color: '#38bdf8',
                weight: 3,
                fillColor: '#38bdf8',
                fillOpacity: 0.18,
                dashArray: '4, 4',
                interactive: false,
            }).addTo(editHighlightLayer);

            rubberBandLine = L.polyline([[lat, lon], [lat, lon]], {
                color: '#38bdf8',
                weight: 2.5,
                dashArray: '6, 6',
                opacity: 0.85,
                interactive: false,
            }).addTo(editHighlightLayer);
        }
    }
}

function updateOsmCount(count) {
    const el = document.getElementById('osm-count');
    if (el) el.textContent = String(count);
}

/**
 * Loads both registered nodes and registered edges from the FastAPI backend
 * and renders them on the Leaflet map and in the inspector tables.
 */
async function loadAllTopology() {
    try {
        const [nodesResp, edgesResp] = await Promise.all([
            fetch('/api/v1/nodes', { headers: authHeaders() }),
            fetch('/api/v1/edges', { headers: authHeaders() }),
        ]);

        if (nodesResp.status === 401 || nodesResp.status === 403) {
            redirectToLogin();
            return;
        }
        if (!nodesResp.ok) {
            throw new Error(`Failed to load nodes (HTTP ${nodesResp.status})`);
        }

        registeredNodes = await nodesResp.json();
        registeredEdges = edgesResp.ok ? await edgesResp.json() : [];

        renderNodesTable(registeredNodes);
        renderEdgesTable(registeredEdges);
        populateManualEdgeSelects(registeredNodes);
        renderMapTopology();

        if (!hasInitialBoundsFit && map && registeredNodes.length > 0) {
            const validCoords = registeredNodes
                .map((n) => [Number(n.y), Number(n.x)])
                .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180);
            if (validCoords.length > 0) {
                hasInitialBoundsFit = true;
                map.invalidateSize();
                map.fitBounds(validCoords, { padding: [36, 36], maxZoom: 13 });
            }
        }
    } catch (err) {
        showMsg(`✕ ${err.message}`, 'error');
    }
}

/**
 * Renders all registered nodes and dependency edges onto the Leaflet map.
 */
function renderMapTopology() {
    if (!map || !nodesLayerGroup || !edgesLayerGroup) return;

    edgesLayerGroup.clearLayers();
    nodesLayerGroup.clearLayers();

    const nodeById = new Map(registeredNodes.map((n) => [n.id, n]));
    const isLight = currentTheme === 'light';

    // 1. Draw directed dependency edges
    registeredEdges.forEach((edge) => {
        const src = nodeById.get(edge.source_node_id);
        const tgt = nodeById.get(edge.target_node_id);
        if (!src || !tgt) return;

        const lat1 = Number(src.y);
        const lon1 = Number(src.x);
        const lat2 = Number(tgt.y);
        const lon2 = Number(tgt.x);
        if (!Number.isFinite(lat1) || !Number.isFinite(lon1) || !Number.isFinite(lat2) || !Number.isFinite(lon2)) {
            return;
        }

        const lineColor = isLight ? '#2563eb' : '#38bdf8';
        const polyline = L.polyline([[lat1, lon1], [lat2, lon2]], {
            color: lineColor,
            weight: 2.6,
            opacity: isLight ? 0.65 : 0.72,
        });

        const distText = edge.routing_distance ? `${Math.round(edge.routing_distance)} m` : 'Direct Link';
        polyline.bindTooltip(
            `<strong>${escapeHtml(src.name)}</strong> → <strong>${escapeHtml(tgt.name)}</strong> (${distText})`,
            { sticky: true, direction: 'top' }
        );

        const popupContainer = document.createElement('div');
        popupContainer.className = 'gis-popup';
        popupContainer.innerHTML = `
            <div class="gis-popup-title">Dependency Edge #${edge.id}</div>
            <div class="gis-popup-meta">
                <div><strong>Source:</strong> ${escapeHtml(src.name)}</div>
                <div><strong>Target:</strong> ${escapeHtml(tgt.name)}</div>
                <div><strong>Surface Distance:</strong> ${distText}</div>
            </div>
            <div class="gis-popup-actions">
                <button type="button" class="delete-btn gis-popup-btn-full">Delete Connection</button>
            </div>
        `;
        popupContainer.querySelector('button').addEventListener('click', async () => {
            map.closePopup();
            await deleteEdgeById(edge.id);
        });

        polyline.bindPopup(popupContainer);
        polyline.addTo(edgesLayerGroup);

        // Directional midpoint dot closer to target (74% along the edge) helps visualize flow direction
        const arrowLat = lat1 + (lat2 - lat1) * 0.74;
        const arrowLon = lon1 + (lon2 - lon1) * 0.74;
        L.circleMarker([arrowLat, arrowLon], {
            radius: 3.2,
            color: lineColor,
            fillColor: '#ffffff',
            fillOpacity: 1,
            weight: 1.5,
            interactive: false,
        }).addTo(edgesLayerGroup);
    });

    // 2. Draw registered WeatherFall infrastructure nodes
    registeredNodes.forEach((node) => {
        const lat = Number(node.y);
        const lon = Number(node.x);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

        const color = getSectorColor(node.type);
        const marker = L.circleMarker([lat, lon], {
            radius: 8.5,
            color: isLight ? '#0f172a' : '#ffffff',
            weight: 2,
            fillColor: color,
            fillOpacity: 0.92,
        });

        marker.bindTooltip(
            `<strong>${escapeHtml(node.name)}</strong> <span style="opacity:0.75">[${escapeHtml(node.type.toUpperCase())}]</span>`,
            { direction: 'top', offset: [0, -6] }
        );

        marker.on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            handleRegisteredNodeClick(node, marker);
        });

        marker.addTo(nodesLayerGroup);
    });

    updateEditHighlightLayer();
}

/**
 * Task 2: Handles clicking on an imported WeatherFall node on the Leaflet map.
 * - If in Edit Mode: selects source node or creates edge to target node via POST /api/v1/edges.
 * - If in Normal Mode: opens popup with node info, "Connect Edge from Here (Edit Mode)" button, and "Delete Node".
 */
async function handleRegisteredNodeClick(node, marker) {
    if (isEditMode) {
        if (!selectedSourceNode) {
            setEditMode(true, node);
            showMsg(`Selected "${node.name}" as upstream Source. Click any target node on the map to create a dependency edge.`, 'info');
            return;
        }

        if (selectedSourceNode.id === node.id) {
            showMsg('Source and Target cannot be the same facility. Click a different target node.', 'error');
            return;
        }

        const sourceId = selectedSourceNode.id;
        const targetId = node.id;
        await createManualEdge(sourceId, targetId);
        setEditMode(false, null);
        return;
    }

    // Normal mode: build interactive node popup
    const popupEl = document.createElement('div');
    popupEl.className = 'gis-popup';
    popupEl.innerHTML = `
        <div class="gis-popup-header">
            <span class="type-badge type-${escapeHtml(node.type)}">${escapeHtml(node.type)}</span>
            <span class="gis-popup-id">#${node.id}</span>
        </div>
        <div class="gis-popup-title">${escapeHtml(node.name)}</div>
        <div class="gis-popup-coords">${Number(node.y).toFixed(5)}, ${Number(node.x).toFixed(5)}</div>
        <div class="gis-popup-actions">
            <button type="button" class="run-button gis-connect-btn">
                🔗 Connect Edge from Here
            </button>
            <button type="button" class="delete-btn gis-delete-node-btn">
                Delete
            </button>
        </div>
    `;

    popupEl.querySelector('.gis-connect-btn').addEventListener('click', () => {
        map.closePopup();
        setEditMode(true, node);
        showMsg(`Edit Mode Active: "${node.name}" locked as Source. Click another node on the map to draw a dependency edge.`, 'info');
    });

    popupEl.querySelector('.gis-delete-node-btn').addEventListener('click', async () => {
        map.closePopup();
        await deleteNodeById(node.id, node.name);
    });

    marker.unbindPopup();
    marker.bindPopup(popupEl, { minWidth: 230 }).openPopup();
}

/**
 * Task 1 & 2: Queries Overpass API (via backend proxy with direct Overpass fallback)
 * for infrastructure nodes of the selected type within the current map bounding box,
 * and renders them as temporary gray markers with a one-click "Import into WeatherFall" popup.
 */
async function searchOsmInView() {
    if (!map || !osmLayerGroup) return;

    map.invalidateSize();
    const searchBtn = document.getElementById('osm-search-btn');
    const infraType = document.getElementById('osm-infra-type').value || 'energy';
    const bounds = map.getBounds();

    const south = bounds.getSouth().toFixed(5);
    const west = bounds.getWest().toFixed(5);
    const north = bounds.getNorth().toFixed(5);
    const east = bounds.getEast().toFixed(5);

    searchBtn.disabled = true;
    const originalHtml = searchBtn.innerHTML;
    searchBtn.textContent = 'Querying OSM…';
    showMsg(`Searching OpenStreetMap (${infraType.toUpperCase()}) in current map view…`, 'info');

    try {
        let candidates = [];

        // 1. Query fast backend Overpass proxy endpoint
        const proxyUrl = `/api/v1/osm/search?type=${encodeURIComponent(infraType)}&south=${south}&west=${west}&north=${north}&east=${east}`;
        const resp = await fetch(proxyUrl, { headers: authHeaders() });
        if (resp.ok) {
            const data = await resp.json();
            candidates = Array.isArray(data.results) ? data.results : [];
        }

        // 2. Fallback: Direct Overpass API query from browser if proxy returned empty
        if (!candidates.length) {
            candidates = await queryOverpassDirectBrowser(infraType, south, west, north, east);
        }

        osmCandidates = candidates;
        const renderedCount = renderOsmCandidates(true);

        if (renderedCount > 0) {
            showMsg(
                `✓ Found ${renderedCount} OpenStreetMap ${infraType.toUpperCase()} candidate(s) (rendered as gray [+] markers). Click any gray marker on the map to import it into WeatherFall.`,
                'success'
            );
        } else {
            showMsg(
                `No un-imported OpenStreetMap ${infraType.toUpperCase()} facilities found in this view. Try zooming out or panning across Miami.`,
                'info'
            );
        }
    } catch (err) {
        showMsg(`✕ OSM Search failed: ${err.message}`, 'error');
    } finally {
        searchBtn.disabled = false;
        searchBtn.innerHTML = originalHtml;
    }
}

async function queryOverpassDirectBrowser(sector, south, west, north, east) {
    const queriesBySector = {
        energy: `node["power"="substation"](${south},${west},${north},${east});way["power"="substation"](${south},${west},${north},${east});`,
        water: `node["man_made"="pumping_station"](${south},${west},${north},${east});way["man_made"="water_works"](${south},${west},${north},${east});`,
        health: `node["amenity"="hospital"](${south},${west},${north},${east});way["amenity"="hospital"](${south},${west},${north},${east});`,
        transport: `node["railway"="station"](${south},${west},${north},${east});node["public_transport"="station"](${south},${west},${north},${east});`,
        comms: `node["man_made"="communications_tower"](${south},${west},${north},${east});node["telecom"](${south},${west},${north},${east});`,
    };
    const clause = queriesBySector[sector] || queriesBySector.energy;
    const query = `[out:json][timeout:10];(${clause});out center 50;`;

    const resp = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        body: new URLSearchParams({ data: query }),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const elements = data.elements || [];
    return elements
        .map((el) => {
            const lat = el.lat ?? el.center?.lat;
            const lon = el.lon ?? el.center?.lon;
            if (lat == null || lon == null) return null;
            const tags = el.tags || {};
            const name = tags.name || tags.operator || `Miami ${sector.toUpperCase()} #${el.id % 10000}`;
            return {
                osm_id: el.id,
                name: String(name).slice(0, 120),
                type: sector,
                x: Number(lon),
                y: Number(lat),
                tags,
            };
        })
        .filter(Boolean);
}

/**
 * Renders fetched OSM candidates as temporary gray markers on the Leaflet map.
 */
function renderOsmCandidates(openFirstPopup = false) {
    if (!osmLayerGroup || !map) return 0;
    osmLayerGroup.clearLayers();

    const existingNames = new Set(registeredNodes.map((n) => n.name.toLowerCase()));
    let renderedCount = 0;
    let firstMarker = null;
    const candidateLatLngs = [];

    const grayIcon = L.divIcon({
        className: 'osm-gray-pin-wrapper',
        html: '<div class="osm-gray-pin" title="OSM Candidate — Click to Import">+</div>',
        iconSize: [22, 22],
        iconAnchor: [11, 11],
        popupAnchor: [0, -11],
    });

    osmCandidates.forEach((cand) => {
        if (existingNames.has(String(cand.name).toLowerCase())) {
            return; // Skip already imported facilities
        }

        const lat = Number(cand.y);
        const lon = Number(cand.x);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

        renderedCount += 1;
        candidateLatLngs.push([lat, lon]);

        // Task 1: Render fetched OSM nodes as temporary gray markers
        const grayMarker = L.marker([lat, lon], {
            icon: grayIcon,
            zIndexOffset: 900,
        });

        grayMarker.bindTooltip(
            `<strong>[OSM Candidate]</strong> ${escapeHtml(cand.name)} (${escapeHtml(cand.type)}) — Click to Import`,
            { direction: 'top', offset: [0, -10] }
        );

        // Task 2: Clicking temporary OSM marker opens popup with "Import into WeatherFall" button
        const popupEl = document.createElement('div');
        popupEl.className = 'gis-popup';
        popupEl.innerHTML = `
            <div class="gis-popup-header">
                <span class="type-badge type-${escapeHtml(cand.type)}">${escapeHtml(cand.type)}</span>
                <span class="gis-popup-id">OSM #${escapeHtml(cand.osm_id)}</span>
            </div>
            <div class="gis-popup-title">${escapeHtml(cand.name)}</div>
            <div class="gis-popup-coords">Lat: ${lat.toFixed(5)}, Lon: ${lon.toFixed(5)}</div>
            <div class="gis-popup-actions">
                <button type="button" class="run-button gis-popup-btn-full osm-import-btn">
                    + Import into WeatherFall
                </button>
            </div>
        `;

        const importBtn = popupEl.querySelector('.osm-import-btn');
        importBtn.addEventListener('click', async () => {
            await importOsmCandidate(cand, grayMarker, importBtn);
        });

        grayMarker.bindPopup(popupEl, { minWidth: 225 });
        grayMarker.addTo(osmLayerGroup);

        if (!firstMarker) {
            firstMarker = grayMarker;
        }
    });

    updateOsmCount(renderedCount);

    if (openFirstPopup && candidateLatLngs.length > 0) {
        const currentBounds = map.getBounds();
        const anyVisible = candidateLatLngs.some(([lat, lon]) => currentBounds.contains([lat, lon]));
        if (!anyVisible) {
            map.fitBounds(candidateLatLngs, { padding: [45, 45], maxZoom: 13 });
        }
        if (firstMarker) {
            firstMarker.openPopup();
        }
    }

    return renderedCount;
}

/**
 * Task 2: One-Click Import from OSM marker into PostgreSQL via POST /api/v1/nodes.
 */
async function importOsmCandidate(cand, marker, btnEl) {
    const autoConnectEl = document.getElementById('osm-auto-connect');
    const autoConnect = autoConnectEl ? Boolean(autoConnectEl.checked) : true;

    if (btnEl) {
        btnEl.disabled = true;
        btnEl.textContent = 'Importing…';
    }

    try {
        const response = await fetch('/api/v1/nodes', {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({
                name: cand.name,
                type: cand.type,
                x: Number(cand.x),
                y: Number(cand.y),
                auto_connect: autoConnect,
            }),
        });

        if (response.status === 401 || response.status === 403) {
            redirectToLogin();
            return;
        }

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.detail || `Import failed (HTTP ${response.status})`);
        }

        const createdNode = await response.json();
        if (map) map.closePopup();
        if (osmLayerGroup && marker) {
            osmLayerGroup.removeLayer(marker);
        }
        osmCandidates = osmCandidates.filter((c) => c.osm_id !== cand.osm_id);

        await loadAllTopology();
        renderOsmCandidates();

        showMsg(
            `✓ Imported "${createdNode.name}" (#${createdNode.id}) into WeatherFall${autoConnect ? ' and auto-connected to grid.' : '. Click it on the map to connect edges manually.'}`,
            'success'
        );
    } catch (err) {
        showMsg(`✕ ${err.message}`, 'error');
        if (btnEl) {
            btnEl.disabled = false;
            btnEl.textContent = '+ Import into WeatherFall';
        }
    }
}

/**
 * Task 2 & 3: Creates a manual dependency edge via POST /api/v1/edges.
 */
async function createManualEdge(sourceNodeId, targetNodeId) {
    try {
        const response = await fetch('/api/v1/edges', {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({
                source_node_id: Number(sourceNodeId),
                target_node_id: Number(targetNodeId),
            }),
        });

        if (response.status === 401 || response.status === 403) {
            redirectToLogin();
            return;
        }

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.detail || `Edge creation failed (HTTP ${response.status})`);
        }

        const createdEdge = await response.json();
        await loadAllTopology();
        showMsg(
            `✓ Created dependency edge #${createdEdge.id}: "${createdEdge.source}" → "${createdEdge.target}" (${Math.round(createdEdge.routing_distance || 0)} m).`,
            'success'
        );
    } catch (err) {
        showMsg(`✕ ${err.message}`, 'error');
    }
}

/**
 * Task 3: Deletes a dependency edge via DELETE /api/v1/edges/{id}.
 */
async function deleteEdgeById(edgeId) {
    try {
        const response = await fetch(`/api/v1/edges/${edgeId}`, {
            method: 'DELETE',
            headers: authHeaders(),
        });

        if (response.status === 401 || response.status === 403) {
            redirectToLogin();
            return;
        }
        if (!response.ok && response.status !== 204) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.detail || `Failed to delete edge #${edgeId}`);
        }

        await loadAllTopology();
        showMsg(`✓ Deleted dependency connection #${edgeId}. Topology cache rebuilt.`, 'success');
    } catch (err) {
        showMsg(`✕ ${err.message}`, 'error');
    }
}

/**
 * Deletes a registered node via DELETE /api/v1/nodes/{id}.
 */
async function deleteNodeById(nodeId, nodeName = '') {
    if (!window.confirm(`Delete node #${nodeId} (${nodeName})? This will also remove its connected edges.`)) {
        return;
    }

    try {
        const response = await fetch(`/api/v1/nodes/${nodeId}`, {
            method: 'DELETE',
            headers: authHeaders(),
        });
        if (response.status === 401 || response.status === 403) {
            redirectToLogin();
            return;
        }
        if (!response.ok && response.status !== 204) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.detail || `Delete failed (HTTP ${response.status})`);
        }
        await loadAllTopology();
        showMsg(`✓ Deleted node #${nodeId} (${nodeName}). Topology cache rebuilt.`, 'success');
    } catch (err) {
        showMsg(`✕ ${err.message}`, 'error');
    }
}

function renderNodesTable(nodes) {
    const tbody = document.getElementById('nodes-tbody');
    const countEl = document.getElementById('nodes-count');
    const filterVal = (document.getElementById('nodes-filter-input')?.value || '').trim().toLowerCase();

    if (countEl) countEl.textContent = String(nodes.length);
    if (!tbody) return;

    const filtered = filterVal
        ? nodes.filter(
            (n) =>
                String(n.name).toLowerCase().includes(filterVal) ||
                String(n.type).toLowerCase().includes(filterVal) ||
                String(n.id).includes(filterVal)
        )
        : nodes;

    if (!filtered.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="table-empty">No matching nodes registered.</td></tr>';
        return;
    }

    tbody.innerHTML = filtered
        .map(
            (node) => `
        <tr data-id="${node.id}" class="clickable-row" title="Click to pan map to ${escapeHtml(node.name)}">
            <td class="cell-id">#${node.id}</td>
            <td class="cell-name">${escapeHtml(node.name)}</td>
            <td><span class="type-badge type-${escapeHtml(node.type)}">${escapeHtml(node.type)}</span></td>
            <td class="cell-num">${Number(node.y).toFixed(3)}, ${Number(node.x).toFixed(3)}</td>
            <td class="cell-actions">
                <button type="button" class="connect-row-btn" data-id="${node.id}" title="Start edge from this facility">Link</button>
                <button type="button" class="delete-btn" data-id="${node.id}" data-name="${escapeHtml(node.name)}" title="Delete node">Delete</button>
            </td>
        </tr>
    `
        )
        .join('');

    tbody.querySelectorAll('tr.clickable-row').forEach((row) => {
        row.addEventListener('click', (e) => {
            if (e.target.closest('button')) return;
            const id = Number(row.dataset.id);
            const node = registeredNodes.find((n) => n.id === id);
            if (node && map) {
                map.flyTo([Number(node.y), Number(node.x)], 15, { duration: 0.6 });
            }
        });
    });

    tbody.querySelectorAll('.connect-row-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = Number(btn.dataset.id);
            const node = registeredNodes.find((n) => n.id === id);
            if (node) {
                setEditMode(true, node);
                if (map) map.flyTo([Number(node.y), Number(node.x)], 14, { duration: 0.5 });
                showMsg(`Edit Mode Active: "${node.name}" selected as Source. Click any target node on the map.`, 'info');
            }
        });
    });

    tbody.querySelectorAll('.delete-btn').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = Number(btn.dataset.id);
            const name = btn.dataset.name || '';
            await deleteNodeById(id, name);
        });
    });
}

function renderEdgesTable(edges) {
    const tbody = document.getElementById('edges-tbody');
    const countEl = document.getElementById('edges-count');
    if (countEl) countEl.textContent = String(edges.length);
    if (!tbody) return;

    if (!edges.length) {
        tbody.innerHTML = '<tr><td colspan="4" class="table-empty">No dependency edges registered.</td></tr>';
        return;
    }

    tbody.innerHTML = edges
        .map((edge) => {
            const distLabel = edge.routing_distance ? `${Math.round(edge.routing_distance)} m` : '—';
            return `
            <tr data-id="${edge.id}">
                <td class="cell-id">#${edge.id}</td>
                <td class="cell-edge-route">
                    <span class="edge-node-name">${escapeHtml(edge.source || `#${edge.source_node_id}`)}</span>
                    <span class="edge-arrow-inline">→</span>
                    <span class="edge-node-name">${escapeHtml(edge.target || `#${edge.target_node_id}`)}</span>
                </td>
                <td class="cell-num">${distLabel}</td>
                <td>
                    <button type="button" class="delete-btn edge-delete-btn" data-id="${edge.id}" title="Delete dependency edge">Delete</button>
                </td>
            </tr>
        `;
        })
        .join('');

    tbody.querySelectorAll('.edge-delete-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const edgeId = Number(btn.dataset.id);
            await deleteEdgeById(edgeId);
        });
    });
}

function populateManualEdgeSelects(nodes) {
    const srcSel = document.getElementById('manual-edge-source');
    const tgtSel = document.getElementById('manual-edge-target');
    if (!srcSel || !tgtSel) return;

    const optionsHtml = nodes
        .map((n) => `<option value="${n.id}">${escapeHtml(n.name)} (${escapeHtml(n.type)})</option>`)
        .join('');

    srcSel.innerHTML = `<option value="">Source Facility…</option>${optionsHtml}`;
    tgtSel.innerHTML = `<option value="">Target Facility…</option>${optionsHtml}`;
}