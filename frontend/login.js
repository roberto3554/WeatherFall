// frontend/login.js

const TOKEN_KEY = 'weatherfall_token';
const USER_KEY = 'weatherfall_username';
const ADMIN_KEY = 'weatherfall_is_admin';
const THEME_STORAGE_KEY = 'weatherfall_theme';

let currentTheme = localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark';

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
}

function toggleTheme() {
    applyTheme(currentTheme === 'light' ? 'dark' : 'light');
}

applyTheme(currentTheme);

function getNextUrl() {
    const params = new URLSearchParams(window.location.search);
    const rawNext = params.get('next') || '';
    // Prevent open redirects; only allow internal paths starting with '/'
    if (rawNext.startsWith('/') && !rawNext.startsWith('//')) {
        return rawNext;
    }
    return '';
}

function clearLocalAuth() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(ADMIN_KEY);
}

document.addEventListener('DOMContentLoaded', async () => {
    applyTheme(currentTheme);

    const themeToggleBtn = document.getElementById('theme-toggle-btn');
    if (themeToggleBtn) {
        themeToggleBtn.addEventListener('click', toggleTheme);
    }

    const form = document.getElementById('login-form');
    const errorEl = document.getElementById('login-error');
    const submitBtn = document.getElementById('login-submit');

    function showError(message) {
        if (!errorEl) return;
        errorEl.textContent = `✕ ${message}`;
        errorEl.classList.remove('hidden');
    }

    // Verify existing session token against server before redirecting
    const existing = localStorage.getItem(TOKEN_KEY);
    if (existing) {
        try {
            const verifyResp = await fetch('/api/v1/auth/me', {
                method: 'GET',
                credentials: 'same-origin',
                headers: { Authorization: `Bearer ${existing}` },
            });
            if (verifyResp.ok) {
                const user = await verifyResp.json();
                localStorage.setItem(USER_KEY, user.username);
                localStorage.setItem(ADMIN_KEY, String(Boolean(user.is_admin)));
                const targetUrl = getNextUrl();
                if (targetUrl.startsWith('/admin') && !user.is_admin) {
                    clearLocalAuth();
                    await fetch('/api/v1/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
                    showError('Administrator privileges are required to access the GIS Admin Console.');
                } else {
                    const fallback = user.is_admin ? '/admin' : '/';
                    window.location.replace(targetUrl || fallback);
                    return;
                }
            } else {
                clearLocalAuth();
                await fetch('/api/v1/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
            }
        } catch (_) {
            clearLocalAuth();
        }
    }

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        errorEl.classList.add('hidden');
        errorEl.textContent = '';

        const username = document.getElementById('username').value.trim();
        const password = document.getElementById('password').value;

        if (!username || !password) {
            showError('Username and password are required.');
            return;
        }

        submitBtn.disabled = true;
        submitBtn.textContent = 'Authenticating…';

        try {
            const response = await fetch('/api/v1/auth/login', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password }),
            });

            if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                throw new Error(data.detail || data.error || `Login failed (HTTP ${response.status})`);
            }

            const data = await response.json();
            const targetUrl = getNextUrl();
            if (targetUrl.startsWith('/admin') && !data.is_admin) {
                await fetch('/api/v1/auth/logout', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { Authorization: `Bearer ${data.access_token}` },
                }).catch(() => {});
                clearLocalAuth();
                throw new Error('Administrator privileges are required to access the GIS Admin Console.');
            }

            localStorage.setItem(TOKEN_KEY, data.access_token);
            localStorage.setItem(USER_KEY, data.username);
            localStorage.setItem(ADMIN_KEY, String(Boolean(data.is_admin)));

            const fallback = data.is_admin ? '/admin' : '/';
            window.location.replace(targetUrl || fallback);
        } catch (err) {
            showError(err.message || 'Authentication failed.');
            submitBtn.disabled = false;
            submitBtn.textContent = 'Authenticate';
        }
    });
});