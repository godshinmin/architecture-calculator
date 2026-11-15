// 건축ON 비공개 잠금 (Vercel Routing Middleware)
// - 모든 요청(페이지·이미지·API)을 가로채서, 입장 비밀번호를 통과한 브라우저만 들여보낸다.
// - 비밀번호는 Vercel 환경변수에서만 읽는다(소스에 없음).
//     GATE_PASSWORD  : 입장 비밀번호. 쉼표로 여러 개 가능 (예: 대표용,테스터용)
//     ADMIN_PASSWORD : GATE_PASSWORD 가 없을 때만 대신 사용
//   둘 다 없으면 아무도 들어올 수 없다(잠긴 채로 안내만 표시).
// - 통과하면 서명된 쿠키(kon_gate, 30일)를 굽는다. 비밀번호를 바꾸면 기존 쿠키는 모두 무효.
// - KV_REST_API_URL/TOKEN 이 있으면 IP당 10분에 10회로 시도 횟수를 제한한다.

export const config = { matcher: '/:path*' };

// 기본 입장 비밀번호의 SHA-256 (원문은 소스에 없음 · 무작위 16자). GATE_PASSWORD 를 설정하면 더 이상 쓰이지 않는다.
const BUILTIN_SHA256 = '388937bdb27b1f6f76b7d3f13c27a6eed58839b2df93aa55ad7d87641d45a182';
const COOKIE = 'kon_gate';
const DAYS = 30;
const enc = new TextEncoder();

function passwords(): string[] {
  const env: any = (globalThis as any).process ? (globalThis as any).process.env : {};
  const raw = String(env.GATE_PASSWORD || env.ADMIN_PASSWORD || '');
  return raw.split(',').map((s: string) => s.trim()).filter((s: string) => s.length >= 4);
}

async function hmac(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
  let out = '';
  for (let i = 0; i < sig.length; i++) out += sig[i].toString(16).padStart(2, '0');
  return out;
}

async function sha256(msg: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(msg)));
  let out = '';
  for (let i = 0; i < d.length; i++) out += d[i].toString(16).padStart(2, '0');
  return out;
}
function builtinOn(): boolean {
  const env: any = (globalThis as any).process ? (globalThis as any).process.env : {};
  return !String(env.GATE_PASSWORD || '').trim();
}
async function builtinOk(pw: string): Promise<boolean> {
  return builtinOn() && pw.length >= 16 && same(await sha256(pw), BUILTIN_SHA256);
}

function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function makeToken(pw: string): Promise<string> {
  const exp = Date.now() + DAYS * 864e5;
  return exp + '.' + (await hmac(pw, 'kon-gate:' + exp));
}

async function validToken(tok: string, pws: string[]): Promise<boolean> {
  if ((tok || '').startsWith('b.')) return builtinOk(tok.slice(2));
  const m = /^(\d{13})\.([0-9a-f]{64})$/.exec(tok || '');
  if (!m || +m[1] < Date.now()) return false;
  for (const pw of pws) if (same(await hmac(pw, 'kon-gate:' + m[1]), m[2])) return true;
  return false;
}

function cookieOf(req: Request): string {
  const c = req.headers.get('cookie') || '';
  const m = new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)').exec(c);
  return m ? m[1] : '';
}

async function tooMany(req: Request): Promise<boolean> {
  const env: any = (globalThis as any).process ? (globalThis as any).process.env : {};
  const url = env.KV_REST_API_URL, token = env.KV_REST_API_TOKEN;
  if (!url || !token) return false;
  try {
    const ip = (req.headers.get('x-forwarded-for') || 'unknown').split(',')[0].trim();
    const key = 'kon:gate:' + ip;
    const r = await fetch(url + '/pipeline', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify([['INCR', key], ['EXPIRE', key, 600, 'NX']]),
      signal: AbortSignal.timeout(1500),
    });
    const j: any = await r.json();
    return Number(j && j[0] && j[0].result) > 10;
  } catch (e) {
    return false;
  }
}

const noStore = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' };

function json(obj: any, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...noStore, ...extra } });
}

