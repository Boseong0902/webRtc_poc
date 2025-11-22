## 화상 통화 매칭 애플리케이션

### 🛠️ 주요 사용 기술 및 환경

- **P2P 연결 라이브러리:** **Trystero** (WebRTC 매치메이킹 및 시그널링 추상화)
- **시그널링/백엔드:** **Supabase SaaS** (클라우드 기반 Realtime 시그널링)
- **ICE 서버:** **coturn** (Docker 기반 로컬 TURN/STUN 서버)
- **프론트엔드:** **React + TypeScript + Vite**
- **개발 환경:** **Docker Compose**로 coturn 서버 관리

### 🏗️ 아키텍처

이 프로젝트는 다음과 같은 구조로 동작합니다:

1. **시그널링**: Supabase SaaS의 Realtime 기능을 통해 피어 간 연결 협상
2. **ICE 서버**: Google 공개 STUN 서버로 NAT 통과 (약 80% 연결 성공률)
3. **P2P 연결**: Trystero가 WebRTC를 추상화하여 간편한 P2P 통신 구현

### 🔄 세션 관리 로직

#### 세션 참여 프로세스

1. **방 ID 입력 및 참여자 수 확인**
   - Supabase Presence 채널을 통해 현재 참여자 수 확인
   - 2명 이상: 참여 거부
   - 1명: 정상 참여 (기존 사용자와 매칭)
   - 0명: 기존 세션 정리 후 새 세션 생성

2. **고아 세션 처리**
   - 참여자 수가 0명인 세션 감지 시:
     - 기존 Presence 채널 완전 정리 (unsubscribe → removeChannel)
     - 새 Presence 채널 생성 및 구독
     - 참여자 수 재확인 (다른 사용자가 먼저 들어온 경우 대비)
     - 새 세션으로 진행

#### 세션 종료 프로세스

1. **자동 세션 정리**
   - 한 명이 나가면(정상/비정상 경로 모두) `onPeerLeave` 이벤트 트리거
   - 나머지 사용자도 자동으로 `cleanupSession()` 호출하여 세션 종료
   - Presence 채널 정리 (untrack → unsubscribe → removeChannel)
   - Trystero Room 정리 (leave)
   - 원격 스트림 정리
   - 상태 초기화

2. **정상 종료 경로**
   - 사용자가 "연결 해제" 버튼 클릭
   - `disconnect()` 함수 호출
   - `cleanupSession()` 실행

3. **비정상 종료 경로**
   - 네트워크 끊김
   - 브라우저 탭 닫기
   - 앱 강제 종료
   - → Trystero가 피어 연결 끊김을 감지하여 `onPeerLeave` 트리거
   - → 나머지 사용자도 자동으로 세션 종료

**ICE 서버 전략:**

- 현재: Google STUN 서버 사용 (무료, 외부 사용자와 즉시 연결 가능)
- 향후: 필요시 TURN 서버 추가로 99%+ 연결 성공률 달성 가능
  - 옵션 1: Metered.ca 무료 TURN (50GB/월)
  - 옵션 2: AWS/GCP에 자체 coturn 서버 구축

---

### 🟢 기능 요구 사항

1.  **1:1 랜덤 매칭:** 사용자는 무작위로 다른 사용자와 1:1 화상 통화 매칭을 시작할 수 있어야 합니다.
2.  **필터링 기능:** 매칭 시 다음과 같은 필터를 적용할 수 있어야 합니다.
    - 성별 필터링: 원하는 성별의 사용자에게만 매칭을 요청할 수 있어야 합니다.
3.  **매칭 세션 관리:**
    - 통화 연결이 성공하면, 두 사용자에게 고유한 세션(Room) ID가 할당되어야 합니다.
    - 통화가 정상적으로 종료되거나, 한쪽이 연결을 거절하면 해당 세션은 즉시 종료됩니다.
    - **자동 세션 정리**: 한 명이 나가면(정상/비정상 경로 모두) 나머지 사용자도 자동으로 세션에서 나가게 됩니다.
    - **고아 세션 방지**: 참여자 수가 0명인 세션을 감지하면 자동으로 정리하고 새로 생성합니다.

---

### 🟡 비기능 요구 사항

#### 안정적인 연결 관리

1.  통화 중 네트워크 일시 단절 발생 시, 5초 이내에 **Trystero를 활용**하여 자동으로 재연결을 시도해야 합니다.
2.  정상 종료, 타임아웃, 거절, 네트워크 종료 등 모든 통화 종료 원인을 구분하여 시스템에 기록해야 합니다.
3.  이전에 사용된 세션(Room) ID는 재사용할 수 없도록 관리해야 합니다.

#### 시스템 확장성

1.  사용자 수 증가에 대비하여, 동시 접속자 수가 많아져도 안정적으로 매칭 및 통화 세션을 처리할 수 있도록 시스템을 설계해야 합니다.
2.  **Docker Compose**를 활용하여 **API 게이트웨이, 매칭 서버, coturn (ICE) 서버** 등 모든 컴포넌트의 수평적 확장이 용이하도록 설계해야 합니다.

#### 보안

1.  사용자 프로필 정보와 결제 정보는 암호화하여 안전하게 관리해야 합니다.
2.  WebRTC의 기본 암호화(DTLS/SRTP) 외에, Supabase를 통한 데이터 교환 시 **RLS(Row Level Security)**를 적용해야 합니다.

---

## 🚀 빠른 시작

### 1. 사전 요구사항

