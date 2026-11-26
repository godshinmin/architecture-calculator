// 건축ON 공용 저장소 (베타)
//
// 여러 사람의 휴대폰·PC가 같은 요청·제안·코인·사무소 정보를 보도록 서버(Upstash Redis)에 모아 둡니다.
// 필요 환경변수 (Vercel): KV_REST_API_URL, KV_REST_API_TOKEN (계산기에서 쓰던 저장소 그대로), ADMIN_PASSWORD
//
// GET  /api/kon?a=pull&v=<마지막으로 받은 버전>   → 전체 상태 (버전이 같으면 {same:true})
// POST /api/kon {a:'push', leads, partners, misc} → 바뀐 것만 보내면 서버가 합친 뒤 전체 상태 반환
// POST /api/kon {a:'admin', password}             → 관리자 비밀번호 확인
// POST /api/kon {a:'reset', password}             → 전체 비우기 (관리자, 테스트 초기화용)
//
// 베타 한계: 권한 검사는 화면에서 하고, 서버는 "합치기"만 책임집니다.
// 정식 공개 전에는 서버에서 로그인·권한·연락처 공개 범위를 검사하도록 바꿔야 합니다.

const K = { L: 'kon:L', P: 'kon:P', M: 'kon:M', V: 'kon:V', LOCK: 'kon:lock' };
const MAX_PROPS = 5;
const COUNTERS = ['credit', 'sent', 'chosen', 'won'];
const SET_ONCE = ['opened', 'chosen', 'ret', 'retAt', 'retBy', 'refunded', 'canceled'];

function parse(s) { try { return JSON.parse(s); } catch (e) { return null; } }

/* ---------- 합치기 규칙 ---------- */

// 제안 한 건: 한 번 정해지면 안 바뀌는 값(열람·선택·반환)은 어느 쪽이든 있는 값을 유지
function mergeProp(a, b) {
    const o = Object.assign({}, a, b);
    SET_ONCE.forEach(k => { if (o[k] == null || o[k] === '' || o[k] === false) { if (a[k] != null && a[k] !== '') o[k] = a[k]; } });
    return o;
}

// 요청 한 건. refunds: 자리가 없어 빠진 제안의 코인 반환 목록 [{pid, n}]
function mergeLead(stored, inc, refunds, ev) {
    if (!stored) {
        if (ev && !inc._del) ev.push({ t: 'lead', lead: inc });
        const o = Object.assign({}, inc);
        o.props = capProps(Array.isArray(inc.props) ? inc.props : [], [], refunds);
        o.log = Array.isArray(inc.log) ? inc.log : [];
        return o;
    }
    if (stored._del) return stored;
    if (inc._del) return { id: stored.id, _del: 1, _u: inc._u || Date.now() };
    const newer = (inc._u || 0) >= (stored._u || 0);
    const o = newer ? Object.assign({}, stored, inc) : Object.assign({}, inc, stored);
    // 사진은 한쪽에만 있으면 그쪽 것을 유지
    if (!(Array.isArray(o.photos) && o.photos.length)) o.photos = (stored.photos && stored.photos.length) ? stored.photos : (inc.photos || []);
    // 제안: id 기준으로 합침
    const sp = Array.isArray(stored.props) ? stored.props : [], ip = Array.isArray(inc.props) ? inc.props : [];
    const kept = sp.map(p => { const q = ip.find(x => x && x.id === p.id); return q ? mergeProp(p, q) : p; });
    const fresh = ip.filter(p => p && p.id && !sp.some(x => x.id === p.id));
    o.props = capProps(kept, fresh, refunds);
    if (ev) {
        o.props.forEach(p => {
            const was = sp.find(x => x.id === p.id);
            if (!was) ev.push({ t: 'prop', lead: o, prop: p });
            else if (!was.chosen && p.chosen) ev.push({ t: 'chosen', lead: o, prop: p });
        });
    }
    // 기록: 합집합 (저장된 순서 유지 + 새 줄 뒤에)
    const sl = Array.isArray(stored.log) ? stored.log : [], seen = new Set(sl.map(x => JSON.stringify(x)));
    o.log = sl.concat((Array.isArray(inc.log) ? inc.log : []).filter(x => !seen.has(JSON.stringify(x))));
    // 단계는 뒤로 가지 않게
    const ST = ['미처리', '제안중', '상담중', '계약', '종료'];
    const si = ST.indexOf(stored.stage), ii = ST.indexOf(inc.stage);
    if (si >= 0 && ii >= 0 && !newer) o.stage = ST[Math.max(si, ii)];
    if (o.props.length && o.stage === '미처리') o.stage = '제안중';
    return o;
}

