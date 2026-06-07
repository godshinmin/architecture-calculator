api/lookup.js
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

    // 국토교통부 건축HUB 건축물대장 표제부 조회 API
    const apiUrl = 'https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo'
        + '?serviceKey=' + encodeURIComponent(serviceKey)
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
        } catch (e) {
            return res.status(500).json({
                error: 'API 응답 파싱 실패 (XML 응답일 수 있음)',
                raw: text.slice(0, 300)
            });
        }

        // 에러 응답 처리
        if (data?.OpenAPI_ServiceResponse?.cmmMsgHeader) {
            const h = data.OpenAPI_ServiceResponse.cmmMsgHeader;
            return res.status(500).json({
                error: 'API 에러: ' + (h.errMsg || h.returnAuthMsg || 'Unknown'),
                code: h.returnReasonCode
            });
        }

        const items = data?.response?.body?.items?.item;
        if (!items) {
            return res.status(404).json({
                error: '해당 주소의 건축물대장 정보를 찾을 수 없습니다. 주소를 확인해주세요.'
            });
        }

        const item = Array.isArray(items) ? items[0] : items;

        res.setHeader('Cache-Control', 'no-store');
        return res.json({
            mainPurps: item.mainPurpsCdNm || '',
            totArea: item.totArea || '',
            platArea: item.platArea || '',
            archArea: item.archArea || '',
            grndFlrCnt: item.grndFlrCnt || '',
            ugrndFlrCnt: item.ugrndFlrCnt || '',
            bcRat: item.bcRat || '',
            vlRat: item.vlRat || '',
            strct: item.strctCdNm || '',
            useAprDay: item.useAprDay || '',
            bldNm: item.bldNm || '',
            newPlatPlc: item.newPlatPlc || ''
        });
    } catch (e) {
        return res.status(500).json({ error: 'API 호출 오류: ' + e.message });
    }
};