function lockPage(configured: boolean): Response {
  const html = `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex,nofollow"><title>건축ON</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1a3a;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;padding:24px}
.b{width:100%;max-width:340px;text-align:center}.lg{font-size:34px;font-weight:900;letter-spacing:-1px}.lg i{font-style:normal;color:#5aa8ff}p{color:#b8c2dc;font-size:14px;line-height:1.6;margin:10px 0 22px}
input{width:100%;height:54px;border-radius:14px;border:1.5px solid #33437a;background:#16234a;color:#fff;font-size:20px;text-align:center;letter-spacing:4px;outline:none}input:focus{border-color:#5aa8ff}
button{width:100%;height:54px;margin-top:12px;border:0;border-radius:14px;background:#2453d6;color:#fff;font-size:16px;font-weight:800}button:disabled{opacity:.6}
.e{min-height:20px;margin-top:12px;color:#ffb4b4;font-size:13px}small{display:block;margin-top:26px;color:#7f8bb0;font-size:12px}</style></head>
<body><form class="b" id="f" autocomplete="off"><div class="lg">건축<i>ON</i></div><p>${configured ? '지금은 비공개 검토 중이에요.<br>입장 비밀번호를 입력해주세요.' : '비공개 준비 중이에요.<br>입장 비밀번호가 아직 설정되지 않았어요.'}</p>
<input id="p" type="password" inputmode="text" aria-label="입장 비밀번호" maxlength="64" ${configured ? 'autofocus' : 'disabled'}><button id="s" ${configured ? '' : 'disabled'}>들어가기</button><div class="e" id="e" role="alert"></div><small>건축ON · 건축사 견적·제안 서비스</small></form>
<script>document.getElementById('f').addEventListener('submit',async function(ev){ev.preventDefault();var s=document.getElementById('s'),e=document.getElementById('e');s.disabled=true;e.textContent='';try{var r=await fetch('/__gate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:document.getElementById('p').value})});if(r.ok){location.reload();return;}var j=await r.json().catch(function(){return{}});e.textContent=j.error||'들어갈 수 없어요';}catch(x){e.textContent='연결에 실패했어요. 다시 시도해주세요';}s.disabled=false;});</script></body></html>`;
  return new Response(html, { status: 401, headers: { 'content-type': 'text/html; charset=utf-8', ...noStore } });
}

export default async function middleware(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pws = passwords();
  const path = url.pathname;

  // 잠금 상태 확인용(비밀 정보 없음)
  const ready = pws.length > 0 || builtinOn();
  if (path === '/__gate/status') return json({ gate: 'on', configured: ready });

  if (path === '/__gate/logout') {
    return new Response(null, { status: 302, headers: { location: '/', 'set-cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`, ...noStore } });
  }

  if (path === '/__gate' && request.method === 'POST') {
    if (!ready) return json({ error: '입장 비밀번호가 아직 설정되지 않았어요' }, 503);
    if (await tooMany(request)) return json({ error: '시도가 너무 많아요. 10분 뒤에 다시 해주세요' }, 429);
    let input = '';
    try { const b: any = await request.json(); input = String((b && b.password) || '').trim().slice(0, 64); } catch (e) {}
    let hit = '';
    const hi = await hmac('kon-compare', input);
    for (const pw of pws) if (same(await hmac('kon-compare', pw), hi)) hit = pw;
    if (!hit && (await builtinOk(input.toLowerCase()))) return json({ ok: true }, 200, { 'set-cookie': `${COOKIE}=b.${input.toLowerCase()}; Path=/; Max-Age=${DAYS * 86400}; HttpOnly; Secure; SameSite=Lax` });
    if (!hit) return json({ error: '비밀번호가 맞지 않아요' }, 401);
    return json({ ok: true }, 200, { 'set-cookie': `${COOKIE}=${await makeToken(hit)}; Path=/; Max-Age=${DAYS * 86400}; HttpOnly; Secure; SameSite=Lax` });
  }

  if (ready && (await validToken(cookieOf(request), pws))) {
    // 통과: 연결 상태 요약(값은 노출하지 않고 설정 여부만)
    if (path === '/__status') {
      const env: any = (globalThis as any).process ? (globalThis as any).process.env : {};
      const has = (k: string) => !!env[k];
      return json({
        입장비밀번호: has('GATE_PASSWORD') ? 'GATE_PASSWORD' : '기본 비밀번호(임시)',
        건축물대장: has('BUILDING_API_KEY'),
        문자발송: has('NCP_ACCESS_KEY') && has('NCP_SECRET_KEY') && has('NCP_SERVICE_ID') && has('NCP_SENDER'),
        공용저장소: has('KV_REST_API_URL') && has('KV_REST_API_TOKEN'),
        카카오로그인: has('KAKAO_REST_API_KEY'),
        카카오알림톡: has('KAKAO_ALIMTALK_SENDER_KEY'),
      });
    }
    return new Response(null, { headers: { 'x-middleware-next': '1' } });
  }

  // 잠김: API 는 JSON, 그 외는 잠금 화면
  if (path.startsWith('/api/')) return json({ error: '비공개 검토 중입니다' }, 401);
  return lockPage(ready);
}