// 최대 5곳 · 사무소당 1건. 넘치는 새 제안은 빼고 차감된 코인을 돌려줌
function capProps(kept, fresh, refunds) {
    const out = kept.slice();
    fresh.forEach(p => {
        const dup = out.some(x => x.partnerId && x.partnerId === p.partnerId);
        if (dup || out.length >= MAX_PROPS) {
            if (refunds && p.partnerId && +p.charged > 0) refunds.push({ pid: p.partnerId, n: +p.charged });
        } else out.push(p);
    });
    return out;
}

// 사무소 한 곳. 코인·제안 수 같은 숫자는 "증감"으로 받아 더함 (동시에 충전·차감돼도 안 사라지게)
function mergePartner(stored, inc, delta) {
    if (!stored) return Object.assign({}, inc);
    if (stored._del) return stored;
    if (inc && inc._del) return { id: stored.id, _del: 1, _u: inc._u || Date.now() };
    const newer = inc && (inc._u || 0) >= (stored._u || 0);
    const o = inc ? (newer ? Object.assign({}, stored, inc) : Object.assign({}, inc, stored)) : Object.assign({}, stored);
    COUNTERS.forEach(k => {
        if (typeof stored[k] === 'number') o[k] = stored[k] + ((delta && +delta[k]) || 0);
        else if (inc && newer && inc[k] !== undefined) o[k] = inc[k];
        else o[k] = stored[k];
        if (k === 'credit' && typeof o[k] === 'number' && o[k] < 0) o[k] = 0;
    });
    // 무제한 ↔ 숫자 전환은 관리자가 바꾼 최신 값 그대로
    if (inc && newer && typeof inc.credit !== typeof stored.credit && inc.credit !== undefined) o.credit = inc.credit;
    const sl = Array.isArray(stored.coinLog) ? stored.coinLog : [], seen = new Set(sl.map(x => JSON.stringify(x)));
    o.coinLog = sl.concat(((inc && Array.isArray(inc.coinLog)) ? inc.coinLog : []).filter(x => !seen.has(JSON.stringify(x)))).slice(-200);
    return o;
}

// 그 밖의 목록(가입 문의·구매 신청·관리자·소속 건축사·연락처 공개 권한)
function mergeMisc(m, ops) {
    m = m && typeof m === 'object' ? m : {};
    ['apps', 'adminReq', 'admins', 'buys'].forEach(k => {
        let list = Array.isArray(m[k]) ? m[k] : [];
        const op = ops && ops[k];
        if (op) {
            (op.up || []).forEach(it => { if (!it || it.id == null) return; const i = list.findIndex(x => String(x.id) === String(it.id)); if (i >= 0) list[i] = it; else list.unshift(it); });
            if (Array.isArray(op.del) && op.del.length) list = list.filter(x => !op.del.map(String).includes(String(x.id)));
        }
        m[k] = list.slice(0, 500);
    });
    const g = new Set(Array.isArray(m.grants) ? m.grants.map(String) : []);
    if (ops && ops.grants && Array.isArray(ops.grants.add)) ops.grants.add.forEach(x => g.add(String(x)));
    m.grants = [...g];
    m.members = m.members && typeof m.members === 'object' ? m.members : {};
    if (ops && ops.members && ops.members.set) Object.keys(ops.members.set).forEach(pid => { m.members[pid] = ops.members.set[pid]; });
    if (ops && ops.notify) m.notify = { on: !!ops.notify.on };
    return m;
}

/* ---------- 저장소 ---------- */

function makeStore(url, token) {
    const call = async (cmd) => {
        const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
        const d = await r.json();
        if (!r.ok || d.error) throw new Error(d.error || 'Redis 요청 실패 (' + r.status + ')');
        return d.result;
    };
    return { call };
}

