/**
 * Puerta de Selenia — login del ADMIN de OnBox.
 *
 * 🔴 Por qué existe (2026-08-05): el Command Center estaba ABIERTO a internet.
 * Cualquiera con la URL veía el estado de todos los sistemas, los hallazgos del
 * vigilante y podía hablar con el agente. Además el repo del proyecto es
 * público, así que la URL no era ningún secreto.
 *
 * No duplica usuarios: valida contra el MISMO login del admin
 * (POST /api/auth/login del worker onbox-admin, tabla admin_users en Neon). Si
 * el admin dice que sí, Selenia emite su propia sesión — el navegador no puede
 * compartir la cookie del admin porque son hosts distintos y *.workers.dev es
 * sufijo público.
 */

const COOKIE = 'selenia_session';
const TTL = 12 * 60 * 60; // 12 h

function parseCookies(request) {
  const out = {};
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function randomToken() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function sessionCookie(token) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${TTL}`;
}
function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function seleniaSessionUser(request, env) {
  if (!env.SELENIA_KV) return null;
  const tok = parseCookies(request)[COOKIE];
  if (!tok) return null;
  try {
    const raw = await env.SELENIA_KV.get('selenia-session:' + tok);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || (s.exp && Date.now() > s.exp)) return null;
    return s;
  } catch (_) {
    return null;
  }
}

/** Valida usuario/clave contra el worker del admin y abre sesión en Selenia. */
export async function seleniaLogin(request, env) {
  const adminUrl = String(env.ADMIN_URL || 'https://onbox-admin.soporte-a90.workers.dev').replace(/\/+$/, '');
  const body = await request.json().catch(() => ({}));
  const user = String(body.user || body.username || '').trim();
  const pass = String(body.pass || body.password || '');
  if (!user || !pass) {
    return new Response(JSON.stringify({ ok: false, error: 'Usuario y contraseña requeridos' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }
  let upstream;
  try {
    upstream = await fetch(adminUrl + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user, pass }),
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: 'No se pudo contactar al admin: ' + (e?.message || e) }), {
      status: 502, headers: { 'Content-Type': 'application/json' },
    });
  }
  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok || !data?.ok) {
    return new Response(JSON.stringify({ ok: false, error: data?.error || 'Usuario o contraseña incorrectos' }), {
      status: upstream.status === 401 ? 401 : 400, headers: { 'Content-Type': 'application/json' },
    });
  }
  if (!env.SELENIA_KV) {
    return new Response(JSON.stringify({ ok: false, error: 'Falta el KV de Selenia para guardar la sesión' }), {
      status: 503, headers: { 'Content-Type': 'application/json' },
    });
  }
  const token = randomToken();
  const sess = {
    username: data?.user?.username || user,
    isAdmin: data?.user?.isAdmin === true,
    sections: data?.user?.sections || [],
    exp: Date.now() + TTL * 1000,
  };
  await env.SELENIA_KV.put('selenia-session:' + token, JSON.stringify(sess), { expirationTtl: TTL });
  return new Response(JSON.stringify({ ok: true, user: { username: sess.username, isAdmin: sess.isAdmin } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': sessionCookie(token) },
  });
}

export async function seleniaLogout(request, env) {
  try {
    const tok = parseCookies(request)[COOKIE];
    if (tok && env.SELENIA_KV) await env.SELENIA_KV.delete('selenia-session:' + tok);
  } catch (_) {}
  return new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { 'Content-Type': 'application/json', 'Set-Cookie': clearCookie() },
  });
}

export function loginPage() {
  return new Response(`<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Selenia — Acceso</title>
<style>
  :root{--bg:#0b1020;--card:#141b31;--line:#243154;--fg:#e8edf7;--muted:#8fa0c4;--accent:#7c5cff}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);
       font:15px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  .card{width:min(92vw,380px);background:var(--card);border:1px solid var(--line);border-radius:16px;padding:30px 28px}
  h1{margin:0 0 4px;font-size:21px;letter-spacing:-.01em}
  p.sub{margin:0 0 22px;color:var(--muted);font-size:13.5px}
  label{display:block;font-size:12.5px;color:var(--muted);margin:0 0 6px;font-weight:600}
  input{width:100%;padding:11px 13px;margin:0 0 16px;border-radius:9px;border:1px solid var(--line);
        background:#0e152b;color:var(--fg);font-size:15px}
  input:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:transparent}
  button{width:100%;padding:12px;border:0;border-radius:9px;background:var(--accent);color:#fff;
         font-weight:700;font-size:15px;cursor:pointer}
  button:disabled{opacity:.6;cursor:default}
  .err{color:#ff8087;font-size:13px;min-height:19px;margin:10px 0 0}
</style></head>
<body>
  <form class="card" id="f">
    <h1>Selenia</h1>
    <p class="sub">Entrá con tu usuario del panel de administración.</p>
    <label for="u">Usuario</label>
    <input id="u" autocomplete="username" autofocus required>
    <label for="p">Contraseña</label>
    <input id="p" type="password" autocomplete="current-password" required>
    <button id="b" type="submit">Entrar</button>
    <div class="err" id="e"></div>
  </form>
<script>
document.getElementById('f').addEventListener('submit', async function(ev){
  ev.preventDefault();
  var b=document.getElementById('b'), e=document.getElementById('e');
  b.disabled=true; b.textContent='Entrando...'; e.textContent='';
  try{
    var r=await fetch('/selenia/login',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({user:document.getElementById('u').value,pass:document.getElementById('p').value})});
    var j=await r.json().catch(function(){return {}});
    if(!r.ok||!j.ok){ e.textContent=j.error||'No se pudo entrar'; b.disabled=false; b.textContent='Entrar'; return; }
    location.reload();
  }catch(err){ e.textContent=String(err&&err.message||err); b.disabled=false; b.textContent='Entrar'; }
});
</script>
</body></html>`, { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
