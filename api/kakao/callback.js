// 카카오 로그인 완료: 인가 코드 → 토큰 → 사용자 정보(이름·전화번호) → 화면으로 돌아감
// 이름·전화번호는 주소의 # 뒤(서버로 전송되지 않는 부분)에 담아 넘기고, 화면에서 읽은 뒤 바로 지웁니다.
// 전화번호는 카카오 심사(비즈 앱 + 전화번호 동의항목)를 통과해야 내려옵니다. 없으면 이름만 넘깁니다.

function back(res, frag) {
    res.setHeader('Set-Cookie', 'kk_state=; Path=/api/kakao; Max-Age=0; HttpOnly; Secure; SameSite=Lax');
    res.setHeader('Cache-Control', 'no-store');
    res.writeHead(302, { Location: '/#' + frag });
    res.end();
}
function cookie(req, name) {
    const m = String(req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
    return m ? m[1] : '';
}
function normPhone(p) {
    let d = String(p || '').replace(/[^0-9+]/g, '');
    if (d.startsWith('+82')) d = '0' + d.slice(3);
    d = d.replace(/\D/g, '');
    if (!/^01[016789]\d{7,8}$/.test(d)) return '';
    return d.replace(/^(\d{3})(\d{3,4})(\d{4})$/, '$1-$2-$3');
}

module.exports = async function handler(req, res) {
    const key = process.env.KAKAO_REST_API_KEY || process.env.KAKAO_REST_KEY;
    const secret = process.env.KAKAO_CLIENT_SECRET || '';
    const { code, state, error } = req.query;
    if (!key) return back(res, 'kkerr=config');
    if (error) return back(res, 'kkerr=cancel');
    if (!code || !state || state !== cookie(req, 'kk_state')) return back(res, 'kkerr=state');

    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const redirectUri = 'https://' + host + '/api/kakao/callback';
    try {
        const form = new URLSearchParams({ grant_type: 'authorization_code', client_id: key, redirect_uri: redirectUri, code: String(code) });
        if (secret) form.set('client_secret', secret);
        const tr = await fetch('https://kauth.kakao.com/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
            body: form.toString()
        });
        const tj = await tr.json().catch(() => ({}));
        if (!tr.ok || !tj.access_token) {
            console.error('카카오 토큰 발급 실패:', tr.status, tj.error, tj.error_code);
            return back(res, 'kkerr=token');
        }
        const ur = await fetch('https://kapi.kakao.com/v2/user/me', { headers: { Authorization: 'Bearer ' + tj.access_token } });
        const uj = await ur.json().catch(() => ({}));
        if (!ur.ok || !uj.id) return back(res, 'kkerr=user');
        const acc = uj.kakao_account || {};
        const name = String(acc.name || (acc.profile && acc.profile.nickname) || '').slice(0, 20);
        const payload = { id: String(uj.id), n: name, p: normPhone(acc.phone_number) };
        return back(res, 'kk=' + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url'));
    } catch (e) {
        console.error('카카오 로그인 오류:', e && e.message);
        return back(res, 'kkerr=server');
    }
};