async function readAll(store) {
    const [L, P, M, V] = await Promise.all([store.call(['HGETALL', K.L]), store.call(['HGETALL', K.P]), store.call(['GET', K.M]), store.call(['GET', K.V])]);
    const vals = (h) => { const out = []; if (Array.isArray(h)) { for (let i = 1; i < h.length; i += 2) { const o = parse(h[i]); if (o) out.push(o); } } else if (h && typeof h === 'object') { Object.keys(h).forEach(k => { const o = typeof h[k] === 'string' ? parse(h[k]) : h[k]; if (o) out.push(o); }); } return out; };
    return { leads: vals(L), partners: vals(P), misc: mergeMisc(parse(M) || {}, null), v: +V || 0 };
}

async function hget(store, key, ids) {
    if (!ids.length) return {};
    const r = await store.call(['HMGET', key].concat(ids.map(String)));
    const out = {}; ids.forEach((id, i) => { out[String(id)] = r && r[i] ? parse(r[i]) : null; });
    return out;
}

async function withLock(store, fn) {
    const me = Math.random().toString(36).slice(2);
    let got = false;
    for (let i = 0; i < 20 && !got; i++) {
        got = (await store.call(['SET', K.LOCK, me, 'NX', 'PX', '5000'])) === 'OK';
        if (!got) await new Promise(r => setTimeout(r, 120));
    }
    try { return await fn(); }
    finally { if (got) { try { if ((await store.call(['GET', K.LOCK])) === me) await store.call(['DEL', K.LOCK]); } catch (e) { /* 만료에 맡김 */ } } }
}

/* ---------- 문자 알림 (관리자가 켠 경우에만) ---------- */
const crypto = require('crypto');
const mobile = (p) => { const d = String(p || '').replace(/\D/g, ''); return /^01[016789]\d{7,8}$/.test(d) ? d : ''; };

async function sendSms(list) {
    const ak = process.env.NCP_ACCESS_KEY, sk = process.env.NCP_SECRET_KEY, sid = process.env.NCP_SERVICE_ID, from = process.env.NCP_SENDER;
    if (!ak || !sk || !sid || !from || !list.length) return 0;
    let sent = 0;
    for (const m of list.slice(0, 40)) {
        try {
            const ts = Date.now().toString(), path = '/sms/v2/services/' + sid + '/messages';
            const sig = crypto.createHmac('sha256', sk).update('POST ' + path + '\n' + ts + '\n' + ak).digest('base64');
            const r = await fetch('https://sens.apigw.ntruss.com' + path, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json; charset=utf-8', 'x-ncp-apigw-timestamp': ts, 'x-ncp-iam-access-key': ak, 'x-ncp-apigw-signature-v2': sig },
                body: JSON.stringify({ type: 'LMS', contentType: 'COMM', countryCode: '82', from, subject: '[건축ON]', content: m.text, messages: m.to.map(t => ({ to: t })) })
            });
            if (r.ok) sent += m.to.length; else { const t = await r.text().catch(() => ''); sendSms.last = 'NCP ' + r.status + ' ' + t.slice(0, 160); console.error('문자 발송 실패:', r.status, t.slice(0, 200)); }
        } catch (e) { sendSms.last = String(e && e.message); console.error('문자 발송 오류:', e && e.message); }
    }
    return sent;
}

function buildSms(events, partners, origin) {
    const out = [];
    const what = (l) => String((l.brief && l.brief.tname) || '견적 요청').slice(0, 20) + ' · ' + String(l.region || '').slice(0, 24);
    events.slice(0, 20).forEach(e => {
        if (e.t === 'lead') {
            const to = [...new Set(partners.filter(p => p && !p._del && p.on).map(p => mobile(p.phone)).filter(Boolean))].slice(0, 50);
            if (to.length) out.push({ to, text: '[건축ON] 새 견적 요청이 들어왔어요.\n' + what(e.lead) + '\n최대 5곳까지 제안할 수 있어요.\n요청서 보기: ' + origin + '/#req=' + e.lead.id });
        } else if (e.t === 'prop') {
            const to = mobile(e.lead.phone);
            if (to) out.push({ to: [to], text: '[건축ON] ' + String(e.prop.p || '건축사사무소').slice(0, 30) + '에서 제안이 도착했어요.\n' + what(e.lead) + '\n받은 제안 보기: ' + origin + '/' });
        } else if (e.t === 'chosen') {
            const pa = partners.find(p => p && String(p.id) === String(e.prop.partnerId)), to = pa ? mobile(pa.phone) : '';
            if (to) out.push({ to: [to], text: '[건축ON] 고객이 귀사 제안에 상담을 신청했어요.\n' + what(e.lead) + '\n사무소 로그인 > 내 현황에서 고객 연락처를 확인해 주세요.\n' + origin + '/' });
        }
    });
    return out;
}

