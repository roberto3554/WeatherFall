// frontend/login.js

const TOKEN_KEY = 'weatherfall_token';
const USER_KEY = 'weatherfall_username';
const ADMIN_KEY = 'weatherfall_is_admin';

function getNextUrl() {
    const params = new URLSearchParams(window.location.search);
    return params.get('next') || '';
}

document.addEventListener('DOMContentLoaded', () => {
    // If already authenticated, redirect immediately
    const existing = localStorage.getItem(TOKEN_KEY);
    if (existing) {
        const fallback = localStorage.getItem(ADMIN_KEY) === 'true' ? '/admin' : '/';
        window.location.replace(getNextUrl() || fallback);
        return;
    }

    const form = document.getElementById('login-form');
    const errorEl = document.getElementById('login-error');
    const submitBtn = document.getElementById('login-submit');

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
        submitBtn.textContent = '[ AUTHENTICATING… ]';

        try {
            const response = await fetch('/api/v1/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password }),
            });

            if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                throw new Error(data.detail || `Login failed (HTTP ${response.status})`);
            }

            const data = await response.json();
            localStorage.setItem(TOKEN_KEY, data.access_token);
            localStorage.setItem(USER_KEY, data.username);
            localStorage.setItem(ADMIN_KEY, String(Boolean(data.is_admin)));

            const fallback = data.is_admin ? '/admin' : '/';
            window.location.replace(getNextUrl() || fallback);
        } catch (err) {
            showError(err.message || 'Authentication failed.');
            submitBtn.disabled = false;
            submitBtn.textContent = '[ AUTHENTICATE ]';
        }
    });

    function showError(message) {
        errorEl.textContent = `✕ ${message}`;
        errorEl.classList.remove('hidden');
    }
});