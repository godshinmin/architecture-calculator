// Vercel Serverless Function - 네이버 클라우드 SENS SMS 발송
// 환경변수 4개 필요:
//   NCP_ACCESS_KEY     - Access Key ID
//   NCP_SECRET_KEY     - Secret Key
//   NCP_SERVICE_ID     - SMS 서비스 ID (ncp:sms:kr:xxxxx:xxxxx)
//   NCP_SENDER         - 등록된 발신번호 (예: 07046473376, 하이픈 없이)

const crypto = require('crypto');

module.exports = async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({error: 'Method not allowed'});
    
    // 환경변수 확인
    const accessKey = process.env.NCP_ACCESS_KEY;
    const secretKey = process.env.NCP_SECRET_KEY;
    const serviceId = process.env.NCP_SERVICE_ID;
    const sender = process.env.NCP_SENDER;
    
    if (!accessKey || !secretKey || !serviceId || !sender) {
        return res.status(500).json({
            success: false,
            error: 'SMS 환경변수 미설정',
            missing: {
                NCP_ACCESS_KEY: !accessKey,
                NCP_SECRET_KEY: !secretKey,
                NCP_SERVICE_ID: !serviceId,
                NCP_SENDER: !sender
            }
        });
    }
    
    // 요청 body 파싱
    let body;
    try {
        body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch(e) {
        return res.status(400).json({error: '잘못된 요청 형식'});
    }
    
    const { phone, message, adminPhone } = body || {};
    if (!phone || !message) {
        return res.status(400).json({error: 'phone과 message 필수'});
    }
    
    // 전화번호 정리 (하이픈·공백 제거)
    const cleanPhone = String(phone).replace(/[^0-9]/g, '');
    if (cleanPhone.length < 9 || cleanPhone.length > 11) {
        return res.status(400).json({error: '올바른 전화번호 형식이 아닙니다.'});
    }
    
    // 관리자에게도 발송할지 (기본 true)
    const recipients = [{ to: cleanPhone }];
    if (adminPhone) {
        const cleanAdmin = String(adminPhone).replace(/[^0-9]/g, '');
        if (cleanAdmin.length >= 9) recipients.push({ to: cleanAdmin });
    }
    
    // 서명 생성 (HMAC-SHA256)
    const timestamp = Date.now().toString();
    const method = 'POST';
    const url = `/sms/v2/services/${serviceId}/messages`;
    const signature = makeSignature(secretKey, accessKey, timestamp, method, url);
    
    // 요청 body
    const smsBody = {
        type: 'LMS',                  // SMS(80자 이하) 또는 LMS(장문)
        contentType: 'COMM',
        countryCode: '82',
        from: sender,
        subject: '[디바이엠 견적]',
        content: message,
        messages: recipients
    };
    
    try {
        const response = await fetch(`https://sens.apigw.ntruss.com${url}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'x-ncp-apigw-timestamp': timestamp,
                'x-ncp-iam-access-key': accessKey,
                'x-ncp-apigw-signature-v2': signature
            },
            body: JSON.stringify(smsBody)
        });
        
        const data = await response.json();
        
        if (response.ok && (data.statusCode === '202' || data.statusCode === 202)) {
            return res.status(200).json({
                success: true,
                requestId: data.requestId,
                requestTime: data.requestTime,
                recipientCount: recipients.length
            });
        }
        return res.status(response.status).json({
            success: false,
            error: data.errorMessage || data.message || 'SMS 발송 실패',
            code: data.statusCode || response.status
        });
    } catch(err) {
        console.error('SMS 발송 오류:', err);
        return res.status(500).json({
            success: false,
            error: err.message
        });
    }
};

// HMAC-SHA256 서명 생성 (네이버 클라우드 SENS 규칙)
function makeSignature(secretKey, accessKey, timestamp, method, url) {
    const space = ' ';
    const newLine = '\n';
    const message = method + space + url + newLine + timestamp + newLine + accessKey;
    const hmac = crypto.createHmac('sha256', secretKey);
    hmac.update(message);
    return hmac.digest('base64');
}