async function push(store, body, origin) {
    return withLock(store, async () => {
        const inL = (Array.isArray(body.leads) ? body.leads : []).filter(x => x && x.id != null).slice(0, 200);
        const inP = (Array.isArray(body.partners) ? body.partners : []).filter(x => x && (x.id != null || (x.rec && x.rec.id != null))).slice(0, 200);
        const refunds = [], events = [];
        if (inL.length) {
            const cur = await hget(store, K.L, inL.map(x => x.id));
            const args = ['HSET', K.L];
            inL.forEach(l => {
                const m = mergeLead(cur[String(l.id)], l, refunds, events);
                let s = JSON.stringify(m);
                if (s.length > 700000) { m.photos = []; m.photosCut = true; s = JSON.stringify(m); }
                args.push(String(l.id), s);
            });
            await store.call(args);
        }
        // 사무소: 보낸 것 + 반환 대상
        const pOps = {};
        inP.forEach(x => { const rec = x.rec || null, id = String(rec ? rec.id : x.id); pOps[id] = { rec, d: Object.assign({}, x.d || {}) }; });
        refunds.forEach(r => { const o = pOps[r.pid] || (pOps[r.pid] = { rec: null, d: {} }); o.d.credit = (+o.d.credit || 0) + r.n; o.d.sent = (+o.d.sent || 0) - 1; });
        const pids = Object.keys(pOps);
        if (pids.length) {
            const cur = await hget(store, K.P, pids);
            const args = ['HSET', K.P];
            pids.forEach(id => {
                const st = cur[id], op = pOps[id];
                if (!st && !op.rec) return;
                args.push(id, JSON.stringify(mergePartner(st, op.rec, op.d)));
            });
            if (args.length > 2) await store.call(args);
        }
        if (body.misc && typeof body.misc === 'object') {
            const m = mergeMisc(parse(await store.call(['GET', K.M])) || {}, body.misc);
            await store.call(['SET', K.M, JSON.stringify(m)]);
        }
        await store.call(['INCR', K.V]);
        const all = await readAll(store);
        if (events.length && all.misc && all.misc.notify && all.misc.notify.on && origin) {
            try {
                const hour = 'kon:sms:' + new Date().toISOString().slice(0, 13);
                const n = +(await store.call(['INCR', hour])) || 0;
                if (n === 1) await store.call(['EXPIRE', hour, '7200']);
                if (n <= 60) all.sms = await (module.exports._sms || sendSms)(buildSms(events, all.partners, origin));
            } catch (e) { console.error('알림 처리 오류:', e && e.message); }
        }
        return all;
    });
}

/* ---------- 48시간 미열람 코인 자동 반환 ---------- */
const RET_MS = 48 * 3600 * 1000;
function kst(t) { const d = new Date(t + 9 * 3600 * 1000), z = n => String(n).padStart(2, '0'); return (d.getUTCMonth() + 1) + '.' + z(d.getUTCDate()) + ' ' + z(d.getUTCHours()) + ':' + z(d.getUTCMinutes()); }

