// api/lookup.js
// 건축물대장 정보 자동조회 백엔드 함수
// Vercel Functions에서 실행됨. API 키는 환경변수 BUILDING_API_KEY에 저장.

module.exports = async function handler(req, res) {
    const { sigunguCd, bjdongCd, platGbCd = '0', bun, ji = '0000' } = req.query;

    if (!sigunguCd || !bjdongCd || !bun) {
        return res.status(400).json({ error: '필수 파라미터(sigunguCd, bjdongCd, bun) 누락' });
    }

    const serviceKey = process.env.BUILDING_API_KEY;
    if (!serviceKey) {
        return res.status(500).json({
            error: '서버에 API 키가 설정되지 않았습니다. Vercel 환경변수 BUILDING_API_KEY를 등록하세요.'
        });
    }

    // 키가 이미 URL 인코딩된 형태(%2F, %2B 등)인지 자동 감지
    // 인코딩된 키면 그대로, 아니면 인코딩 적용 → 양쪽 다 작동
    const isAlreadyEncoded = /%[0-9A-Fa-f]{2}/.test(serviceKey);
    const keyForUrl = isAlreadyEncoded ? serviceKey : encodeURIComponent(serviceKey);

    // 국토교통부 건축HUB 건축물대장 표제부 조회 API
    const apiUrl = 'https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo'
        + '?serviceKey=' + keyForUrl
        + '&sigunguCd=' + sigunguCd
        + '&bjdongCd=' + bjdongCd
        + '&platGbCd=' + platGbCd
        + '&bun=' + bun
        + '&ji=' + ji
        + '&_type=json&numOfRows=10';

    try {
        const apiResp = await fetch(apiUrl);
        const text = await apiResp.text();

        let data;
        try {
            data = JSON.parse(text);
        } catch (parseErr) {
            return res.status(500).json({
                error: 'API 응답 형식 오류. 인증키를 확인해주세요.',
                hint: '공공데이터포털에서 인증키를 다시 복사하거나 재발급해보세요.',
                raw: text.substring(0, 500)
            });
        }

        const resultCode = data?.response?.header?.resultCode;
        const resultMsg = data?.response?.header?.resultMsg;

        if (resultCode && resultCode !== '00') {
            return res.status(400).json({
                error: '공공데이터 API 오류',
                code: resultCode,
                message: resultMsg,
                hint: resultCode === '30' ? 'SERVICE_KEY 인증 실패. 키가 정확한지, 활용신청이 승인됐는지 확인하세요.' : ''
            });
        }

        const items = data?.response?.body?.items?.item;
        const item = Array.isArray(items) ? items[0] : items;

        if (!item) {
            return res.status(404).json({
                error: '해당 주소의 건축물대장 정보를 찾을 수 없습니다.',
                hint: '주소를 다시 확인하거나 지번주소가 정확한지 확인해주세요.'
            });
        }

        return res.status(200).json({
            mainPurps: item.mainPurpsCdNm || item.mainPurps,
            totArea: item.totArea,
            platArea: item.platArea,
            archArea: item.archArea,
            grndFlrCnt: item.grndFlrCnt,
            ugrndFlrCnt: item.ugrndFlrCnt,
            bcRat: item.bcRat,
            vlRat: item.vlRat,
            strct: item.strctCdNm || item.strct,
            useAprDay: item.useAprDay,
            bldNm: item.bldNm,
            newPlatPlc: item.newPlatPlc
        });

    } catch (err) {
        return res.status(500).json({
            error: '건축물대장 API 호출 실패',
            detail: err.message
        });
    }
};
