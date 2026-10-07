// frontend/admin.js

const TOKEN_KEY = 'weatherfall_token';
const USER_KEY = 'weatherfall_username';
const ADMIN_KEY = 'weatherfall_is_admin';

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
    return String(value).replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    }[ch]));
}

document.addEventListener('DOMContentLoaded', () => {
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

    const form = document.getElementById('node-form');
    if (form) {
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            await submitNode();
        });
    }

    const resetBtn = document.getElementById('node-reset');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            form.reset();
            const msg = document.getElementById('node-form-msg');
            msg.classList.add('hidden');
            msg.textContent = '';
        });
    }

    loadNodes();
});

async function loadNodes() {
    const tbody = document.getElementById('nodes-tbody');
    if (!tbody) return;

    try {
        const response = await fetch('/api/v1/nodes', { headers: authHeaders() });
        if (response.status === 401 || response.status === 403) {
            redirectToLogin();
            return;
        }
        if (!response.ok) {
            throw new Error(`Failed to load nodes (HTTP ${response.status})`);
        }
        const nodes = await response.json();
        renderNodes(nodes);
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="6" class="table-empty table-error">${escapeHtml(err.message)}</td></tr>`;
    }
}

function renderNodes(nodes) {
    const tbody = document.getElementById('nodes-tbody');
    const countEl = document.getElementById('nodes-count');
    if (countEl) countEl.textContent = String(nodes.length);
    if (!tbody) return;

    if (!nodes.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="table-empty">No nodes registered.</td></tr>';
        return;
    }

    tbody.innerHTML = nodes.map((node) => `
        <tr data-id="${node.id}">
            <td class="cell-id">#${node.id}</td>
            <td class="cell-name" title="${escapeHtml(node.name)}">${escapeHtml(node.name)}</td>
            <td><span class="type-badge type-${escapeHtml(node.type)}">${escapeHtml(node.type)}</span></td>
            <td class="cell-num">${Number(node.x).toFixed(3)}</td>
            <td class="cell-num">${Number(node.y).toFixed(3)}</td>
            <td><button type="button" class="delete-btn" data-id="${node.id}" title="Delete node">[ × ]</button></td>
        </tr>
    `).join('');

    tbody.querySelectorAll('.delete-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.id;
            if (!window.confirm(`Delete node #${id}? This will also remove its connected edges.`)) {
                return;
            }
            btn.disabled = true;
            btn.textContent = '[ … ]';
            try {
                const response = await fetch(`/api/v1/nodes/${id}`, {
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
                await loadNodes();
            } catch (err) {
                window.alert(err.message);
                btn.disabled = false;
                btn.textContent = '[ × ]';
            }
        });
    });
}

async function submitNode() {
    const msg = document.getElementById('node-form-msg');
    const submit = document.getElementById('node-submit');

    const name = document.getElementById('node-name').value.trim();
    const type = document.getElementById('node-type').value;
    const xRaw = document.getElementById('node-x').value.trim();
    const yRaw = document.getElementById('node-y').value.trim();
    const x = Number.parseFloat(xRaw);
    const y = Number.parseFloat(yRaw);

    if (!name || !Number.isFinite(x) || !Number.isFinite(y)) {
        showMsg('Please provide a valid name and numeric coordinates.', 'error');
        return;
    }

    submit.disabled = true;
    submit.textContent = '[ CREATING… ]';
    msg.classList.add('hidden');

    try {
        const response = await fetch('/api/v1/nodes', {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ name, type, x, y }),
        });

        if (response.status === 401 || response.status === 403) {
            redirectToLogin();
            return;
        }

        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.detail || `Create failed (HTTP ${response.status})`);
        }

        showMsg(`✓ Node "${name}" registered and auto-connected.`, 'success');
        document.getElementById('node-form').reset();
        await loadNodes();
    } catch (err) {
        showMsg(`✕ ${err.message}`, 'error');
    } finally {
        submit.disabled = false;
        submit.textContent = '[ CREATE NODE ]';
    }
}

function showMsg(text, kind) {
    const msg = document.getElementById('node-form-msg');
    if (!msg) return;
    msg.textContent = text;
    msg.className = `form-msg form-msg-${kind === 'success' ? 'success' : 'error'}`;
    msg.classList.remove('hidden');
}