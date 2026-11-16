(() => {
  let user = null;
  let profile = null;
  let csrfToken = '';

  async function request(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (!(options.body instanceof FormData) && options.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    if (options.method && !['GET', 'HEAD', 'OPTIONS'].includes(options.method.toUpperCase())) {
      if (csrfToken) headers.set('X-CSRF-Token', csrfToken);
    }
    const response = await fetch(path, {
      ...options, headers, credentials: 'same-origin', cache: 'no-store'
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(data.error || `Error del servidor (${response.status}).`);
    }
    if (data.csrfToken) csrfToken = data.csrfToken;
    return data;
  }

  async function init() {
    const data = await request('/api/session');
    user = data.user || null;
    profile = user ? { ...user, display_name: user.username } : null;
    return { configured: true, user, profile };
  }

  async function signIn(username, password) {
    const data = await request('/api/login', {
      method: 'POST', body: JSON.stringify({ username, password })
    });
    user = data.user || null;
    profile = user ? { ...user, display_name: user.username } : null;
    return { user, profile };
  }

  async function signOut() {
    await request('/api/logout', { method: 'POST', body: '{}' });
    user = null;
    profile = null;
  }

  async function getCommercialData(productId) {
    if (!user || profile?.role !== 'admin') {
      throw new Error('Solo los administradores pueden consultar los precios.');
    }
    const data = await request(`/api/commercial/${encodeURIComponent(productId)}`);
    return { variants: data.variants || [], composition: data.composition || [] };
  }

  window.FlowerpediaAuth = {
    configured: true, init,
    get user() { return user; },
    get profile() { return profile; },
    get role() { return profile?.role || 'guest'; },
    signIn, signOut, getCommercialData
  };
})();
