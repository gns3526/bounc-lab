# Bounce Ball 커뮤니티 맵 서버

별도 패키지 설치 없이 Node.js 20 이상에서 실행됩니다.

```powershell
$env:PUBLISH_SECRET = '운영용으로 생성한 길고 무작위한 비밀값'
$env:MODERATION_TOKEN = '운영자 전용으로 별도 생성한 길고 무작위한 비밀값'
$env:TRUST_PROXY = '1' # 신뢰하는 단일 리버스 프록시 뒤에서만
npm start
```

기본 주소는 `http://localhost:8787`입니다. 서버는 `public/`을 정적 서비스하고 맵과 신고를 `data/maps.json`에 원자적으로 저장합니다. `NODE_ENV=production`에서는 서로 다른 32자 이상의 `PUBLISH_SECRET`과 `MODERATION_TOKEN`이 모두 없으면 서버가 기동을 거부합니다. 개발 환경에서만 `PUBLISH_SECRET`이 없을 때 임시 키를 만들고, `MODERATION_TOKEN`이 없을 때 게시 비밀값에서 운영 토큰을 파생합니다. 어느 환경에서도 `PUBLISH_SECRET` 자체를 HTTP 요청에 보내면 안 됩니다.

앱인토스 운영에서는 `NODE_ENV=production`, 확정된 `TOSS_APP_NAME`, 영속 볼륨의 `DATA_FILE`을 설정합니다. 서버는 SDK 3의 `https://<appName>.web.tossmini.com`과 `https://<appName>.private-web.tossmini.com`을 자동 허용하며, 추가 Origin은 `ALLOWED_ORIGINS`에 쉼표로 구분해 넣습니다. 커스텀 작성자 헤더를 쓰므로 `OPTIONS` preflight도 처리합니다. Railway 같은 단일 리버스 프록시가 원본 접속 IP를 `X-Forwarded-For`의 마지막 값으로 보장하고 원본 서버 직접 접속을 막을 때만 `TRUST_PROXY=1`을 설정하세요. 그렇지 않으면 헤더 위조를 피하기 위해 기본 소켓 주소를 사용합니다.

ONEstore·Google Play용 Capacitor 앱은 `https://localhost` Origin을 사용합니다. 같은 API 서버를 연결할 때 운영 환경의 `ALLOWED_ORIGINS`에 이 Origin을 명시해야 하며, Android 웹 번들에는 공개 HTTPS `VITE_API_BASE_URL`을 주입해야 합니다.

현재 JSON 저장소와 진행 중 도전 상태는 단일 프로세스용입니다. [Dockerfile](./Dockerfile)을 사용할 때 `/data`에 영속 볼륨을 연결하고 단일 replica로 운영하세요. 다중 인스턴스나 서버리스로 확장하기 전에는 PostgreSQL 같은 공유 저장소로 이전해야 합니다.

## 맵 형식

```json
{
  "version": 1,
  "grid": [[0, 0]],
  "spawn": { "c": 1, "r": 12 },
  "exitRow": 12
}
```

실제 `grid`는 정확히 15행 × 20열이며 각 값은 정수 `0`~`6`입니다. 시작점은 0~18열의 충돌 여유가 있는 빈칸이어야 합니다. 출구는 `grid[exitRow][19]`의 유일한 오른쪽 끝 빈칸이며, 나머지 오른쪽 끝 칸은 막혀 있어야 합니다.

## 게시 흐름

작성자 토큰은 브라우저에서 한 번 무작위 생성해 보관하고, 쓰기 요청마다 `X-Author-Token` 헤더로 보냅니다. 16~256자의 비밀 문자열이며 서버에는 원문을 저장하지 않습니다. 서버는 토큰의 비공개 소유권 해시(`ownerHash`)와 차단 UI에 쓰는 별도 공개 식별값(`authorId`)을 만들며, 공개 API에는 `authorId`만 반환합니다.

1. `POST /api/attempts`에 `{ "map": ... }`를 보내 도전을 생성합니다.
2. 같은 작성자가 게임을 클리어한 직후 `POST /api/attempts/:id/complete`에 결정적 입력 리플레이를 보내 서명된 `publishTicket`을 받습니다.
3. 이용자가 이용약관과 커뮤니티 이용규칙을 확인하고 동의합니다.
4. `POST /api/maps`에 `{ "map": ..., "title": "...", "author": "...", "publishTicket": "...", "termsVersion": "2026-08-10-v1" }`를 보냅니다.

