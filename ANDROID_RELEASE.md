# Android 공통 배포 준비

이 프로젝트의 `android/` 래퍼는 ONEstore와 Google Play에서 함께 사용하는 Capacitor 앱입니다.

## 확정 전 식별자

- 현재 application ID: `com.jellysnow.penguinbounce`
- 현재 앱 이름: `펭귄 바운스`

application ID는 **어느 스토어에도 최초 등록·업로드하기 전까지만** 변경할 수 있습니다. 변경하려면 `capacitor.config.ts`의 `appId`를 수정하고 기존 `android/` 디렉터리를 재생성한 뒤 Gradle의 `namespace`와 `applicationId`, 소스 패키지 경로까지 모두 확인합니다. 최초 등록 뒤에는 업데이트 호환성과 서명 연속성을 위해 바꾸지 않습니다.

같은 앱을 두 스토어에 배포할 때는 같은 application ID와 개발자가 직접 만든 **앱 서명키**를 사용합니다. Google Play와 ONEstore의 업로드키는 앱 서명키와 분리하고 스토어별로 따로 만들 수 있습니다. 실제 keystore와 암호는 저장소에 넣지 않고 별도 보안 저장소와 오프라인 백업에 보관합니다. 두 콘솔에서 스토어 생성 키를 선택하지 말고, 최초 등록 과정에서 같은 앱 서명키를 PEPK 방식으로 제공합니다.

## 준비 환경

- Node.js 22 이상
- Android Studio
- JDK 21 (Capacitor 8의 Java 21 소스 수준과 Gradle 8.14를 함께 만족)
- Android SDK Platform 및 Build Tools(생성된 Capacitor 프로젝트의 `compileSdk` 요구 버전)

시스템 Gradle은 필요하지 않습니다. 생성된 `android/gradlew.bat`를 사용합니다.
현재 Windows 준비 환경은 `JAVA_HOME`을 별도 JDK 21로 지정합니다. Android Studio 2026.1의 JBR 25는 Gradle 8.14의 Groovy 스크립트 컴파일과 맞지 않으므로 CLI release 빌드에 사용하지 않습니다.

## 웹 번들 및 동기화

`.env.android`를 만들거나 현재 셸에 운영 API 주소를 설정합니다.

```powershell
Copy-Item .env.android.example .env.android
npm run build:android:web
npm run sync:android
npm run open:android
```

`build:android:web`은 `VITE_API_BASE_URL`이 공개 `https://` 주소가 아니면 중단됩니다. Android WebView의 Origin은 `https://localhost`로 고정했으므로 운영 API 서버의 `ALLOWED_ORIGINS`에도 이 값을 추가해야 온라인 맵 요청의 CORS 사전 검사가 통과합니다.

## Release 출력

`android/keystore.properties.example`을 `android/keystore.properties`로 복사한 뒤 현재 제출 대상 스토어의 업로드키 경로와 암호를 입력합니다. 실제 설정 파일은 Git에서 제외됩니다. 앱 서명키 자체로 배포 파일을 반복 서명하지 말고 스토어별 업로드키를 사용합니다.

`bundleRelease`와 `assembleRelease`는 `android/keystore.properties`가 없으면 즉시 실패하도록 설정되어 있습니다. 서명되지 않은 release 파일은 생성하거나 업로드하지 않습니다.

Capacitor 8.5.0이 생성한 프로젝트는 `compileSdkVersion = 36`, `targetSdkVersion = 36`을 사용합니다. 2026년 8월 말 정책 경계 이후에도 제출할 수 있도록 API 36에서 낮추지 않습니다. Activity의 방향은 `unspecified`로 두어 세로와 가로 회전을 모두 허용합니다.

```powershell
npm run build:android:aab
npm run build:android:apk
```

- AAB: `android/app/build/outputs/bundle/release/`
- APK: `android/app/build/outputs/apk/release/`

스토어 등록 전에 application ID 중복, 개발자 표시 정보, 개인정보처리방침 공개 URL, target API 정책과 서명 인증서 지문을 다시 확인합니다. `public/privacy.html`은 공개 HTTPS 서버에도 배포해 스토어 콘솔의 개인정보처리방침 URL로 사용합니다.
