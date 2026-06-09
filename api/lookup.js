// api/lookup.js
// 건축물대장 통합 조회 (표제부 + 층별개요)
// 모든 층 정보를 빠짐없이 반환

module.exports = async function handler(req, res) {
    const { sigunguCd, bjdongCd, platGbCd = '0', bun, ji = '0000' } = req.query;

    if (!sigunguCd || !bjdongCd || !bun) {
        return res.status(400).json({ error: '필수 파라미터(sigunguCd, bjdongCd, bun) 누락' });
    }

    const serviceKey = process.env.BUILDING_API_KEY;
    if (!serviceKey) {
        return res.status(500).json({ error: '서버에 API 키가 설정되지 않았습니다.' });
    }

    const isAlreadyEncoded = /%[0-9A-Fa-f]{2}/.test(serviceKey);
    const keyForUrl = isAlreadyEncoded ? serviceKey : encodeURIComponent(serviceKey);

    // numOfRows=999 — 모든 층 빠짐없이 받아오기
    const commonParams = `&sigunguCd=${sigunguCd}&bjdongCd=${bjdongCd}&platGbCd=${platGbCd}&bun=${bun}&ji=${ji}&_type=json&numOfRows=999&pageNo=1`;
    const titleUrl = `https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo?serviceKey=${keyForUrl}${commonParams}`;
    const floorUrl = `https://apis.data.go.kr/1613000/BldRgstHubService/getBrFlrOulnInfo?serviceKey=${keyForUrl}${commonParams}`;

    try {
        const [titleResp, floorResp] = await Promise.all([
            fetch(titleUrl).then(r => r.text()),
            fetch(floorUrl).then(r => r.text()).catch(() => null)
        ]);

        let titleData;
        try {
            titleData = JSON.parse(titleResp);
        } catch (e) {
            return res.status(500).json({
                error: '표제부 API 응답 형식 오류. 인증키를 확인해주세요.',
                raw: titleResp.substring(0, 300)
            });
        }

        const titleCode = titleData?.response?.header?.resultCode;
        if (titleCode && titleCode !== '00') {
            return res.status(400).json({
                error: '공공데이터 API 오류',
                code: titleCode,
                message: titleData?.response?.header?.resultMsg
            });
        }

        const titleItems = titleData?.response?.body?.items?.item;
        const titleItem = Array.isArray(titleItems) ? titleItems[0] : titleItems;
        if (!titleItem) {
            return res.status(404).json({ error: '해당 주소의 건축물대장 정보를 찾을 수 없습니다.' });
        }

        // 층별 정보 파싱 — 견고하게
        let floors = [];
        let floorsTotalCount = 0;
        let floorsDebugRaw = null;
        if (floorResp) {
            try {
                const floorData = JSON.parse(floorResp);
                floorsTotalCount = parseInt(floorData?.response?.body?.totalCount) || 0;
                let items = floorData?.response?.body?.items?.item;
                // 응답 형태 다양성 대응
                if (!items) items = floorData?.response?.body?.items;
                let arr = [];
                if (Array.isArray(items)) {
                    arr = items;
                } else if (items && typeof items === 'object') {
                    arr = [items];
                }
                floors = arr.map(f => ({
                    flrGbCd: f.flrGbCdNm || f.flrGbCd,
                    flrNo: f.flrNo,
                    flrNoNm: f.flrNoNm || (f.flrNo ? f.flrNo + '층' : ''),
                    strct: f.strctCdNm || f.strct,
                    mainPurps: f.mainPurpsCdNm || f.mainPurps,
                    area: f.area
                })).filter(f => f.flrNo || f.flrNoNm); // 빈 항목 제거
                // 지상 위→아래, 지하 아래→위 정렬
                floors.sort((a, b) => {
                    if (a.flrGbCd !== b.flrGbCd) return a.flrGbCd === '지상' ? -1 : 1;
                    const an = parseInt(a.flrNo) || 0;
                    const bn = parseInt(b.flrNo) || 0;
                    return a.flrGbCd === '지상' ? bn - an : an - bn;
                });
                // 디버그: 층 개수가 totalCount와 다르면 raw 응답 일부 포함
                if (floors.length < floorsTotalCount || floors.length === 0) {
                    floorsDebugRaw = floorResp.substring(0, 1000);
                }
            } catch (e) {
                floorsDebugRaw = floorResp.substring(0, 500);
            }
        }

        const parking = {
            indrAuto: parseInt(titleItem.indrAutoUtcnt) || 0,
            oudrAuto: parseInt(titleItem.oudrAutoUtcnt) || 0,
            indrMech: parseInt(titleItem.indrMechUtcnt) || 0,
            oudrMech: parseInt(titleItem.oudrMechUtcnt) || 0
        };
        parking.total = parking.indrAuto + parking.oudrAuto + parking.indrMech + parking.oudrMech;

        return res.status(200).json({
            bldNm: titleItem.bldNm,
            newPlatPlc: titleItem.newPlatPlc,
            platPlc: titleItem.platPlc,
            useAprDay: titleItem.useAprDay,
            platArea: titleItem.platArea,
            archArea: titleItem.archArea,
            totArea: titleItem.totArea,
            grndFlrCnt: titleItem.grndFlrCnt,
            ugrndFlrCnt: titleItem.ugrndFlrCnt,
            bcRat: titleItem.bcRat,
            vlRat: titleItem.vlRat,
            strct: titleItem.strctCdNm || titleItem.strct,
            mainPurps: titleItem.mainPurpsCdNm || titleItem.mainPurps,
            parking: parking,
            floors: floors,
            floorsTotalCount: floorsTotalCount,
            floorsDebugRaw: floorsDebugRaw  // 디버그용, 문제 없으면 null
        });

    } catch (err) {
        return res.status(500).json({ error: '건축물대장 API 호출 실패', detail: err.message });
    }
};