- Node.js 18 이상
- Docker Desktop
- Supabase 계정 (https://supabase.com - 무료)

### 2. Supabase 프로젝트 설정

1. [Supabase 대시보드](https://supabase.com/dashboard)에서 새 프로젝트 생성
2. **Settings** > **API**로 이동
3. 다음 정보를 복사:
   - **Project URL** (예: `https://xxxxx.supabase.co`)
   - **anon public** key

### 3. 프로젝트 설정

```bash
# 저장소 클론 (또는 다운로드)
cd salang_webrtc_kihong

# 환경 변수 파일 생성
cp .env.example .env

# .env 파일을 열어 Supabase 정보 입력
# VITE_SUPABASE_URL=your-project-url
# VITE_SUPABASE_ANON_KEY=your-anon-key

# 의존성 설치
npm install

# (선택사항) 로컬 coturn 서버 시작 - 현재는 Google STUN 사용 중
# docker-compose up -d

# 개발 서버 시작
npm run dev
```

**참고:** 현재는 Google의 무료 STUN 서버를 사용하므로 Docker coturn 서버 없이도 외부 사용자와 연결됩니다!

### 4. 외부 기기 테스트 (스마트폰 등)

**외부 기기에서 테스트하려면 HTTPS가 필요합니다** (mediaDevices API 보안 요구사항)

#### ngrok으로 HTTPS 터널 생성:

```bash
# 터미널 1: Vite 서버 실행
npm run dev

# 터미널 2: ngrok 터널 생성
ngrok http 3000
```

**생성된 HTTPS URL 사용:**

- 예: `https://abc123.ngrok-free.app`
- PC와 스마트폰 모두 이 URL로 접속
- ngrok 경고 페이지 나오면 "Visit Site" 클릭

### 5. 테스트

#### 🧪 자동화된 연결 테스트 (권장)

1. 브라우저에서 http://localhost:3000 열기
2. 상단의 **"🧪 연결 테스트"** 탭 클릭
3. "테스트 시작" 버튼 클릭
4. 방 ID를 복사
5. **다른 브라우저 또는 시크릿 창**에서 같은 URL 열기
6. "🧪 연결 테스트" 탭으로 이동
7. 복사한 방 ID를 입력하고 "테스트 시작" 클릭

**테스트 페이지에서 확인할 수 있는 항목:**

- ✅ 미디어 스트림 획득 (카메라/마이크)
- ✅ Supabase 시그널링 연결
- ✅ Peer 간 P2P 연결 (Google STUN을 통한 NAT 통과)
- ✅ ICE 연결 상태 (connected/completed)
- ✅ 오디오/비디오 스트림 송수신
- ✅ 실시간 오디오 레벨 미터
- ✅ 네트워크 지연시간 (latency)
- ✅ 연결 품질 평가

**참고:** Google STUN 서버를 사용하므로 다른 네트워크의 사용자와도 약 80% 확률로 연결됩니다!

#### 💬 일반 앱 테스트

**로컬 테스트:**

1. http://localhost:3000 접속
2. "💬 일반 앱" 탭 선택
3. 방 ID 입력 후 참여
4. 시크릿 모드에서 같은 방 ID로 참여
5. ⚠️ 같은 PC에서는 마이크 공유 불가 (정상)

**외부 기기 테스트:**

1. ngrok URL (예: `https://abc123.ngrok-free.app`) 접속
2. "💬 일반 앱" 탭 선택
3. 방 ID 입력 후 참여
4. 다른 기기에서 같은 ngrok URL + 방 ID로 참여
5. ✅ 양방향 오디오/비디오 작동!

---

## 🧪 테스트 기능

이 프로젝트는 WebRTC 연결을 체계적으로 테스트할 수 있는 전용 테스트 페이지를 제공합니다.

### 테스트 항목

1. **연결 상태 모니터링**

   - 실시간 ICE 연결 상태 확인
   - Peer 연결 수 표시
   - 연결/해제 이벤트 로깅

2. **오디오 레벨 측정**

   - 로컬 마이크 입력 레벨 시각화
   - 원격 오디오 수신 레벨 시각화
   - 실시간 오디오 분석 (Web Audio API 사용)

3. **네트워크 품질**

   - 지연시간(latency) 측정 (ms 단위)
   - 연결 품질 평가 (양호/보통/느림)
   - 3초마다 자동 측정

4. **자동 테스트 시나리오**
   - 미디어 스트림 획득 검증
   - Supabase 시그널링 연결 검증
   - Peer 연결 수립 검증
   - 스트림 송수신 검증
   - 각 단계별 성공/실패 로깅

### 문제 해결

테스트 페이지의 결과를 통해 다음 문제를 진단할 수 있습니다:

- ❌ **미디어 스트림 실패**: 카메라/마이크 권한 확인
- ❌ **Trystero 연결 실패**: Supabase URL/Key 확인
- ❌ **Peer 연결 실패**: 네트워크 방화벽 확인 (Google STUN 접근 가능한지)
- ❌ **ICE 연결 실패**: Symmetric NAT 환경일 수 있음 (TURN 서버 필요)
- ❌ **오디오 레벨 0**: 마이크 음소거 해제 확인

---

## 📖 참고 문서

- [프로젝트 구조 설명](PROJECT_STRUCTURE.md)
- [Trystero 공식 문서](https://github.com/dmotz/trystero)
- [Supabase 공식 문서](https://supabase.com/docs)
- [WebRTC MDN 문서](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API)
