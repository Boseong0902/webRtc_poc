import { useState, useEffect, useRef } from 'react'
import { joinRoom } from 'trystero/supabase'
import type { Room } from 'trystero'
import { createClient, type RealtimeChannel } from '@supabase/supabase-js'
import ConnectionTest from './components/ConnectionTest'
import './App.css'

// Supabase 설정 (환경 변수에서 가져오기)
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

function App() {
  const [activeTab, setActiveTab] = useState<'app' | 'test'>('app')
  const [isConnected, setIsConnected] = useState(false)
  const [roomId, setRoomId] = useState('')
  const [status, setStatus] = useState('연결 대기 중...')
  const [localVideo, setLocalVideo] = useState<HTMLVideoElement | null>(null)
  const [remoteVideo, setRemoteVideo] = useState<HTMLVideoElement | null>(null)
  
  // Room과 스트림 참조 저장
  const roomRef = useRef<Room | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const presenceChannelRef = useRef<RealtimeChannel | null>(null)

  // 공통 세션 정리 함수 - 한 명이 나가면 나머지도 자동으로 정리
  const cleanupSession = async () => {
    try {
      // 원격 비디오 스트림 정리
      if (remoteVideo && remoteVideo.srcObject) {
        const stream = remoteVideo.srcObject as MediaStream
        stream.getTracks().forEach(track => track.stop())
      }

      // Presence에서 자신의 정보 제거
      if (presenceChannelRef.current) {
        try {
          await presenceChannelRef.current.untrack()
        } catch (e) {
          console.warn('untrack 실패:', e)
        }
        
        try {
          await presenceChannelRef.current.unsubscribe()
        } catch (e) {
          console.warn('unsubscribe 실패:', e)
        }
        
        try {
          supabaseClient.removeChannel(presenceChannelRef.current)
        } catch (e) {
          console.warn('removeChannel 실패:', e)
        }
        
        presenceChannelRef.current = null
      }

      // Room에서 나가기
      if (roomRef.current) {
        try {
          await roomRef.current.leave()
        } catch (e) {
          console.warn('Room leave 실패:', e)
        }
        roomRef.current = null
      }

      // 상태 초기화
      setIsConnected(false)
      setRemoteVideo(null)
    } catch (error) {
      console.error('세션 정리 중 오류:', error)
    }
  }

  useEffect(() => {
    // 로컬 비디오 스트림 초기화
    navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      .then(stream => {
        localStreamRef.current = stream // MediaStream 저장
        const video = document.createElement('video')
        video.srcObject = stream
        video.autoplay = true
        video.muted = true
        setLocalVideo(video)
      })
      .catch(err => {
        console.error('비디오 스트림 가져오기 실패:', err)
        setStatus('비디오 스트림을 가져올 수 없습니다.')
      })

    // Cleanup: 컴포넌트 언마운트 시 스트림 정리
    return () => {
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(track => track.stop())
      }
      if (roomRef.current) {
        roomRef.current.leave()
      }
      if (presenceChannelRef.current) {
        presenceChannelRef.current.untrack()
        supabaseClient.removeChannel(presenceChannelRef.current)
        presenceChannelRef.current = null
      }
    }
  }, [])

  // Trystero Room 설정 공통 함수
  const setupTrysteroRoom = (roomId: string) => {
    // Trystero Supabase 전략을 사용하여 방에 참여
    const room = joinRoom(
      {
        appId: SUPABASE_URL,
        supabaseKey: SUPABASE_ANON_KEY,
        rtcConfig: TURN_CONFIG
      },
      roomId
    )
    
    // Room 객체 저장
    roomRef.current = room

    // 비디오 스트림 공유
    if (localStreamRef.current) {
      room.addStream(localStreamRef.current)  // 모든 피어에게 비디오+오디오 전송
    }

    // 원격 스트림 수신
    room.onPeerStream((stream: MediaStream, peerId: string) => {
      console.log('원격 스트림 수신:', peerId)
      const video = document.createElement('video')
      video.srcObject = stream
      video.autoplay = true
      video.muted = false  // 원격은 음소거 해제! (중요)
      video.playsInline = true  // 모바일 대응
      
      // 명시적으로 재생 시작
      video.play().catch(err => {
        console.error('원격 비디오 재생 실패:', err)
      })
      
      setRemoteVideo(video)
      setStatus(`연결됨 - 상대방: ${peerId}`)
      setIsConnected(true)
    })

    // 피어 연결 이벤트 - ⭐ 나중에 참여한 피어에게 스트림 전송!
    room.onPeerJoin((peerId: string) => {
      console.log('피어 참여:', peerId)
      setStatus(`상대방이 참여했습니다: ${peerId}`)
      
      // 나중에 참여한 피어에게 내 스트림 전송! (Trystero 공식 패턴)
      if (localStreamRef.current) {
        room.addStream(localStreamRef.current, peerId)
      }
    })

    // 피어 떠남 이벤트 - 상대방이 나가면 남은 사람도 바로 세션 종료
    room.onPeerLeave(async (peerId: string) => {
      console.log('피어 떠남:', peerId)
      setStatus('상대방이 떠났습니다. 세션을 종료합니다...')
      
      // 남은 사람도 바로 세션 종료하고 나가기
      await cleanupSession()
      setStatus('상대방이 떠났습니다. 연결이 해제되었습니다.')
    })

    setStatus('방에 성공적으로 연결되었습니다!')
  }

  const connectToRoom = async () => {
    if (!roomId.trim()) {
      setStatus('방 ID를 입력해주세요.')
      return
    }

    try {
      setStatus('방 참여자 수 확인 중...')
      
      // 1. Presence 채널로 현재 참여자 수 확인
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
                // 구독 완료 후 약간의 지연을 두고 상태 확인
                // sync 이벤트가 발생하지 않을 경우를 대비
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

      // 2명 이상이면 참여 거부
      if (participantCount >= 2) {
        setStatus(`방이 가득 찼습니다. (현재 ${participantCount}명 참여 중)`)
        supabaseClient.removeChannel(presenceChannel)
        presenceChannelRef.current = null
        return
      }

      // 참여자 수가 0명이면 기존 세션 정리하고 새로 만들기
      if (participantCount === 0) {
        console.log('참여자 수 0명 - 기존 세션 정리 후 새로 생성')
        setStatus('기존 세션 정리 중...')
        
        // 기존 Presence 채널 완전 정리
        try {
          await presenceChannel.unsubscribe()
          supabaseClient.removeChannel(presenceChannel)
        } catch (e) {
          console.warn('기존 세션 정리 실패:', e)
        }
        
        // 새로운 Presence 채널 생성
        await new Promise(resolve => setTimeout(resolve, 200)) // 정리 완료 대기
        
        const newPresenceChannel = supabaseClient.channel(`room-presence:${roomId}`, {
          config: {
            presence: {
              key: 'userId'
            }
          }
        })
        presenceChannelRef.current = newPresenceChannel
        
        // 새 채널 구독
        await newPresenceChannel.subscribe()
        
        // 새 채널로 참여자 수 다시 확인 (확실하게 0명인지 확인)
        const newParticipantCount = await new Promise<number>((resolve) => {
          newPresenceChannel
            .on('presence', { event: 'sync' }, () => {
              const state = newPresenceChannel.presenceState()
              resolve(Object.keys(state).length)
            })
          setTimeout(() => {
            const state = newPresenceChannel.presenceState()
            resolve(Object.keys(state).length)
          }, 200)
        })
        
        if (newParticipantCount > 0) {
          // 다른 사용자가 먼저 들어온 경우
          setStatus(`방이 가득 찼습니다. (현재 ${newParticipantCount}명 참여 중)`)
          supabaseClient.removeChannel(newPresenceChannel)
          presenceChannelRef.current = null
          return
        }
        
        // 새 세션으로 진행
        setStatus('방에 연결 중...')
        await newPresenceChannel.track({
          userId: `user-${Date.now()}`,
          joinedAt: new Date().toISOString()
        })
        
        // 공통 Room 설정 함수 호출
        setupTrysteroRoom(roomId)
        return
      } else {
        // 1명이 있는 경우 (정상 참여)
        setStatus('방에 연결 중...')
        
        // Presence에 자신의 정보 추가
        await presenceChannel.track({
          userId: `user-${Date.now()}`,
          joinedAt: new Date().toISOString()
        })
      }

      // Trystero Room 설정 (1명이 있는 경우)
      setupTrysteroRoom(roomId)
      
    } catch (error) {
      console.error('방 연결 실패:', error)
      setStatus(`연결 실패: ${error}`)
    }
  }

  const disconnect = async () => {
    try {
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

      // 원격 비디오 정리
      if (remoteVideo && remoteVideo.srcObject) {
        const stream = remoteVideo.srcObject as MediaStream
        stream.getTracks().forEach(track => track.stop())
      }

      // 상태 업데이트
      setIsConnected(false)
      setRemoteVideo(null)
      setStatus('연결이 해제되었습니다.')
      
      console.log('연결 해제 완료')
    } catch (error) {
      console.error('연결 해제 실패:', error)
      setStatus(`연결 해제 실패: ${error}`)
    }
  }

  return (
    <div className="App">
      <header className="App-header">
        <h1>Salang - 화상 통화 매칭</h1>
        <p>WebRTC + Trystero + Supabase + coturn</p>
        
        <div className="tab-navigation">
          <button 
            className={`tab-button ${activeTab === 'app' ? 'active' : ''}`}
            onClick={() => setActiveTab('app')}
          >
            💬 일반 앱
          </button>
          <button 
            className={`tab-button ${activeTab === 'test' ? 'active' : ''}`}
            onClick={() => setActiveTab('test')}
          >
            🧪 연결 테스트
          </button>
        </div>
      </header>

      {activeTab === 'test' ? (
        <ConnectionTest />
      ) : (
      <>
      <main className="App-main">
        <div className="connection-panel">
          <h2>연결 설정</h2>
          <div className="input-group">
            <label htmlFor="roomId">방 ID:</label>
            <input
              id="roomId"
              type="text"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
              placeholder="방 ID를 입력하세요"
              disabled={isConnected}
            />
          </div>
          
          <div className="button-group">
            <button 
              onClick={connectToRoom} 
              disabled={isConnected}
            >
              방에 참여
            </button>
            <button 
              onClick={disconnect} 
              disabled={!isConnected}
            >
              연결 해제
            </button>
          </div>
          
          <div className="status">
            <strong>상태:</strong> {status}
          </div>
        </div>

        <div className="video-container">
          <div className="video-panel">
            <h3>내 비디오</h3>
            <div className="video-wrapper">
              {localVideo && (
                <video
                  ref={(el) => {
                    if (el && localVideo.srcObject) {
                      el.srcObject = localVideo.srcObject
                      el.autoplay = true
                      el.muted = true  // 로컬은 음소거 (에코 방지)
                      el.playsInline = true  // 모바일 대응
                      el.play().catch(e => console.log('로컬 비디오 재생 실패:', e))
                    }
                  }}
                  style={{ width: '100%', height: 'auto' }}
                />
              )}
            </div>
          </div>

          <div className="video-panel">
            <h3>상대방 비디오</h3>
            <div className="video-wrapper">
              {remoteVideo ? (
                <video
                  ref={(el) => {
                    if (el && remoteVideo.srcObject) {
                      el.srcObject = remoteVideo.srcObject
                      el.autoplay = true
                      el.muted = false  // 원격은 음소거 해제!
                      el.playsInline = true  // 모바일 대응
                      el.play().catch(e => console.log('원격 비디오 재생 실패:', e))
                    }
                  }}
                  style={{ width: '100%', height: 'auto' }}
                />
              ) : (
                <div className="no-video">
                  상대방 비디오 대기 중...
                </div>
              )}
            </div>
          </div>
        </div>
      </main>

      <footer className="App-footer">
        <div className="config-info">
          <h3>설정 정보</h3>
          <ul>
            <li><strong>Supabase URL:</strong> {SUPABASE_URL}</li>
            <li><strong>TURN Server:</strong> localhost:3478</li>
            <li><strong>전략:</strong> Trystero + Supabase SaaS + coturn</li>
          </ul>
        </div>
      </footer>
      </>
      )}
    </div>
  )
}

export default App
