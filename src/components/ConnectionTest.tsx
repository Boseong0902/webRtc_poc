import { useState, useEffect, useRef } from 'react'
import { joinRoom } from 'trystero/supabase'
import type { Room } from 'trystero'
import { createClient, type RealtimeChannel } from '@supabase/supabase-js'
import './ConnectionTest.css'

// Supabase 설정
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

// Supabase Client 생성
const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

// ICE 서버 설정 (Google 공개 STUN 서버)
const TURN_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' }
  ]
}

interface TestResult {
  timestamp: string
  test: string
  status: 'success' | 'failed' | 'running'
  message: string
}

interface AudioLevel {
  local: number
  remote: number
}

export default function ConnectionTest() {
  const [roomId, setRoomId] = useState('test-room-' + Math.random().toString(36).substr(2, 9))
  const [testResults, setTestResults] = useState<TestResult[]>([])
  const [isTestRunning, setIsTestRunning] = useState(false) // 테스트 진행 중 여부
  const [isConnected, setIsConnected] = useState(false) // 피어 연결 여부
  const [connectedPeers, setConnectedPeers] = useState<string[]>([])
  const [iceConnectionState, setIceConnectionState] = useState<string>('new')
  const [audioLevels, setAudioLevels] = useState<AudioLevel>({ local: 0, remote: 0 })
  const [latency, setLatency] = useState<number | null>(null)
  
  const roomRef = useRef<Room | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const remoteStreamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const localAnalyserRef = useRef<AnalyserNode | null>(null)
  const remoteAnalyserRef = useRef<AnalyserNode | null>(null)
  const animationFrameRef = useRef<number>()
  const latencyIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const presenceChannelRef = useRef<RealtimeChannel | null>(null)

  const addTestResult = (test: string, status: TestResult['status'], message: string) => {
    const result: TestResult = {
      timestamp: new Date().toLocaleTimeString(),
      test,
      status,
      message
    }
    setTestResults(prev => [...prev, result])
  }

  // Cleanup: 컴포넌트 언마운트 시 모든 리소스 정리
  useEffect(() => {
    return () => {
      // 애니메이션 프레임 정리
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
      }
      
      // Interval 정리
      if (latencyIntervalRef.current) {
        clearInterval(latencyIntervalRef.current)
      }
      
      // 오디오 컨텍스트 정리
      const audioContext = audioContextRef.current
      if (audioContext && audioContext.state !== 'closed') {
        audioContext.close().catch(() => {
          // 이미 닫힌 경우 무시
        })
      }
      
      // Presence 채널 정리
      if (presenceChannelRef.current) {
        presenceChannelRef.current.untrack()
        supabaseClient.removeChannel(presenceChannelRef.current)
        presenceChannelRef.current = null
      }
      
      // Room 정리
      if (roomRef.current) {
        roomRef.current.leave()
      }
      
      // 스트림 정리
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(track => track.stop())
      }
      if (remoteStreamRef.current) {
        remoteStreamRef.current.getTracks().forEach(track => track.stop())
      }
    }
  }, [])

  // 오디오 레벨 분석 초기화
  const initAudioAnalysis = (stream: MediaStream, isLocal: boolean) => {
    try {
      // AudioContext 상태 체크 및 생성/재개
      if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
        audioContextRef.current = new AudioContext()
        console.log('🎵 새 AudioContext 생성:', audioContextRef.current.state)
      }

      // AudioContext가 suspended 상태면 resume
      if (audioContextRef.current.state === 'suspended') {
        audioContextRef.current.resume().then(() => {
          console.log('🎵 AudioContext resumed')
        })
      }

      const analyser = audioContextRef.current.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.8
      
      const source = audioContextRef.current.createMediaStreamSource(stream)
      source.connect(analyser)

      if (isLocal) {
        localAnalyserRef.current = analyser
      } else {
        remoteAnalyserRef.current = analyser
      }

      const audioTracks = stream.getAudioTracks()
      console.log(`🎵 ${isLocal ? '로컬' : '원격'} 오디오 분석기 초기화:`, {
        context_state: audioContextRef.current.state,
        has_audio_tracks: audioTracks.length > 0,
        audio_enabled: audioTracks.length > 0 ? audioTracks[0].enabled : false,
        track_label: audioTracks.length > 0 ? audioTracks[0].label : 'none'
      })

      addTestResult(
        `${isLocal ? '로컬' : '원격'} 오디오 분석`,
        'success',
        `오디오 분석기 초기화 완료 (트랙: ${audioTracks.length}, 상태: ${audioContextRef.current.state})`
      )
    } catch (error) {
      console.error(`❌ ${isLocal ? '로컬' : '원격'} 오디오 분석 오류:`, error)
      addTestResult(
        `${isLocal ? '로컬' : '원격'} 오디오 분석`,
        'failed',
        `오디오 분석 초기화 실패: ${error}`
      )
    }
  }

  // 오디오 레벨 측정
  const measureAudioLevel = (analyser: AnalyserNode): number => {
    const dataArray = new Uint8Array(analyser.frequencyBinCount)
    analyser.getByteFrequencyData(dataArray)
    const average = dataArray.reduce((a, b) => a + b) / dataArray.length
    return Math.min(100, (average / 255) * 100)
  }

  // 오디오 레벨 애니메이션
  useEffect(() => {
    const animate = () => {
      if (localAnalyserRef.current || remoteAnalyserRef.current) {
        setAudioLevels({
          local: localAnalyserRef.current ? measureAudioLevel(localAnalyserRef.current) : 0,
          remote: remoteAnalyserRef.current ? measureAudioLevel(remoteAnalyserRef.current) : 0
        })
      }
      animationFrameRef.current = requestAnimationFrame(animate)
    }

    if (isTestRunning) {
      animate()
    }

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
      }
    }
  }, [isTestRunning])

  // ICE 연결 상태 모니터링
  const monitorIceConnectionState = (room: Room) => {
    const peers = room.getPeers()
    Object.values(peers).forEach(peerConnection => {
      peerConnection.oniceconnectionstatechange = () => {
        const state = peerConnection.iceConnectionState
        setIceConnectionState(state)
        
        addTestResult(
          'ICE 연결 상태',
          state === 'connected' || state === 'completed' ? 'success' : 
          state === 'failed' ? 'failed' : 'running',
          `ICE 상태: ${state}`
        )
      }
    })
  }

  // 지연시간 측정
  const measureLatency = async (room: Room, peerId: string) => {
    try {
      const pingTime = await room.ping(peerId)
      setLatency(pingTime)
      
      addTestResult(
        '네트워크 지연시간',
        pingTime < 100 ? 'success' : 'running',
        `${pingTime}ms ${pingTime < 100 ? '(양호)' : pingTime < 300 ? '(보통)' : '(느림)'}`
      )
    } catch (error) {
      addTestResult('네트워크 지연시간', 'failed', `측정 실패: ${error}`)
    }
  }

  // 테스트 시작
  const startTest = async () => {
    setTestResults([])
    setIsTestRunning(true) // 테스트 시작
    addTestResult('테스트 시작', 'running', '연결 테스트를 시작합니다...')

    try {
      // 1. 미디어 스트림 획득 테스트
      addTestResult('미디어 스트림', 'running', '마이크 및 카메라 권한 요청 중...')
      
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: true, 
        audio: true 
      })
      
      localStreamRef.current = stream
      addTestResult(
        '미디어 스트림',
        'success',
        `스트림 획득 성공 (비디오: ${stream.getVideoTracks().length}, 오디오: ${stream.getAudioTracks().length})`
      )

      // 로컬 오디오 분석 초기화
      initAudioAnalysis(stream, true)

      // 2. 방 참여자 수 확인
      addTestResult('방 참여자 수 확인', 'running', '현재 참여자 수를 확인 중...')
      
      const presenceChannel = supabaseClient.channel(`room-presence:${roomId}`)
      presenceChannelRef.current = presenceChannel

      // Presence 구독 및 상태 확인
      const checkParticipantCount = (): Promise<number> => {
        return new Promise((resolve, reject) => {
          let resolved = false
          
          presenceChannel
            .on('presence', { event: 'sync' }, () => {
              if (!resolved) {
                resolved = true
                const state = presenceChannel.presenceState()
                const participantCount = Object.keys(state).length
                resolve(participantCount)
              }
            })
            .subscribe(async (status) => {
              if (status === 'SUBSCRIBED') {
                setTimeout(() => {
                  if (!resolved) {
                    resolved = true
                    const state = presenceChannel.presenceState()
                    const participantCount = Object.keys(state).length
                    resolve(participantCount)
                  }
                }, 100)
              } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
                if (!resolved) {
                  resolved = true
                  reject(new Error('Presence 채널 구독 실패'))
                }
              }
            })
        })
      }

      // 참여자 수 확인
      const participantCount = await checkParticipantCount()
      addTestResult('방 참여자 수 확인', 'success', `현재 참여자: ${participantCount}명`)

      // 2명 이상이면 참여 거부
      if (participantCount >= 2) {
        addTestResult('방 참여', 'failed', `방이 가득 찼습니다. (현재 ${participantCount}명 참여 중)`)
        supabaseClient.removeChannel(presenceChannel)
        presenceChannelRef.current = null
        setIsTestRunning(false)
        return
      }

      // Presence에 자신의 정보 추가
      await presenceChannel.track({
        userId: `user-${Date.now()}`,
        joinedAt: new Date().toISOString()
      })

      // 3. Trystero 방 참여 테스트
      addTestResult('Trystero 연결', 'running', 'Supabase를 통해 방에 참여 중...')
      
      const room = joinRoom(
        {
          appId: SUPABASE_URL,
          supabaseKey: SUPABASE_ANON_KEY,
          rtcConfig: TURN_CONFIG
        },
        roomId
      )
      
      roomRef.current = room
      addTestResult('Trystero 연결', 'success', `방 "${roomId}"에 참여 완료`)

      // 3. 피어 연결 모니터링
      room.onPeerJoin((peerId: string) => {
        setConnectedPeers(prev => [...prev, peerId])
        setIsConnected(true)
        addTestResult('피어 연결', 'success', `피어 연결됨: ${peerId.substr(0, 8)}...`)
        
        // ⭐ 나중에 참여한 피어에게 스트림 전송! (Trystero 공식 패턴)
        if (localStreamRef.current) {
          room.addStream(localStreamRef.current, peerId)
          addTestResult('스트림 재전송', 'success', `피어 ${peerId.substr(0, 8)}...에게 스트림 전송`)
        }
        
        // ICE 연결 상태 모니터링
        monitorIceConnectionState(room)
        
        // 이전 interval 정리
        if (latencyIntervalRef.current) {
          clearInterval(latencyIntervalRef.current)
        }
        
        // 지연시간 측정 시작
        latencyIntervalRef.current = setInterval(() => {
          measureLatency(room, peerId)
        }, 3000)
      })

      room.onPeerLeave((peerId: string) => {
        setConnectedPeers(prev => prev.filter(id => id !== peerId))
        addTestResult('피어 연결', 'running', `피어 연결 해제: ${peerId.substr(0, 8)}...`)
        
        if (connectedPeers.length === 1) {
          setIsConnected(false)
        }
      })

      // 4. 스트림 전송
      addTestResult('스트림 전송', 'running', '미디어 스트림 전송 중...')
      room.addStream(stream)
      addTestResult('스트림 전송', 'success', '미디어 스트림 전송 시작')

      // 5. 원격 스트림 수신
      room.onPeerStream((remoteStream: MediaStream, peerId: string) => {
        console.log('=== 📥 원격 스트림 수신 ===')
        console.log('Peer ID:', peerId)
        console.log('Stream:', remoteStream)
        console.log('Video tracks:', remoteStream.getVideoTracks().map(t => ({
          id: t.id, label: t.label, enabled: t.enabled, muted: t.muted, readyState: t.readyState
        })))
        console.log('Audio tracks:', remoteStream.getAudioTracks().map(t => ({
          id: t.id, label: t.label, enabled: t.enabled, muted: t.muted, readyState: t.readyState
        })))
        
        remoteStreamRef.current = remoteStream
        addTestResult(
          '스트림 수신',
          'success',
          `원격 스트림 수신: ${peerId.substr(0, 8)}... (비디오: ${remoteStream.getVideoTracks().length}, 오디오: ${remoteStream.getAudioTracks().length})`
        )

        // 원격 오디오 분석 초기화
        console.log('🎵 원격 오디오 분석 초기화 시작...')
        initAudioAnalysis(remoteStream, false)

        // 오디오 트랙 확인
        const audioTracks = remoteStream.getAudioTracks()
        if (audioTracks.length > 0) {
          addTestResult(
            '오디오 연결',
            'success',
            `오디오 트랙 활성화: ${audioTracks[0].label} (enabled: ${audioTracks[0].enabled})`
          )
        } else {
          addTestResult('오디오 연결', 'failed', '오디오 트랙을 찾을 수 없습니다')
        }
      })

    } catch (error) {
      let errorMessage = '알 수 없는 오류'
      
      if (error instanceof Error) {
        if (error.name === 'NotReadableError') {
          errorMessage = '⚠️ 마이크/카메라가 다른 앱에서 사용 중입니다. 다른 브라우저나 앱(Zoom, Teams 등)을 종료하고 다시 시도하세요.'
        } else if (error.name === 'NotAllowedError') {
          errorMessage = '⚠️ 카메라/마이크 권한이 거부되었습니다. 브라우저 설정에서 권한을 허용해주세요.'
        } else if (error.name === 'NotFoundError') {
          errorMessage = '⚠️ 카메라/마이크를 찾을 수 없습니다. 장치가 연결되어 있는지 확인하세요.'
        } else {
          errorMessage = `${error.name}: ${error.message}`
        }
      }
      
      addTestResult('테스트 실패', 'failed', errorMessage)
      setIsTestRunning(false) // 오류 발생 시 테스트 중지
    }
  }

  // 테스트 중지
  const stopTest = async () => {
    // 이미 중지 중이면 무시
    if (!isTestRunning) {
      return
    }
    
    try {
      // 애니메이션 프레임 먼저 정리 (오디오 분석 중지)
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
        animationFrameRef.current = undefined
      }

      // 지연시간 측정 interval 정리
      if (latencyIntervalRef.current) {
        clearInterval(latencyIntervalRef.current)
        latencyIntervalRef.current = null
      }

      // Analyser 참조 제거
      localAnalyserRef.current = null
      remoteAnalyserRef.current = null

      // 오디오 컨텍스트 정리
      const audioContext = audioContextRef.current
      if (audioContext && audioContext.state !== 'closed') {
        audioContextRef.current = null // 먼저 참조 제거
        await audioContext.close()
      }

      // Presence에서 자신의 정보 제거
      if (presenceChannelRef.current) {
        await presenceChannelRef.current.untrack()
        supabaseClient.removeChannel(presenceChannelRef.current)
        presenceChannelRef.current = null
      }

      // Room에서 나가기
      if (roomRef.current) {
        await roomRef.current.leave()
        roomRef.current = null
      }

      // 로컬 스트림 정리
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(track => track.stop())
        localStreamRef.current = null
      }

      // 원격 스트림 정리
      if (remoteStreamRef.current) {
        remoteStreamRef.current.getTracks().forEach(track => track.stop())
        remoteStreamRef.current = null
      }

      // 상태 초기화
      setIsTestRunning(false) // 테스트 중지
      setIsConnected(false)
      setConnectedPeers([])
      setIceConnectionState('new')
      setAudioLevels({ local: 0, remote: 0 })
      setLatency(null)
      
      addTestResult('테스트 종료', 'success', '모든 연결이 정리되었습니다')
    } catch (error) {
      console.error('테스트 정리 중 오류:', error)
      addTestResult('테스트 종료', 'failed', `정리 중 오류: ${error}`)
      setIsTestRunning(false) // 오류 발생 시에도 테스트 중지 상태로
    }
  }

  return (
    <div className="connection-test">
      <h2>🧪 WebRTC 연결 테스트</h2>
      
      <div className="test-controls">
        <div className="room-id-section">
          <label>테스트 방 ID:</label>
          <input
            type="text"
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
            disabled={isTestRunning}
          />
          <button onClick={() => {
            const newRoomId = 'test-room-' + Math.random().toString(36).substr(2, 9)
            setRoomId(newRoomId)
          }} disabled={isTestRunning}>
            새 방 ID 생성
          </button>
        </div>
        
        <div className="test-buttons">
          <button 
            onClick={startTest} 
            disabled={isTestRunning}
            className="start-button"
          >
            테스트 시작
          </button>
          <button 
            onClick={stopTest} 
            disabled={!isTestRunning}
            className="stop-button"
          >
            테스트 중지
          </button>
        </div>
      </div>

      <div className="test-status">
        <div className="status-item">
          <span className="status-label">테스트 상태:</span>
          <span className={`status-value ${isTestRunning ? 'connected' : 'disconnected'}`}>
            {isTestRunning ? '🔄 진행 중' : '⚪ 대기'}
          </span>
        </div>
        
        <div className="status-item">
          <span className="status-label">연결 상태:</span>
          <span className={`status-value ${isConnected ? 'connected' : 'disconnected'}`}>
            {isConnected ? '✅ 연결됨' : '⚪ 대기 중'}
          </span>
        </div>
        
        <div className="status-item">
          <span className="status-label">ICE 상태:</span>
          <span className={`status-value ice-${iceConnectionState}`}>
            {iceConnectionState}
          </span>
        </div>
        
        <div className="status-item">
          <span className="status-label">연결된 피어:</span>
          <span className="status-value">{connectedPeers.length}명</span>
        </div>
        
        {latency !== null && (
          <div className="status-item">
            <span className="status-label">지연시간:</span>
            <span className={`status-value latency-${latency < 100 ? 'good' : latency < 300 ? 'ok' : 'bad'}`}>
              {latency}ms
            </span>
          </div>
        )}
      </div>

      {isTestRunning && (
        <div className="audio-meters">
          <div className="audio-meter">
            <label>로컬 오디오 레벨</label>
            <div className="meter-bar">
              <div 
                className="meter-fill local"
                style={{ width: `${audioLevels.local}%` }}
              />
            </div>
            <span className="meter-value">{audioLevels.local.toFixed(1)}%</span>
          </div>
          
          <div className="audio-meter">
            <label>원격 오디오 레벨</label>
            <div className="meter-bar">
              <div 
                className="meter-fill remote"
                style={{ width: `${audioLevels.remote}%` }}
              />
            </div>
            <span className="meter-value">{audioLevels.remote.toFixed(1)}%</span>
          </div>
        </div>
      )}

      <div className="test-results">
        <h3>테스트 결과</h3>
        <div className="results-list">
          {testResults.map((result, index) => (
            <div key={index} className={`result-item ${result.status}`}>
              <span className="result-time">{result.timestamp}</span>
              <span className="result-icon">
                {result.status === 'success' ? '✅' : 
                 result.status === 'failed' ? '❌' : '⏳'}
              </span>
              <span className="result-test">{result.test}:</span>
              <span className="result-message">{result.message}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="test-info">
        <h4>📋 테스트 방법</h4>
        <ol>
          <li>첫 번째 브라우저에서 "테스트 시작" 클릭</li>
          <li>방 ID를 복사</li>
          <li>두 번째 브라우저(또는 시크릿 모드)에서 같은 방 ID 입력</li>
          <li>"테스트 시작" 클릭</li>
          <li>연결 상태와 오디오 레벨 확인</li>
        </ol>
        
        <h4>✅ 확인 항목</h4>
        <ul>
          <li><strong>미디어 스트림:</strong> 카메라/마이크 권한 획득</li>
          <li><strong>Trystero 연결:</strong> Supabase 시그널링 연결</li>
          <li><strong>피어 연결:</strong> P2P 연결 수립</li>
          <li><strong>ICE 상태:</strong> connected 또는 completed 상태 확인</li>
          <li><strong>스트림 수신:</strong> 원격 비디오/오디오 스트림 수신</li>
          <li><strong>오디오 레벨:</strong> 말하면 레벨 미터가 움직이는지 확인</li>
          <li><strong>지연시간:</strong> 100ms 이하면 양호</li>
        </ul>
        
        <h4>⚠️ 테스트 시 주의사항</h4>
        <ul>
          <li><strong>로컬 테스트 (같은 PC):</strong> 
            <ul>
              <li>첫 번째 브라우저만 마이크 사용 가능</li>
              <li>두 번째 브라우저는 "Device in use" 오류 발생 (정상 동작)</li>
              <li>해결: 다른 기기 사용 권장</li>
            </ul>
          </li>
          <li><strong>권장 테스트 환경:</strong>
            <ul>
              <li>PC + 스마트폰 (가장 이상적)</li>
              <li>PC + 노트북</li>
              <li>다른 네트워크 환경 (실제 환경 테스트)</li>
            </ul>
          </li>
          <li><strong>오디오 레벨 확인:</strong>
            <ul>
              <li>로컬: 말하면 즉시 레벨 미터 움직임</li>
              <li>원격: 상대방이 말할 때 레벨 미터 움직임</li>
              <li>둘 다 0%면 Console 로그 (F12) 확인</li>
            </ul>
          </li>
        </ul>
      </div>
    </div>
  )
}