게시 티켓은 클리어한 맵 해시와 작성자에 묶이며 20분 동안 유효하고 한 번만 사용할 수 있습니다. 게시된 맵 본문은 수정 API가 없어 불변입니다.

클리어 요청의 `replay`는 `{ "version": 1, "engineVersion": "bounce-physics-v1", "totalTicks": 344, "events": [[0, 1]] }` 형식입니다. `events`는 120Hz 물리 틱 기준 `[tick, direction]` 변화만 담으며 방향은 `-1`, `0`, `1`입니다. 서버가 동일한 물리 엔진으로 전체 플레이를 다시 실행해 마지막 틱에 실제 출구에 도달한 경우에만 티켓을 발급합니다. 최대 길이는 5분(36,000틱), 최대 입력 이벤트는 4,096개입니다.

## API

- `GET /api/health`: 서버 상태
- `GET /api/maps?q=&sort=newest&page=1&limit=12`: 맵 검색/정렬/페이지 조회 (`sort`: `newest`, `oldest`, `popular`, `plays`, `clears`)
- `GET /api/maps/:id`: 플레이할 전체 맵 조회
- `POST /api/attempts`: 게시 전 테스트 시작
- `POST /api/attempts/:id/complete`: 동일 작성자의 클리어 처리 및 게시 티켓 발급
- `POST /api/maps`: 동일 맵/작성자의 미사용 티켓으로 맵 게시
- `POST /api/maps/:id/report`: 맵 또는 제작자 신고 (`scope`, `reason`, 선택적 `detail`)
- `POST /api/maps/:id/delete`: `X-Author-Token`으로 소유권을 확인한 본인 맵 삭제
- `POST /api/maps/:id/play`: 플레이 수 증가
- `POST /api/maps/:id/clear`: 클리어 수 증가
- `GET /api/moderation/reports?status=open`: 운영자 신고 목록
- `POST /api/moderation/reports/:id`: 운영자 조치 (`dismiss`, `hide_map`, `hide_author`, `delete_map`, `delete_author`)

JSON 오류는 `{ "ok": false, "error": { "code": "...", "message": "..." } }` 형태입니다. 본문은 48 KiB로 제한되며 API 요청에는 IP 기반 속도 제한이 적용됩니다. 신고는 IP와 익명 신고자별로 기본 시간당 8회로 추가 제한됩니다.

## 신고 운영

운영자 API는 브라우저 UI에 노출하지 말고 로컬 PowerShell이나 접근을 통제한 운영 도구에서만 호출합니다. `X-Moderation-Token`에는 `MODERATION_TOKEN` 값을 넣습니다.

```powershell
$headers = @{ 'X-Moderation-Token' = $env:MODERATION_TOKEN }
$queue = Invoke-RestMethod -Uri 'https://api.example.com/api/moderation/reports?status=open' -Headers $headers
$reportId = $queue.reports[0].id
$body = @{ action = 'hide_map' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "https://api.example.com/api/moderation/reports/$reportId" -Headers $headers -ContentType 'application/json' -Body $body
```

`hide_*`는 공개 목록·상세·카운터에서 즉시 제외하되 기록을 보존합니다. `delete_*`는 대상 맵과 연결된 신고 기록을 영구 삭제합니다. `dismiss`는 신고를 기각 상태로 보존합니다. 운영 전에 신고 확인 담당자와 확인 주기를 정하고, 처리 이력을 별도로 점검하세요.

기존 `maps.json` 버전 1·2는 시작 시 현재 버전 3 구조로 변환해 원자적으로 다시 저장합니다. 알 수 없는 미래 버전은 데이터 손상을 피하기 위해 기동을 거부합니다. 이전 레코드는 원래 소유권 해시가 없으므로 공개용 `authorId`는 만들 수 있지만 앱 내 본인 삭제는 할 수 없습니다. 해당 맵 삭제 요청은 운영자 절차로 처리해야 합니다. 제작자 단위 숨김·삭제 조치를 받은 공개 `authorId`는 차단 목록에 남아 같은 익명 제작자 토큰으로 다시 게시할 수 없습니다.

## 테스트

```powershell
npm test
```
