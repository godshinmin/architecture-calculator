// 견적 제출 기록 저장 / 조회 API
//
// 필요 환경변수 (Vercel):
//   KV_REST_API_URL     - Upstash Redis REST URL
//   KV_REST_API_TOKEN   - Upstash Redis REST Token
//   ADMIN_PASSWORD      - 관리자 페이지 비밀번호 (예: dbym2026!)
//
// POST /api/submissions  → 견적 기록 저장 (누구나, 견적 제출 시 자동 호출)
// GET  /api/submissions?password=xxx  → 전체 목록 조회 (관리자만)

const REDIS_KEY = 'dbym:submissions';
const MAX_RECORDS = 500; // 최근 500건만 보관

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const url = process.env.KV_REST_API_URL;
    const token = process.env.KV_REST_API_TOKEN;

    if (!url || !token) {
        return res.status(500).json({
            success: false,
            error: '저장소 환경변수 미설정 (KV_REST_API_URL / KV_REST_API_TOKEN)'
        });
    }

    // ---------- 저장 ----------
    if (req.method === 'POST') {
        let body;
        try {
            body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        } catch (e) {
            return res.status(400).json({ success: false, error: '잘못된 요청 형식' });
        }

        const record = {
            id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
            createdAt: new Date().toISOString(),
            name: str(body.name),
            phone: str(body.phone),
            email: str(body.email),
            caseType: str(body.caseType),
            adminType: str(body.adminType),
            address: str(body.address),
            area: Number(body.area) || 0,
            drawing: str(body.drawing),
            total: Number(body.total) || 0,
            items: Array.isArray(body.items)
                ? body.items.slice(0, 12).map(function (it) {
                      return { name: str(it.name).slice(0, 120), amount: Number(it.amount) || 0 };
                  })
                : []
        };

        if (!record.name || !record.phone) {
            return res.status(400).json({ success: false, error: 'name, phone 필수' });
        }

        try {
            // LPUSH → 최신이 앞에, LTRIM → 최근 N건만 유지
            await redis(url, token, ['LPUSH', REDIS_KEY, JSON.stringify(record)]);
            await redis(url, token, ['LTRIM', REDIS_KEY, '0', String(MAX_RECORDS - 1)]);
            return res.status(200).json({ success: true, id: record.id });
        } catch (err) {
            console.error('저장 실패:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    // ---------- 조회 (관리자) ----------
    if (req.method === 'GET') {
        const adminPassword = process.env.ADMIN_PASSWORD;
        if (!adminPassword) {
            return res.status(500).json({ success: false, error: 'ADMIN_PASSWORD 미설정' });
        }
        const given = (req.query && req.query.password) || '';
        if (given !== adminPassword) {
            return res.status(401).json({ success: false, error: '비밀번호가 올바르지 않습니다.' });
        }

        try {
            const result = await redis(url, token, ['LRANGE', REDIS_KEY, '0', '-1']);
            const list = (result || [])
                .map(function (s) {
                    try { return JSON.parse(s); } catch (e) { return null; }
                })
                .filter(Boolean);
            return res.status(200).json({ success: true, count: list.length, submissions: list });
        } catch (err) {
            console.error('조회 실패:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    return res.status(405).json({ success: false, error: 'Method not allowed' });
};

// Upstash Redis REST 명령 실행
async function redis(url, token, command) {
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: 'Bearer ' + token,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(command)
    });
    const data = await response.json();
    if (!response.ok || data.error) {
        throw new Error(data.error || 'Redis 요청 실패 (' + response.status + ')');
    }
    return data.result;
}

function str(v) {
    return v == null ? '' : String(v).trim().slice(0, 200);
}
