// 카카오 로그인 시작: 카카오 동의 화면으로 이동
// 필요 환경변수: KAKAO_REST_API_KEY (또는 KAKAO_REST_KEY), KAKAO_CLIENT_SECRET(카카오에서 사용 설정한 경우)
const crypto = require('crypto');

module.exports = function handler(req, res) {
    const key = process.env.KAKAO_REST_API_KEY || process.env.KAKAO_REST_KEY;
    if (!key) return res.status(503).send('카카오 로그인이 아직 설정되지 않았습니다.');
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const redirectUri = 'https://' + host + '/api/kakao/callback';
    const state = crypto.randomBytes(16).toString('hex');
    res.setHeader('Set-Cookie', 'kk_state=' + state + '; Path=/api/kakao; Max-Age=600; HttpOnly; Secure; SameSite=Lax');
    res.setHeader('Cache-Control', 'no-store');
    const url = 'https://kauth.kakao.com/oauth/authorize?response_type=code'
        + '&client_id=' + encodeURIComponent(key)
        + '&redirect_uri=' + encodeURIComponent(redirectUri)
        + '&state=' + state;
    res.writeHead(302, { Location: url });
    res.end();
};
