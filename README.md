# 건축ON

- `/` 건축ON 앱 (비공개 검토 중 · `middleware.ts` 입장 잠금)
- `/calc/` 이전 용도변경 계산기 (보관용, 잠금 뒤)
- `/api/` 건축물대장 조회·문자·상담 접수 (잠금 뒤)
- 입장 비밀번호: Vercel 환경변수 `GATE_PASSWORD` (없으면 `ADMIN_PASSWORD`)
- 잠금 상태: `/__gate/status` · 연결 상태(로그인 후): `/__status` · 로그아웃: `/__gate/logout`
