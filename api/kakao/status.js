// 카카오 로그인 사용 가능 여부 (키가 등록돼 있을 때만 화면에서 실제 로그인으로 전환)
module.exports = function handler(req, res) {
    const key = process.env.KAKAO_REST_API_KEY || process.env.KAKAO_REST_KEY;
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ on: !!key });
};
