/* Flowerpedia static catalogue login.
   GitHub Pages cannot enforce server-side authentication. These PBKDF2 hashes only gate the UI. */
(() => {
  const accounts = {"caguilar":{"salt":"859f384198f167257a98768ba65d5442","hash":"21c1ddf31dbb9eca26f078ef48b97c759de88efa541290842790a840f3a5b8a5","role":"admin"},"dvalencia":{"salt":"ef4123967b9f6904c26c299dda3c8f12","hash":"afd7235d2c27b28ececcceffa2bd052d036238bf08ab9b399695b294715218ec","role":"admin"},"rbaquero":{"salt":"d56e38411479fa333721a0e847230a00","hash":"13d2b9952d135726e25eec9f12cf941816566ddee5f1425d58e9ef175beaaf6e","role":"admin"},"ventas":{"salt":"82b706ae26aea4b7a158d6a6daafca22","hash":"258da7c2bd7116cf6e5aaf549dcc0c3ef8ebd401a618dfaf012c63dec6adc61f","role":"staff"}};
  const encoder = new TextEncoder();
  const hexBytes = value => new Uint8Array((value.match(/.{1,2}/g)||[]).map(byte=>parseInt(byte,16)));
  const hex = bytes => Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
  const localHost = ['127.0.0.1','localhost','::1'].includes(location.hostname);
  if (localHost) return; // Local Flask keeps its real SQLite authentication.

  let user = null;
  async function passwordDigest(password, saltHex) {
    if (!window.crypto?.subtle) throw new Error('Tu navegador no permite verificar el acceso seguro. Abre Flowerpedia mediante HTTPS.');
    const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({
      name:'PBKDF2', salt:hexBytes(saltHex), iterations:200000, hash:'SHA-256'
    }, key, 256);
    return hex(bits);
  }
  async function signIn(username, password) {
    const key = String(username||'').trim().toLowerCase();
    const account = accounts[key];
    if (!account) throw new Error('Usuario o contraseña incorrectos.');
    const digest = await passwordDigest(String(password||''), account.salt);
    if (digest !== account.hash) throw new Error('Usuario o contraseña incorrectos.');
    user = {id:key, username:key, role:account.role};
    return {user, profile:{id:key, username:key, display_name:key, role:account.role}};
  }
  async function signOut() { user=null; }
  async function init() { user=null; return {configured:true,user:null,profile:null}; }
  window.FlowerpediaAuth = {
    configured:true, init, signIn, signOut,
    get user() { return user; },
    get profile() { return user ? {...user,display_name:user.username} : null; },
    get role() { return user?.role || 'guest'; }
  };
})();