async function sweep(store, now) {
    // 5분에 한 번만 검사
    if ((await store.call(['SET', 'kon:sweep', '1', 'NX', 'EX', '300'])) !== 'OK') return 0;
    return withLock(store, async () => {
        const st = await readAll(store);
        const back = {}, changed = [];
        st.leads.forEach(l => {
            if (l._del || !Array.isArray(l.props)) return;
            let hit = false;
            l.props.forEach(p => {
                if (!p || !p.ts || p.ret || p.opened || p.chosen || now - p.ts < RET_MS) return;
                const amt = Math.max(0, +p.charged || 0);
                p.ret = '48시간 미열람'; p.retAt = kst(now); p.retBy = '자동'; p.refunded = amt;
                if (amt > 0 && p.partnerId) back[p.partnerId] = (back[p.partnerId] || 0) + amt;
                hit = true;
            });
            if (hit) { l.log = (Array.isArray(l.log) ? l.log : []).concat([[kst(now), '48시간 미열람 제안 코인 자동 반환']]); changed.push(l); }
        });
        if (!changed.length) return 0;
        const la = ['HSET', K.L]; changed.forEach(l => la.push(String(l.id), JSON.stringify(l))); await store.call(la);
        const pids = Object.keys(back);
        if (pids.length) {
            const pa = ['HSET', K.P];
            st.partners.forEach(p => { if (p && !p._del && back[p.id] && typeof p.credit === 'number') { p.credit += back[p.id]; p.coinLog = [{ at: kst(now), d: back[p.id], why: '48시간 미열람 자동 반환', by: '자동', bal: p.credit }].concat(Array.isArray(p.coinLog) ? p.coinLog : []).slice(0, 200); pa.push(String(p.id), JSON.stringify(p)); } });
            if (pa.length > 2) await store.call(pa);
        }
        await store.call(['INCR', K.V]);
        return changed.length;
    });
}

async function handler(req, res, storeOverride) {
    res.setHeader('Cache-Control', 'no-store');
    const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
    const store = storeOverride || (url && token ? makeStore(url, token) : null);
    if (!store) return res.status(503).json({ ok: false, error: '공용 저장소 환경변수 미설정 (KV_REST_API_URL / KV_REST_API_TOKEN)' });
    try {
        if (req.method === 'GET') {
            try { await sweep(store, Date.now()); } catch (e) { console.error('자동 반환 검사 오류:', e && e.message); }
            const cv = req.query && req.query.v;
            if (cv != null && cv !== '') { const v = +(await store.call(['GET', K.V])) || 0; if (String(v) === String(cv)) return res.status(200).json({ ok: true, same: true, v }); }
            const s = await readAll(store);
            return res.status(200).json(Object.assign({ ok: true }, s));
        }
        if (req.method === 'POST') {
            let body = req.body; if (typeof body === 'string') body = parse(body);
            if (!body || typeof body !== 'object') return res.status(400).json({ ok: false, error: '잘못된 요청 형식' });
            if (body.a === 'push') { const host = req.headers && (req.headers['x-forwarded-host'] || req.headers.host); const s = await push(store, body, host ? 'https://' + host : ''); return res.status(200).json(Object.assign({ ok: true }, s)); }
            if (body.a === 'admin' || body.a === 'reset' || body.a === 'smstest') {
                const pw = process.env.ADMIN_PASSWORD;
                if (!pw) return res.status(500).json({ ok: false, error: 'ADMIN_PASSWORD 미설정' });
                if (String(body.password || '') !== pw) { await new Promise(r => setTimeout(r, 800)); return res.status(401).json({ ok: false, error: '비밀번호가 올바르지 않습니다.' }); }
                if (body.a === 'smstest') {
                    const to = mobile(body.phone);
                    if (!to) return res.status(400).json({ ok: false, error: '휴대폰 번호를 정확히 입력해 주세요.' });
                    const miss = ['NCP_ACCESS_KEY', 'NCP_SECRET_KEY', 'NCP_SERVICE_ID', 'NCP_SENDER'].filter(k => !process.env[k]);
                    if (miss.length) return res.status(200).json({ ok: false, error: '문자 설정이 빠져 있어요: ' + miss.join(', ') });
                    sendSms.last = '';
                    const n = await sendSms([{ to: [to], text: '[건축ON] 문자 알림 시험 발송입니다. 이 문자가 보이면 알림이 정상 동작합니다.' }]);
                    return res.status(200).json(n ? { ok: true } : { ok: false, error: '발송 실패: ' + (sendSms.last || '원인 미상') });
                }
                if (body.a === 'reset') { await store.call(['DEL', K.L, K.P, K.M]); await store.call(['INCR', K.V]); }
                return res.status(200).json({ ok: true });
            }
            return res.status(400).json({ ok: false, error: '알 수 없는 요청' });
        }
        return res.status(405).json({ ok: false, error: '허용되지 않는 메서드' });
    } catch (e) {
        console.error('공용 저장소 오류:', e && e.message);
        return res.status(500).json({ ok: false, error: '공용 저장소 오류: ' + (e && e.message) });
    }
}

module.exports = handler;
module.exports._test = { sweep, mergeLead, mergePartner, mergeMisc, push, readAll, buildSms };
