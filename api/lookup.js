// api/lookup.js
// 건축물대장 통합 조회 백엔드 함수
// 표제부 + 층별개요 두 API를 병렬 호출해서 모든 정보 한 번에 반환

module.exports = async function handler(req, res) {
    const { sigunguCd, bjdongCd, platGbCd = '0', bun, ji = '0000' } = req.query;

    if (!sigunguCd || !bjdongCd || !bun) {
        return res.status(400).json({ error: '필수 파라미터(sigunguCd, bjdongCd, bun) 누락' });
    }

    const serviceKey = process.env.BUILDING_API_KEY;
    if (!serviceKey) {
        return res.status(500).json({ error: '서버에 API 키가 설정되지 않았습니다.' });
    }

    // Encoding/Decoding 키 자동 처리
    const isAlreadyEncoded = /%[0-9A-Fa-f]{2}/.test(serviceKey);
    const keyForUrl = isAlreadyEncoded ? serviceKey : encodeURIComponent(serviceKey);

    const commonParams = `&sigunguCd=${sigunguCd}&bjdongCd=${bjdongCd}&platGbCd=${platGbCd}&bun=${bun}&ji=${ji}&_type=json&numOfRows=100`;
    const titleUrl = `https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo?serviceKey=${keyForUrl}${commonParams}`;
    const floorUrl = `https://apis.data.go.kr/1613000/BldRgstHubService/getBrFlrOulnInfo?serviceKey=${keyForUrl}${commonParams}`;

    try {
        // 표제부 + 층별개요 병렬 호출
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
                hint: '공공데이터포털에서 인증키를 다시 복사하거나 재발급해보세요.',
                raw: titleResp.substring(0, 300)
            });
        }

        const titleCode = titleData?.response?.header?.resultCode;
        const titleMsg = titleData?.response?.header?.resultMsg;
        if (titleCode && titleCode !== '00') {
            return res.status(400).json({
                error: '공공데이터 API 오류',
                code: titleCode,
                message: titleMsg,
                hint: titleCode === '30' ? 'SERVICE_KEY 인증 실패. 키 정확성·활용신청 승인 여부 확인.' : ''
            });
        }

        const titleItems = titleData?.response?.body?.items?.item;
        const titleItem = Array.isArray(titleItems) ? titleItems[0] : titleItems;
        if (!titleItem) {
            return res.status(404).json({ error: '해당 주소의 건축물대장 정보를 찾을 수 없습니다.' });
        }

        // 층별 정보 파싱 (실패해도 기본 정보는 반환)
        let floors = [];
        if (floorResp) {
            try {
                const floorData = JSON.parse(floorResp);
                const items = floorData?.response?.body?.items?.item;
                const arr = Array.isArray(items) ? items : (items ? [items] : []);
                floors = arr.map(f => ({
                    flrGbCd: f.flrGbCdNm || f.flrGbCd,
                    flrNo: f.flrNo,
                    flrNoNm: f.flrNoNm || (f.flrNo + '층'),
                    strct: f.strctCdNm || f.strct,
                    mainPurps: f.mainPurpsCdNm || f.mainPurps,
                    area: f.area
                }));
                // 지상 위층→아래층, 지하 아래층→위층
                floors.sort((a, b) => {
                    if (a.flrGbCd !== b.flrGbCd) return a.flrGbCd === '지상' ? -1 : 1;
                    const an = parseInt(a.flrNo) || 0;
                    const bn = parseInt(b.flrNo) || 0;
                    return a.flrGbCd === '지상' ? bn - an : an - bn;
                });
            } catch (e) {
                // 층별 파싱 실패 시 무시
            }
        }

        // 주차대수 합산
        const parking = {
            indrAuto: parseInt(titleItem.indrAutoUtcnt) || 0,
            oudrAuto: parseInt(titleItem.oudrAutoUtcnt) || 0,
            indrMech: parseInt(titleItem.indrMechUtcnt) || 0,
            oudrMech: parseInt(titleItem.oudrMechUtcnt) || 0
        };
        parking.total = parking.indrAuto + parking.oudrAuto + parking.indrMech + parking.oudrMech;

        return res.status(200).json({
            // 기본 정보
            bldNm: titleItem.bldNm,
            newPlatPlc: titleItem.newPlatPlc,
            platPlc: titleItem.platPlc,
            useAprDay: titleItem.useAprDay,
            // 면적·층수
            platArea: titleItem.platArea,
            archArea: titleItem.archArea,
            totArea: titleItem.totArea,
            grndFlrCnt: titleItem.grndFlrCnt,
            ugrndFlrCnt: titleItem.ugrndFlrCnt,
            // 비율
            bcRat: titleItem.bcRat,
            vlRat: titleItem.vlRat,
            // 구조·용도
            strct: titleItem.strctCdNm || titleItem.strct,
            mainPurps: titleItem.mainPurpsCdNm || titleItem.mainPurps,
            // 주차
            parking: parking,
            // 층별 정보 배열
            floors: floors
        });

    } catch (err) {
        return res.status(500).json({ error: '건축물대장 API 호출 실패', detail: err.message });
    }
};
