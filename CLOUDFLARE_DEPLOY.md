# Cloudflare Workers + D1 배포

이 구성은 기존 `server.mjs`의 온라인 맵 API를 Cloudflare Workers와 D1에서 실행합니다. 작은 서비스는 Workers/D1 무료 할당량 안에서 운영할 수 있고, 서버 프로세스나 디스크 볼륨을 직접 관리하지 않아도 됩니다. `public/`도 Workers Static Assets로 함께 배포됩니다.

## 유지되는 API 계약

- `GET /api/health`
- `GET /api/maps`, `GET /api/maps/:id`
- `POST /api/attempts`, `POST /api/attempts/:id/complete`
- `POST /api/maps` — 서버 리플레이 검증을 통과한 미사용 게시 티켓과 최신 `termsVersion` 필요
- `POST /api/maps/:id/play`, `POST /api/maps/:id/clear`
- `POST /api/maps/:id/report`
- `POST /api/maps/:id/delete` — `X-Author-Token` 소유권 확인
- `GET /api/moderation/reports`, `POST /api/moderation/reports/:id`

작성자 토큰 원문과 IP 원문은 저장하지 않습니다. 작성자 소유권 해시는 D1에 저장하고, 요청 주소의 도메인 분리 SHA-256 해시는 일반 요청 제한 바인딩과 신고 제한 D1 행에만 사용합니다. 게시 티켓은 HMAC-SHA-256으로 서명되며 D1의 `UNIQUE` 제약조건으로 재사용을 차단합니다. 신고 중복, 숨김/차단, 소유자 삭제도 D1 제약조건과 외래키로 처리합니다.

## 최초 한 번 필요한 로그인

Cloudflare 계정 로그인이 필요합니다. 비밀번호나 인증번호를 다른 사람에게 전달하지 말고 브라우저에서 직접 처리합니다.

```powershell
npx wrangler login --use-keyring
```

`--use-keyring`은 Wrangler 로그인 토큰을 Windows 자격 증명 관리자에 저장합니다.

## D1 생성과 연결

한국 사용자가 주 대상이므로 APAC 위치 힌트로 데이터베이스를 만듭니다. 위치 힌트는 가까운 위치를 보장하는 설정은 아니며 생성 뒤 바꿀 수 없습니다.

```powershell
npx wrangler d1 create penguin-bounce-prod --location=apac
```

출력된 `database_id` UUID를 `cloudflare/wrangler.toml`의 `REPLACE_WITH_D1_DATABASE_ID`와 교체합니다. 비밀값이 아니므로 이 ID는 Git에 저장해도 됩니다.

그다음 원격 D1에 스키마를 적용합니다.

```powershell
npm run migrate:cloudflare
```

## 비밀값 등록

서로 다른 32자 이상의 무작위 값을 두 개 준비합니다. 명령을 실행하면 Wrangler가 값을 대화형으로 입력받으며 저장소 파일에는 쓰지 않습니다.

```powershell
npx wrangler secret put PUBLISH_SECRET --config cloudflare/wrangler.toml
npx wrangler secret put MODERATION_TOKEN --config cloudflare/wrangler.toml
```

- `PUBLISH_SECRET`: 클리어 검증 후 게시 티켓 서명용
- `MODERATION_TOKEN`: 신고 조회·숨김·삭제 등 운영자 전용
- 두 값을 같게 만들지 않습니다.
- 로컬 개발용 값은 `cloudflare/.dev.vars.example`을 `cloudflare/.dev.vars`로 복사해 넣습니다. 실제 `.dev.vars`는 Git에서 제외됩니다.

## 로컬 확인

```powershell
npm run migrate:cloudflare:local
npm run dev:cloudflare
```

기본 로컬 주소에서 다음을 확인합니다.

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/health
```

## 배포

```powershell
npm run deploy:cloudflare
```

배포 결과의 `https://penguin-bounce.<계정>.workers.dev` 주소로 확인합니다.

```powershell
Invoke-RestMethod https://penguin-bounce.<계정>.workers.dev/api/health
```

정상 응답 뒤 Android와 Apps-in-Toss 빌드의 `VITE_API_BASE_URL`을 이 HTTPS 주소로 바꾸고 최종 산출물을 다시 빌드합니다. 도메인이 바뀌면 `ALLOWED_ORIGINS`도 실제 웹 클라이언트 출처에 맞춰 수정합니다.

## 무료 한도와 운영 주의사항

2026-08-10 기준 Workers Free는 하루 100,000 요청과 호출당 10ms CPU, D1 Free는 하루 500만 행 읽기·10만 행 쓰기와 총 5GB 저장소를 제공합니다. 한도는 Cloudflare 정책에 따라 바뀔 수 있으므로 배포 전에 공식 가격표를 다시 확인합니다.

리플레이 검증은 서버가 물리 시뮬레이션을 다시 실행합니다. Free 플랜의 호출당 CPU 제한에 D1·암호화 여유를 남기기 위해 공용 물리 엔진과 Worker 게시 검증을 최대 1분(7,200틱)으로 통일했습니다. 1분을 넘기면 게임 화면에서 맵을 줄이거나 지름길을 만든 뒤 다시 검증하도록 안내합니다. 실제 트래픽에서 Worker CPU 시간과 D1 행 사용량을 모니터링하고, 더 긴 게시 리플레이가 꼭 필요하면 유료 Workers 또는 별도 검증 큐를 고려해야 합니다.

일반 조회와 쓰기 요청은 Cloudflare Workers Rate Limiting 바인딩의 1분 카운터를 사용하므로 매 요청마다 D1 쓰기가 발생하지 않습니다. 이 카운터는 Cloudflare 위치별로 동작하며 비동기적으로 일관성이 맞춰지는 악용 방지용 제한입니다. 신고는 한 시간 동안 IP 해시와 익명 신고자별 횟수를 정확히 제한해야 하므로 D1에만 제한 상태를 저장합니다. 두 `namespace_id`는 이 앱을 위해 구분한 값이며, 같은 Cloudflare 계정의 다른 Rate Limiting 바인딩에서 재사용하지 마세요.

공식 문서:

- [Workers Static Assets 설정](https://developers.cloudflare.com/workers/static-assets/binding/)
- [D1 시작하기](https://developers.cloudflare.com/d1/get-started/)
- [D1 마이그레이션](https://developers.cloudflare.com/d1/reference/migrations/)
- [D1 데이터 위치](https://developers.cloudflare.com/d1/configuration/data-location/)
- [Workers 비밀값](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Workers Rate Limiting 바인딩](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [Workers·D1 가격과 무료 한도](https://developers.cloudflare.com/workers/platform/pricing/)
