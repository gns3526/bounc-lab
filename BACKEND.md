# Bounce Ball 커뮤니티 맵 서버

별도 패키지 설치 없이 Node.js 20 이상에서 실행됩니다.

```powershell
$env:PUBLISH_SECRET = '운영용으로 생성한 길고 무작위한 비밀값'
npm start
```

기본 주소는 `http://localhost:8787`입니다. 서버는 `public/`을 정적 서비스하고 맵을 `data/maps.json`에 원자적으로 저장합니다. 운영 배포에서는 `PUBLISH_SECRET`을 반드시 고정된 비밀값으로 설정하세요. 설정하지 않으면 매 실행마다 임시 키를 만들기 때문에 재시작 전에 발급된 게시 티켓을 사용할 수 없습니다.

앱인토스 운영에서는 `NODE_ENV=production`, 확정된 `TOSS_APP_NAME`, 영속 볼륨의 `DATA_FILE`을 설정합니다. 서버는 SDK 3의 `https://<appName>.web.tossmini.com`과 `https://<appName>.private-web.tossmini.com`을 자동 허용하며, 추가 Origin은 `ALLOWED_ORIGINS`에 쉼표로 구분해 넣습니다. 커스텀 작성자 헤더를 쓰므로 `OPTIONS` preflight도 처리합니다.

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

작성자 토큰은 브라우저에서 한 번 무작위 생성해 보관하고, 쓰기 요청마다 `X-Author-Token` 헤더로 보냅니다. 16~256자의 비밀 문자열이며 서버에는 원문을 저장하지 않습니다.

1. `POST /api/attempts`에 `{ "map": ... }`를 보내 도전을 생성합니다.
2. 같은 작성자가 게임을 클리어한 직후 `POST /api/attempts/:id/complete`에 결정적 입력 리플레이를 보내 서명된 `publishTicket`을 받습니다.
3. `POST /api/maps`에 `{ "map": ..., "title": "...", "author": "...", "publishTicket": "..." }`를 보냅니다.

게시 티켓은 클리어한 맵 해시와 작성자에 묶이며 20분 동안 유효하고 한 번만 사용할 수 있습니다. 게시된 맵 본문은 수정 API가 없어 불변입니다.

클리어 요청의 `replay`는 `{ "version": 1, "engineVersion": "bounce-physics-v1", "totalTicks": 344, "events": [[0, 1]] }` 형식입니다. `events`는 120Hz 물리 틱 기준 `[tick, direction]` 변화만 담으며 방향은 `-1`, `0`, `1`입니다. 서버가 동일한 물리 엔진으로 전체 플레이를 다시 실행해 마지막 틱에 실제 출구에 도달한 경우에만 티켓을 발급합니다. 최대 길이는 5분(36,000틱), 최대 입력 이벤트는 4,096개입니다.

## API

- `GET /api/health`: 서버 상태
- `GET /api/maps?q=&sort=newest&page=1&limit=12`: 맵 검색/정렬/페이지 조회 (`sort`: `newest`, `oldest`, `popular`, `plays`, `clears`)
- `GET /api/maps/:id`: 플레이할 전체 맵 조회
- `POST /api/attempts`: 게시 전 테스트 시작
- `POST /api/attempts/:id/complete`: 동일 작성자의 클리어 처리 및 게시 티켓 발급
- `POST /api/maps`: 동일 맵/작성자의 미사용 티켓으로 맵 게시
- `POST /api/maps/:id/play`: 플레이 수 증가
- `POST /api/maps/:id/clear`: 클리어 수 증가

JSON 오류는 `{ "ok": false, "error": { "code": "...", "message": "..." } }` 형태입니다. 본문은 48 KiB로 제한되며 API 요청에는 IP 기반 속도 제한이 적용됩니다.

## 테스트

```powershell
npm test
```
