/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useMemo, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Trophy, 
  Users, 
  User, 
  ArrowLeft, 
  CheckCircle2, 
  XCircle, 
  RefreshCcw,
  BookOpen,
  Calculator,
  ChevronRight,
  GraduationCap,
  Sword,
  Flame,
  Shield,
  Star,
  Medal,
  History,
  SendHorizontal,
  Zap,
  Ghost,
  Skull,
  Heart,
  Sparkles,
  Snowflake,
  Dices,
  Copy,
  Trash2
} from 'lucide-react';
import { doc, onSnapshot } from 'firebase/firestore';
import { 
  Question, 
  GameMode, 
  Screen,
  RPGStats,
  ScoreEntry
} from './types';
import { QUESTION_POOL } from './data/questions';
import { 
  saveScore, 
  getLeaderboard, 
  createRoom, 
  checkRoomExists,
  checkRoomPassword,
  syncPlayerProgress,
  subscribeRoomLeaderboard,
  deleteScore,
  deleteAllScoresInRoom,
  db
} from './lib/firebase';

// Helper to shuffle array
const shuffle = <T,>(array: T[]): T[] => [...array].sort(() => Math.random() - 0.5);

const generateGradedQuestions = (pool: Question[], count = 10): Question[] => {
  const questions: Question[] = [];
  const byDiff: Record<number, Question[]> = { 1: [], 2: [], 3: [], 4: [], 5: [] };
  
  pool.forEach(q => {
    const diff = q.difficulty || 1;
    if (byDiff[diff]) {
      byDiff[diff].push(q);
    } else {
      byDiff[1].push(q);
    }
  });

  for (let d = 1; d <= 5; d++) {
    if (byDiff[d].length === 0) {
      byDiff[d] = [...pool];
    }
  }

  const allocation = [0, 0, 0, 0, 0];
  let remaining = count;
  let dIdx = 0;
  while (remaining > 0) {
    allocation[dIdx]++;
    remaining--;
    dIdx = (dIdx + 1) % 5;
  }

  for (let d = 1; d <= 5; d++) {
    const numToSelect = allocation[d - 1];
    const shuffledDiff = shuffle(byDiff[d]);
    const selectedQuestions = shuffledDiff.slice(0, numToSelect);
    
    // Shuffle the options within each question to ensure randomized visual slots
    const processed = selectedQuestions.map((originalQ) => {
      const originalOptions = [...originalQ.o];
      const correctAnswerText = originalOptions[originalQ.a];
      const shuffledOptions = shuffle(originalOptions);
      const newAnswerIdx = shuffledOptions.indexOf(correctAnswerText);
      return {
        ...originalQ,
        o: shuffledOptions,
        a: newAnswerIdx === -1 ? 0 : newAnswerIdx
      };
    });

    questions.push(...processed);
  }
  
  return questions;
};

const generateId = (): string => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz23456789'; // alphanumeric safe
  let res = '';
  for (let i = 0; i < 20; i++) {
    res += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return res;
};

const getTitle = (level: number) => {
  if (level >= 10) return '수학의 성자 (Saint)';
  if (level >= 8) return '비율의 마스터 (Master)';
  if (level >= 5) return '비 계산의 영웅 (Hero)';
  if (level >= 3) return '모험가 (Adventurer)';
  return '견습생 (Novice)';
};

const MONSTERS = [
  { name: '슬라임', icon: Ghost, color: 'text-green-400' },
  { name: '스켈레톤', icon: Skull, color: 'text-slate-300' },
  { name: '파이어 스피릿', icon: Flame, color: 'text-orange-500' },
  { name: '쉐도우 몬스터', icon: Ghost, color: 'text-purple-500' },
  { name: '골렘', icon: Snowflake, color: 'text-blue-300' },
];

export default function App() {
  const [screen, setScreen] = useState<Screen>('main');
  const [mode, setMode] = useState<GameMode>('single');
  const [groupSize, setGroupSize] = useState<number>(2);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [singleScore, setSingleScore] = useState(0);
  const [playerScores, setPlayerScores] = useState<number[]>([]);
  const [feedback, setFeedback] = useState<{ isCorrect: boolean; show: boolean } | null>(null);
  const [playerName, setName] = useState('');
  const [vsNames, setVsNames] = useState<[string, string]>(['용사 1', '용사 2']);
  const [leaderboard, setLeaderboards] = useState<ScoreEntry[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [studentRoomCode, setStudentRoomCode] = useState('');
  const [teacherRoomCode, setTeacherRoomCode] = useState('');
  const [activeRoom, setActiveRoom] = useState<string | null>(null);
  const [teacherName, setTeacherName] = useState('');
  const [roomToView, setRoomToView] = useState('');
  const [currentScoreId, setCurrentScoreId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [enteredPassword, setEnteredPassword] = useState('');
  const [hasUploaded, setHasUploaded] = useState(false);
  const [roomPassword, setRoomPassword] = useState(''); // for room creation
  const [enteredRoomPassword, setEnteredRoomPassword] = useState(''); // for viewing existing room
  
  // Dungeon specific state
  const [playerHp, setPlayerHp] = useState(100);
  const [monsterHp, setMonsterHp] = useState(100);
  const [p1Hp, setP1Hp] = useState(100);
  const [p2Hp, setP2Hp] = useState(100);
  const [isAttacking, setIsAttacking] = useState(false);
  const [isBeingHit, setIsBeingHit] = useState(false);

  // Computed
  const currentPlayerInVs = useMemo(() => {
    return (currentIndex % 2) + 1;
  }, [currentIndex]);

  const currentMonster = useMemo(() => {
    return MONSTERS[currentIndex % MONSTERS.length];
  }, [currentIndex]);

  // Computed RPG Stats
  const stats: RPGStats = useMemo(() => {
    const score = mode === 'single' ? singleScore : playerScores.reduce((a, b) => a + b, 0);
    const xp = score * 125;
    const level = Math.floor(xp / 500) + 1;
    return {
      level,
      xp,
      title: getTitle(level),
      power: score * 10,
      wisdom: level * 15
    };
  }, [singleScore, playerScores, mode]);

  const currentPlayer = useMemo(() => {
    if (mode === 'single') return null;
    return (currentIndex % groupSize) + 1;
  }, [currentIndex, groupSize, mode]);

  const totalGroupScore = useMemo(() => {
    return playerScores.reduce((acc, curr) => acc + curr, 0);
  }, [playerScores]);

  // Real-time progress synchronization with the teacher's dashboard
  useEffect(() => {
    if (activeRoom && currentScoreId && playerName.trim() && (screen === 'student-lobby' || screen === 'game' || screen === 'result')) {
      const uploader = async () => {
        const scoreVal = mode === 'single' ? singleScore : (mode === 'versus' ? playerScores[1] : totalGroupScore);
        try {
          await syncPlayerProgress(currentScoreId, {
            name: playerName,
            score: scoreVal,
            level: stats.level,
            mode,
            roomCode: activeRoom
          });
          setHasUploaded(true);
          console.log("Real-time score sync completed:", scoreVal);
        } catch (e) {
          console.error("Real-time score sync failed:", e);
        }
      };
      const timer = setTimeout(uploader, 300);
      return () => clearTimeout(timer);
    }
  }, [screen, activeRoom, currentScoreId, playerName, singleScore, playerScores, mode, stats.level, totalGroupScore]);

  // Listen to current score document to detect if teacher deleted it
  useEffect(() => {
    if (activeRoom && currentScoreId && hasUploaded && (screen === 'student-lobby' || screen === 'game' || screen === 'result')) {
      const docRef = doc(db, 'leaderboard', currentScoreId);
      const unsubscribe = onSnapshot(docRef, (snap) => {
        if (!snap.exists()) {
          setActiveRoom(null);
          setCurrentScoreId(null);
          setHasUploaded(false);
          alert('선생님이 대시보드에서 기록을 삭제하여 연결이 해제되었습니다.');
          setScreen('main');
        }
      }, (err) => {
        console.error("Error listening to score document:", err);
      });
      return () => unsubscribe();
    }
  }, [activeRoom, currentScoreId, hasUploaded, screen]);

  // Synchronize teacher classroom dashboard in real-time
  useEffect(() => {
    if (screen === 'teacher-dashboard' && roomToView.trim()) {
      const unsubscribe = subscribeRoomLeaderboard(roomToView, (results) => {
        setLeaderboards(results);
      });
      return () => unsubscribe();
    }
  }, [screen, roomToView]);

  // Actions
  const goMain = useCallback(() => {
    setScreen('main');
    setCurrentIndex(0);
    setSingleScore(0);
    setFeedback(null);
    // Keep name cached for seamless replay experiences
    setPlayerHp(100);
    setCurrentScoreId(null);
    setHasUploaded(false);
    setEnteredPassword('');
    setRoomPassword('');
    setEnteredRoomPassword('');
  }, []);

  const handleTeacherAuth = () => {
    if (enteredPassword === '1234') {
      setScreen('teacher');
      setEnteredPassword('');
    } else {
      alert('비밀번호가 올바르지 않습니다.');
    }
  };

  const openRanking = async () => {
    setScreen('ranking');
    const data = await getLeaderboard(mode);
    setLeaderboards(data);
  };

  const startSingleMode = useCallback(() => {
    setMode('single');
    // Ensure we have a score tracker ID
    if (!currentScoreId) {
      setCurrentScoreId(generateId());
    }
    const graded = generateGradedQuestions(QUESTION_POOL, 10);
    setQuestions(graded);
    setSingleScore(0);
    setCurrentIndex(0);
    setPlayerHp(100);
    setMonsterHp(100);
    setScreen('game');
  }, [currentScoreId]);

  const showGroupSetup = useCallback(() => {
    setScreen('setup');
  }, []);

  const startGroupMode = useCallback(() => {
    setMode('group');
    if (!currentScoreId) {
      setCurrentScoreId(generateId());
    }
    const questionsPerPerson = 10;
    const totalCount = groupSize * questionsPerPerson;
    
    const graded = generateGradedQuestions(QUESTION_POOL, totalCount);
    
    setQuestions(graded);
    setPlayerScores(new Array(groupSize + 1).fill(0));
    setCurrentIndex(0);
    setPlayerHp(100);
    setMonsterHp(100);
    setScreen('game');
  }, [groupSize, currentScoreId]);

  const startVsMode = useCallback(() => {
    setMode('versus');
    if (!currentScoreId) {
      setCurrentScoreId(generateId());
    }
    const totalQuestions = 10; // 5 each
    const graded = generateGradedQuestions(QUESTION_POOL, totalQuestions);
    setQuestions(graded);
    setCurrentIndex(0);
    setP1Hp(100);
    setP2Hp(100);
    setPlayerScores(new Array(3).fill(0));
    setScreen('game');
  }, [currentScoreId]);

  const handleAnswer = (selectedIdx: number) => {
    if (feedback?.show) return;

    const q = questions[currentIndex];
    const isCorrect = selectedIdx === q.a;

    setFeedback({ isCorrect, show: true });

    if (isCorrect) {
      setIsAttacking(true);
      if (mode === 'versus') {
        if (currentPlayerInVs === 1) setP2Hp(prev => Math.max(0, prev - 20));
        else setP1Hp(prev => Math.max(0, prev - 20));
      } else {
        setMonsterHp(0);
      }
    } else {
      setIsBeingHit(true);
      if (mode === 'versus') {
        if (currentPlayerInVs === 1) setP1Hp(prev => Math.max(0, prev - 20));
        else setP2Hp(prev => Math.max(0, prev - 20));
      } else {
        setPlayerHp(prev => Math.max(0, prev - 20));
      }
    }

    const nextP1Hp = mode === 'versus' ? (isCorrect ? (currentPlayerInVs === 2 ? p1Hp : p1Hp) : (currentPlayerInVs === 1 ? Math.max(0, p1Hp - 20) : p1Hp)) : playerHp;
    const nextP2Hp = mode === 'versus' ? (isCorrect ? (currentPlayerInVs === 1 ? p2Hp : p2Hp) : (currentPlayerInVs === 2 ? Math.max(0, p2Hp - 20) : p2Hp)) : monsterHp;
    
    // Adjust nextP1/P2 if it was an attack
    const finalP1Hp = isCorrect && mode === 'versus' && currentPlayerInVs === 2 ? Math.max(0, p1Hp - 20) : nextP1Hp;
    const finalP2Hp = isCorrect && mode === 'versus' && currentPlayerInVs === 1 ? Math.max(0, p2Hp - 20) : nextP2Hp;

    setTimeout(() => {
      setIsAttacking(false);
      setIsBeingHit(false);

      if (isCorrect) {
        if (mode === 'single') {
          setSingleScore(prev => prev + 1);
        } else if (mode === 'group') {
          setPlayerScores(prev => {
            const next = [...prev];
            const playerNum = (currentIndex % groupSize) + 1;
            next[playerNum]++;
            return next;
          });
        } else if (mode === 'versus') {
          setPlayerScores(prev => {
            const next = [...prev];
            next[currentPlayerInVs]++;
            return next;
          });
        }
      }

      const isGameOver = mode === 'versus' 
        ? (finalP1Hp <= 0 || finalP2Hp <= 0 || currentIndex + 1 >= questions.length) 
        : (currentIndex + 1 >= questions.length || (isCorrect ? false : (playerHp - 20 <= 0)));

      if (!isGameOver) {
        setCurrentIndex(prev => prev + 1);
        setMonsterHp(100);
        setFeedback(null);
      } else {
        setScreen('result');
      }
    }, 1000);
  };

  const submitScore = async () => {
    if (!playerName.trim() || isSaving) return;
    setIsSaving(true);
    try {
      await saveScore({
        name: playerName,
        score: mode === 'single' ? singleScore : (mode === 'versus' ? playerScores[1] : totalGroupScore),
        level: stats.level,
        mode,
        roomCode: activeRoom || undefined
      });
      if (activeRoom) {
        alert('데이터가 교사에게 성공적으로 전송되었습니다.');
      }
      await openRanking();
    } catch (err) {
      alert('점수 저장에 실패했습니다.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleCreateRoom = useCallback(async () => {
    if (!teacherRoomCode.trim() || !teacherName.trim()) {
      alert('선생님 성함과 생성할 방 코드를 모두 입력해주세요.');
      return;
    }
    
    setIsSaving(true);
    try {
      const exists = await checkRoomExists(teacherRoomCode);
      if (exists) {
        const isCorrectPassword = await checkRoomPassword(teacherRoomCode, roomPassword);
        if (!isCorrectPassword) {
          alert('이미 존재하는 방 코드이지만, 입력하신 비밀번호가 올바르지 않습니다. 다른 방 코드를 사용하시거나 올바른 비밀번호를 입력해주세요.');
          setIsSaving(false);
          return;
        }
        alert('기존 방 비밀번호가 일치하여 대시보드에 정상 진입합니다.');
      } else {
        await createRoom(teacherRoomCode, teacherName, roomPassword);
        alert(`🎉 [${teacherRoomCode}] 던전 상황실이 생성되었습니다! 설정하신 비밀번호는 추후 상황실 진입 및 데이터 조회 시 필요합니다.`);
      }

      setRoomToView(teacherRoomCode);
      setLeaderboards([]); 
      const results = await getLeaderboard('single', teacherRoomCode);
      setLeaderboards(results);
      setScreen('teacher-dashboard');
    } catch (err) {
      console.error("Room creation error:", err);
      alert('방 개설/진입 중 오류가 발생했습니다.');
    } finally {
      setIsSaving(false);
    }
  }, [teacherRoomCode, teacherName, roomPassword]);

  const handleJoinRoom = useCallback(async () => {
    if (!studentRoomCode.trim()) {
      alert('입력된 방 코드가 없습니다.');
      return;
    }
    setIsSaving(true);
    try {
      const exists = await checkRoomExists(studentRoomCode);
      if (exists) {
        setActiveRoom(studentRoomCode);
        setRoomToView(studentRoomCode);
        setScreen('student-lobby');
        // Generate currentScoreId immediately upon joining the room
        setCurrentScoreId(generateId());
        alert(`🎉 ${studentRoomCode} 던전(학습방)에 연결되었습니다! 이름을 정하고 퀘스트를 도전하세요!`);
      } else {
        alert('해당 방 코드를 찾을 수 없습니다. 코드를 다시 확인해주세요.');
      }
    } catch (err) {
      console.error("Join room error:", err);
      alert('방 접속 중 오류가 발생했습니다.');
    } finally {
      setIsSaving(false);
    }
  }, [studentRoomCode]);

  const viewRoomData = useCallback(async () => {
    if (!roomToView.trim()) {
      alert('조회할 방 코드를 입력해주세요.');
      return;
    }
    setIsSaving(true);
    try {
      const exists = await checkRoomExists(roomToView);
      if (!exists) {
        alert('존재하지 않는 방 코드입니다.');
        setIsSaving(false);
        return;
      }

      const isCorrectPassword = await checkRoomPassword(roomToView, enteredRoomPassword);
      if (!isCorrectPassword) {
        alert('방 비밀번호가 올바르지 않습니다.');
        setIsSaving(false);
        return;
      }

      const results = await getLeaderboard('single', roomToView);
      setLeaderboards(results);
      setScreen('teacher-dashboard');
    } catch (err) {
      console.error("View room error:", err);
      alert('방 데이터 조회 중 오류가 발생했습니다.');
    } finally {
      setIsSaving(false);
    }
  }, [roomToView, enteredRoomPassword]);

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-2xl">
        <AnimatePresence mode="wait">
          {screen === 'main' && (
            <motion.div
              key="main"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 1.2 }}
              className="card text-center relative overflow-hidden"
            >
              <div className="absolute -top-12 -right-12 p-8 opacity-5 rotate-12 text-blue-500">
                <Sword size={240} />
              </div>
              <div className="absolute -bottom-12 -left-12 p-8 opacity-5 -rotate-12 text-red-500">
                <Skull size={240} />
              </div>
              
              <div className="flex justify-center mb-6">
                <motion.div 
                  animate={{ y: [0, -10, 0] }}
                  transition={{ repeat: Infinity, duration: 2, ease: "easeInOut" }}
                  className="p-6 bg-slate-800 rounded-full border-4 border-slate-700 shadow-[0_0_30px_rgba(58,134,255,0.3)]"
                >
                  <Sword className="text-white w-12 h-12" />
                </motion.div>
              </div>

              <div className="inline-block px-4 py-1 bg-brand/20 text-brand text-[10px] font-black rounded-full mb-4 uppercase tracking-[0.2em] border border-brand/30">
                Dungeon of Proportions
              </div>

              <h1 className="text-4xl sm:text-6xl font-black text-white mb-2 tracking-tighter drop-shadow-lg">
                비와 비율 던전
              </h1>
              <p className="text-slate-400 mb-10 font-bold">몬스터를 처치하고 최강의 수학 전사가 되세요!</p>

              <div className="grid sm:grid-cols-2 gap-6">
                <button 
                  onClick={startSingleMode}
                  className="btn-primary group flex flex-col items-center gap-4 p-8"
                >
                  <Sword size={32} />
                  <div className="text-xl font-black tracking-tight">솔로 레이드 (1인)</div>
                  <div className="text-xs font-medium opacity-70">10개의 던전 룸 돌파</div>
                </button>
                <button 
                  onClick={showGroupSetup}
                  className="btn-secondary group flex flex-col items-center gap-4 p-8"
                >
                  <Users size={32} />
                  <div className="text-xl font-black tracking-tight">연합 길드 (모둠)</div>
                  <div className="text-xs font-medium opacity-70">모두 함께 힘을 합쳐 클리어</div>
                </button>
                <button 
                  onClick={() => setScreen('setup-vs')}
                  className="btn-primary bg-orange-600 border-orange-700 shadow-orange-900/20 group flex flex-col items-center gap-4 p-8 sm:col-span-1"
                >
                  <Zap size={32} />
                  <div className="text-xl font-black tracking-tight">아레나 대결</div>
                  <div className="text-xs font-medium opacity-70">실력 겨루기</div>
                </button>
                <button 
                  onClick={() => setScreen('teacher-auth')}
                  className="btn-secondary bg-purple-600 border-purple-700 shadow-purple-900/20 group flex flex-col items-center gap-4 p-8 sm:col-span-1"
                >
                  <GraduationCap size={32} />
                  <div className="text-xl font-black tracking-tight">교사용 도구</div>
                  <div className="text-xs font-medium opacity-70">방 생성 및 데이터 관리</div>
                </button>
              </div>

              <div className="mt-8 flex flex-col items-center gap-4">
                {activeRoom ? (
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="w-full max-w-sm p-4 bg-green-500/10 border-2 border-green-500/30 rounded-2xl flex items-center justify-between shadow-lg shadow-green-900/10"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 bg-green-500 rounded-lg flex items-center justify-center text-white">
                        <CheckCircle2 size={18} />
                      </div>
                      <div>
                        <div className="text-[10px] font-black text-green-400 uppercase tracking-widest">분대 연결됨 (Connected)</div>
                        <div className="text-sm font-black text-white">{activeRoom}</div>
                      </div>
                    </div>
                    <button 
                      onClick={() => setActiveRoom(null)}
                      className="text-[10px] font-bold text-slate-500 hover:text-white uppercase transition-colors"
                    >
                      Disconnect
                    </button>
                  </motion.div>
                ) : (
                  <div className="flex flex-col items-center gap-4 w-full">
                    <div className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">
                      교사가 준 코드가 있다면 입력하세요 (권장)
                    </div>
                    <div className="flex gap-2 w-full max-w-sm">
                      <input 
                        placeholder="방 코드 (예: 6-1-수학)"
                        value={studentRoomCode}
                        onChange={(e) => setStudentRoomCode(e.target.value)}
                        className="flex-1 bg-slate-800 p-3 rounded-lg border border-slate-700 text-white text-sm font-bold font-mono outline-none focus:border-brand shadow-inner"
                      />
                      <button 
                        onClick={handleJoinRoom}
                        disabled={isSaving}
                        className="bg-brand text-white px-6 py-2 rounded-lg text-sm font-black hover:brightness-110 active:scale-95 transition-all shadow-lg shadow-brand/20 disabled:opacity-50"
                      >
                        {isSaving ? '...' : '연결'}
                      </button>
                    </div>
                    <div className="text-[9px] text-slate-600 font-bold text-center">
                      코드를 입력하지 않으면 선생님이 결과를 확인할 수 없습니다.
                    </div>
                  </div>
                )}
              </div>

              <button 
                onClick={() => { setMode('single'); openRanking(); }}
                className="mt-8 text-slate-500 hover:text-white font-black flex items-center justify-center gap-2 transition-colors uppercase text-xs tracking-widest"
              >
                <Medal size={16} /> Legendary Ranking
              </button>
            </motion.div>
          )}

          {screen === 'student-lobby' && (
            <motion.div
              key="student-lobby"
              initial={{ opacity: 0, y: 50 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -50 }}
              className="card text-center"
            >
              <div className="flex items-center justify-between mb-8">
                 <button onClick={goMain} className="p-3 bg-slate-800 text-slate-400 hover:text-white rounded-xl transition-all">
                    <ArrowLeft size={18} /> Back
                 </button>
                 <div className="px-4 py-1.5 bg-green-500/10 border border-green-500/30 rounded-full text-[10px] font-black text-green-400 uppercase tracking-widest animate-pulse">
                   연결됨: {activeRoom} 📍
                 </div>
                 <div className="w-10" />
              </div>

              <div className="flex justify-center mb-6">
                 <div className="p-5 bg-green-500/10 rounded-full border-4 border-green-500/40 shadow-[0_0_20px_rgba(34,197,94,0.2)]">
                   <Users className="text-green-400 w-10 h-10" />
                 </div>
              </div>

              <h2 className="text-2xl sm:text-3xl font-black text-white mb-2 tracking-tighter">
                {activeRoom} 분대 대기실
              </h2>
              <p className="text-slate-400 text-sm font-bold mb-8">
                선생님 대시보드에 연동되었습니다. 참여할 영웅의 이름을 등록하세요!
              </p>

              <div className="dungeon-panel border-green-500/30 mb-8 text-left">
                  <label className="block text-[10px] font-black text-green-400 uppercase tracking-widest mb-3">실명 입력 (선생님이 확인할 수 있는 이름)</label>
                  <input 
                    value={playerName}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="예: 홍길동 (3학년 1반)"
                    className="w-full bg-slate-900 p-4 rounded-xl border-2 border-slate-700 outline-none focus:border-green-500 transition-all text-lg font-black text-white placeholder-slate-600"
                  />
              </div>

              <div className="space-y-4">
                 <div className="text-xs text-slate-500 font-bold uppercase tracking-wider mb-2">원하는 길드 퀘스트를 선택해 터치하세요!</div>
                 <button 
                   onClick={() => {
                     if (!playerName.trim()) { alert('이름을 먼저 입력해야 모험을 시작할 수 있습니다!'); return; }
                     startSingleMode();
                   }}
                   className={`w-full p-5 rounded-2xl border-2 flex items-center justify-between transition-all group text-left ${
                     playerName.trim() 
                       ? 'border-brand bg-brand/10 text-white cursor-pointer shadow-lg shadow-brand/10' 
                       : 'border-slate-800 bg-slate-900/40 text-slate-600 opacity-60'
                   }`}
                 >
                    <div className="flex items-center gap-4">
                      <div className={`p-3 rounded-xl ${playerName.trim() ? 'bg-brand text-white' : 'bg-slate-800 text-slate-600'}`}>
                         <Sword size={22} />
                      </div>
                      <div>
                         <div className="font-black text-lg">솔로 레이드 (1인 공략)</div>
                         <div className="text-xs opacity-70">비와 비율 던전의 10개 룸을 혼자서 차례로 돌파합니다.</div>
                      </div>
                    </div>
                    <ChevronRight size={20} className="opacity-40 group-hover:translate-x-1 transition-transform" />
                 </button>

                 <button 
                   onClick={() => {
                     if (!playerName.trim()) { alert('이름을 먼저 입력해야 모험을 시작할 수 있습니다!'); return; }
                     showGroupSetup();
                   }}
                   className={`w-full p-5 rounded-2xl border-2 flex items-center justify-between transition-all group text-left ${
                     playerName.trim() 
                       ? 'border-accent bg-accent/10 text-white cursor-pointer shadow-lg shadow-accent/10' 
                       : 'border-slate-800 bg-slate-900/40 text-slate-600 opacity-60'
                   }`}
                 >
                    <div className="flex items-center gap-4">
                      <div className={`p-3 rounded-xl ${playerName.trim() ? 'bg-accent text-white' : 'bg-slate-800 text-slate-600'}`}>
                         <Users size={22} />
                      </div>
                      <div>
                         <div className="font-black text-lg">연합 길드 (모둠 협동)</div>
                         <div className="text-xs opacity-70">모둠을 이루어 함께 힘을 합쳐 던전 게이트를 통과합니다.</div>
                      </div>
                    </div>
                    <ChevronRight size={20} className="opacity-40 group-hover:translate-x-1 transition-transform" />
                 </button>

                 <button 
                   onClick={() => {
                     if (!playerName.trim()) { alert('이름을 먼저 입력해야 모험을 시작할 수 있습니다!'); return; }
                     setScreen('setup-vs');
                     setVsNames([playerName, '투사 2']);
                   }}
                   className={`w-full p-5 rounded-2xl border-2 flex items-center justify-between transition-all group text-left ${
                     playerName.trim() 
                       ? 'border-orange-500 bg-orange-500/10 text-white cursor-pointer shadow-lg shadow-orange-500/10' 
                       : 'border-slate-800 bg-slate-900/40 text-slate-600 opacity-60'
                   }`}
                 >
                    <div className="flex items-center gap-4">
                      <div className={`p-3 rounded-xl ${playerName.trim() ? 'bg-orange-500 text-white' : 'bg-slate-800 text-slate-600'}`}>
                         <Zap size={22} />
                      </div>
                      <div>
                         <div className="font-black text-lg">아레나 대결 (실력 겨루기)</div>
                         <div className="text-xs opacity-70">다른 차원의 용사 또는 라이벌과 수학 결투를 펼칩니다.</div>
                      </div>
                    </div>
                    <ChevronRight size={20} className="opacity-40 group-hover:translate-x-1 transition-transform" />
                 </button>
              </div>
            </motion.div>
          )}

          {screen === 'setup' && (
            <motion.div
              key="setup"
              initial={{ opacity: 0, x: 100 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -100 }}
              className="card"
            >
              <button onClick={goMain} className="mb-8 flex items-center gap-2 text-slate-400 hover:text-white transition-colors font-bold uppercase text-xs">
                <ArrowLeft size={16} /> Back to Camp
              </button>

              <div className="text-center mb-8">
                <h2 className="text-3xl font-black text-white mb-2 uppercase tracking-tighter">길드 파티 결성</h2>
                <p className="text-slate-500">함께 던전을 공략할 인원을 모집합니다.</p>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-8">
                {[2, 3, 4, 5, 6].map(size => (
                  <button
                    key={size}
                    onClick={() => setGroupSize(size)}
                    className={`p-4 rounded-2xl border-2 transition-all group ${
                      groupSize === size 
                        ? 'border-accent bg-accent/20 text-white shadow-[0_0_15px_rgba(255,0,110,0.3)]' 
                        : 'border-slate-800 bg-slate-900/50 text-slate-500 hover:border-slate-600'
                    }`}
                  >
                    <div className="text-2xl font-black mb-1">{size}명</div>
                    <div className="text-[10px] font-bold opacity-60 uppercase tracking-tighter">{size * 10} Rooms</div>
                  </button>
                ))}
              </div>

              <button 
                onClick={startGroupMode}
                className="w-full btn-secondary py-5 text-xl font-black uppercase tracking-widest"
              >
                게이트 열기 (Start)
              </button>
            </motion.div>
          )}

          {screen === 'setup-vs' && (
            <motion.div
              key="setup-vs"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              className="card"
            >
              <button onClick={goMain} className="mb-8 flex items-center gap-2 text-slate-400 hover:text-white transition-colors font-bold uppercase text-xs">
                <ArrowLeft size={16} /> Exit Arena
              </button>

              <div className="text-center mb-10">
                <div className="w-16 h-16 bg-orange-500/20 text-orange-500 rounded-2xl flex items-center justify-center mx-auto mb-4 border-2 border-orange-500/30">
                   <Zap size={32} />
                </div>
                <h2 className="text-3xl font-black text-white mb-2 uppercase tracking-tighter">아레나 대진표</h2>
                <p className="text-slate-500 font-bold">승리할 팀 또는 참가자의 이름을 입력하세요.</p>
              </div>

              <div className="space-y-6 mb-10">
                <div className="dungeon-panel border-blue-500/30">
                   <label className="block text-[10px] font-black text-blue-400 uppercase tracking-widest mb-2">Team / Player 1</label>
                   <input 
                     value={vsNames[0]}
                     onChange={(e) => setVsNames([e.target.value, vsNames[1]])}
                     className="w-full bg-slate-900 p-4 rounded-xl border border-slate-700 outline-none focus:border-blue-500 transition-all font-bold text-white text-xl"
                   />
                </div>
                <div className="flex justify-center -my-2 relative z-10">
                  <div className="bg-slate-800 text-slate-500 font-black px-4 py-2 rounded-full border border-slate-700 text-lg uppercase italic">VS</div>
                </div>
                <div className="dungeon-panel border-red-500/30">
                   <label className="block text-[10px] font-black text-red-400 uppercase tracking-widest mb-2">Team / Player 2</label>
                   <input 
                     value={vsNames[1]}
                     onChange={(e) => setVsNames([vsNames[0], e.target.value])}
                     className="w-full bg-slate-900 p-4 rounded-xl border border-slate-700 outline-none focus:border-red-500 transition-all font-bold text-white text-xl"
                   />
                </div>
              </div>

              <button 
                onClick={startVsMode}
                className="w-full btn-primary bg-orange-600 border-orange-700 py-6 text-2xl font-black uppercase tracking-widest"
              >
                결투 시작! (FIGHT)
              </button>
            </motion.div>
          )}

          {screen === 'game' && (
            <motion.div
              key="game"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="card min-h-[650px] flex flex-col p-6 sm:p-10"
            >
              {/* Top HUD */}
              <div className="flex justify-between items-start mb-8">
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2 text-blue-400 font-black text-xs uppercase tracking-widest">
                    {mode === 'versus' ? vsNames[0] : `Hero Level ${stats.level}`} {mode !== 'versus' && <User size={14} />}
                  </div>
                  <div className="w-32 sm:w-48 h-3 bg-slate-800 rounded-full border border-slate-700 overflow-hidden">
                    <motion.div 
                      className="h-full bg-blue-500 shadow-[0_0_10px_rgba(59,130,246,0.5)]"
                      initial={{ width: "100%" }}
                      animate={{ width: `${mode === 'versus' ? p1Hp : playerHp}%` }}
                    />
                  </div>
                  <div className="text-[10px] font-bold text-slate-500 uppercase">HP: {mode === 'versus' ? p1Hp : playerHp}/100</div>
                </div>

                <div className="text-center bg-slate-800/80 px-4 py-2 rounded-xl border border-slate-700">
                  <div className="text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1">Room {currentIndex + 1}</div>
                  <div className="text-xl font-black text-white">{questions.length - currentIndex} Left</div>
                </div>

                <div className="flex flex-col items-end gap-2 text-right">
                  <div className="flex items-center gap-2 text-red-400 font-black text-xs uppercase tracking-widest">
                    {mode === 'versus' ? vsNames[1] : currentMonster.name} {mode !== 'versus' && <Skull size={14} />}
                  </div>
                  <div className="w-32 sm:w-48 h-3 bg-slate-800 rounded-full border border-slate-700 overflow-hidden">
                    <motion.div 
                      className="h-full bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.5)]"
                      initial={{ width: "100%" }}
                      animate={{ width: `${mode === 'versus' ? p2Hp : monsterHp}%` }}
                    />
                  </div>
                  <div className="text-[10px] font-bold text-slate-500 uppercase">HP: {mode === 'versus' ? p2Hp : monsterHp}/100</div>
                </div>
              </div>

              {/* Battle Arena */}
              <div className="flex justify-between items-center mb-10 h-32 relative">
                <motion.div 
                  animate={
                    mode === 'versus' 
                    ? (isAttacking && currentPlayerInVs === 1 ? { x: [0, 80, 0] } : isBeingHit && currentPlayerInVs === 2 ? { x: [-10, 10, -10] } : (isBeingHit && currentPlayerInVs === 1 ? { x: [-10, 10, -10] } : (isAttacking && currentPlayerInVs === 2 ? { scale: 1 } : {} )))
                    : (isAttacking ? { x: [0, 50, 0] } : isBeingHit ? { x: [-10, 10, -10] } : {})
                  }
                  className={`p-6 bg-blue-500/10 rounded-3xl border-2 border-blue-500/30 ${isBeingHit && (mode === 'versus' ? currentPlayerInVs === 1 : true) ? 'border-red-500 bg-red-500/20' : ''}`}
                >
                  <Sword className={`w-12 h-12 text-blue-400 ${isBeingHit && (mode === 'versus' ? currentPlayerInVs === 1 : true) ? 'text-red-400' : ''}`} />
                  <div className="absolute -top-4 -right-4 bg-blue-500 text-white text-[10px] font-black px-2 py-1 rounded-lg">{mode === 'versus' ? 'P1' : 'Hero'}</div>
                </motion.div>

                <div className="text-slate-600 font-black text-4xl italic opacity-20">VS</div>

                <motion.div 
                  animate={
                    mode === 'versus'
                    ? (isAttacking && currentPlayerInVs === 2 ? { x: [0, -80, 0] } : isBeingHit && currentPlayerInVs === 1 ? { x: [10, -10, 10] } : (isBeingHit && currentPlayerInVs === 2 ? { x: [10, -10, 10] } : {}))
                    : (isBeingHit ? { x: [0, 10, 0] } : isAttacking ? { scale: [1, 1.2, 1], x: [0, -10, 10, 0] } : {})
                  }
                  className={`p-6 bg-red-500/10 rounded-3xl border-2 border-red-500/30 relative`}
                >
                  {mode === 'versus' ? <Shield className="w-12 h-12 text-red-400" /> : <currentMonster.icon className={`w-12 h-12 ${currentMonster.color}`} />}
                  <div className={`absolute -top-4 -left-4 bg-slate-700 text-white text-[10px] font-black px-2 py-1 rounded-lg`}>{mode === 'versus' ? 'P2' : currentMonster.name}</div>
                </motion.div>
              </div>

              {/* Interaction Area */}
              <div className="flex-1 dungeon-panel flex flex-col justify-center items-center text-center">
                 {mode !== 'single' && (
                   <div className={`mb-4 inline-flex items-center gap-2 px-3 py-1 ${mode === 'versus' ? (currentPlayerInVs === 1 ? 'bg-blue-500/20 text-blue-400 border-blue-500/30' : 'bg-red-500/20 text-red-400 border-red-500/30') : 'bg-warning/20 text-warning-foreground border-warning/30'} text-[10px] font-black rounded-lg uppercase tracking-widest border`}>
                     <User size={12} /> {mode === 'versus' ? `${vsNames[currentPlayerInVs - 1]} 턴` : `Guild Member ${currentPlayer} Turn`}
                   </div>
                 )}
                 <h3 className="text-xl sm:text-2xl font-black text-white leading-tight mb-8 max-w-lg">
                   {questions[currentIndex].q}
                 </h3>

                 <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full">
                    {questions[currentIndex].o.map((opt, idx) => (
                      <button
                        key={idx}
                        onClick={() => handleAnswer(idx)}
                        disabled={feedback?.show}
                        className={`group p-4 rounded-xl border-2 text-left transition-all relative overflow-hidden flex items-center gap-4 ${
                          feedback?.show
                            ? idx === questions[currentIndex].a
                              ? 'border-green-500 bg-green-500/20 text-white shadow-[0_0_20px_rgba(34,197,94,0.3)]'
                              : 'border-slate-800 opacity-20 bg-slate-900'
                            : 'border-slate-700 bg-slate-800/50 hover:border-brand hover:bg-brand/10 hover:-translate-y-1'
                        }`}
                      >
                         <div className={`w-8 h-8 rounded-lg flex items-center justify-center font-black text-sm transition-all ${
                            feedback?.show && idx === questions[currentIndex].a
                              ? 'bg-green-500 text-white'
                              : 'bg-slate-700 text-slate-400 group-hover:bg-brand group-hover:text-white transition-colors'
                          }`}>
                            {idx + 1}
                          </div>
                          <span className="font-bold text-slate-200">{opt}</span>
                      </button>
                    ))}
                 </div>
              </div>

              {/* Bottom Mini Stats */}
              <div className="mt-6 flex justify-around items-center py-4 bg-slate-900/50 rounded-2xl border border-slate-800">
                  <div className="flex flex-col items-center">
                    <div className="text-[10px] font-black text-slate-500 uppercase">Power</div>
                    <div className="text-orange-500 font-black">{stats.power}</div>
                  </div>
                  <div className="w-px h-6 bg-slate-800" />
                  <div className="flex flex-col items-center">
                    <div className="text-[10px] font-black text-slate-500 uppercase">XP</div>
                    <div className="text-brand font-black">{stats.xp}</div>
                  </div>
                  <div className="w-px h-6 bg-slate-800" />
                  <div className="flex flex-col items-center">
                    <div className="text-[10px] font-black text-slate-500 uppercase">Def</div>
                    <div className="text-green-500 font-black">{stats.wisdom}</div>
                  </div>
              </div>
            </motion.div>
          )}

          {screen === 'result' && (
            <motion.div
              key="result"
              initial={{ opacity: 0, scale: 1.1 }}
              animate={{ opacity: 1, scale: 1 }}
              className="card relative overflow-hidden"
            >
              <div className="absolute top-0 right-0 p-8 opacity-5 text-warning group">
                <Sparkles size={200} />
              </div>

              <div className="text-center mb-8">
                 <div className="w-20 h-20 bg-warning/20 rounded-3xl flex items-center justify-center mx-auto mb-4 border-2 border-warning/30 shadow-[0_0_20px_rgba(255,190,11,0.2)]">
                    <Trophy className="text-warning w-10 h-10" />
                 </div>
                 <h2 className="text-4xl font-black text-white mb-2 tracking-tighter">
                   {mode === 'versus' 
                    ? (p1Hp > p2Hp ? `${vsNames[0]} 승리!` : p2Hp > p1Hp ? `${vsNames[1]} 승리!` : '무승부!') 
                    : '퀘스트 달성!'}
                 </h2>
                 <p className="text-slate-400 font-bold text-xs uppercase tracking-[0.2em]">
                   {mode === 'versus' ? 'Arena Result' : (playerHp <= 0 ? 'Dungeon Defeated' : 'Victory Achieved')}
                 </p>
              </div>

              {mode === 'versus' ? (
                <div className="grid grid-cols-2 gap-4 mb-10">
                   <div className={`dungeon-panel ${p1Hp > p2Hp ? 'border-blue-500 bg-blue-500/10' : 'border-slate-800 opacity-50'}`}>
                      <div className="text-xs font-black text-blue-400 uppercase mb-2">{vsNames[0]}</div>
                      <div className="text-2xl font-black text-white">{playerScores[1]} Hits</div>
                   </div>
                   <div className={`dungeon-panel ${p2Hp > p1Hp ? 'border-red-500 bg-red-500/10' : 'border-slate-800 opacity-50'}`}>
                      <div className="text-xs font-black text-red-400 uppercase mb-2">{vsNames[1]}</div>
                      <div className="text-2xl font-black text-white">{playerScores[2]} Hits</div>
                   </div>
                </div>
              ) : (
                <>
                  {playerHp <= 0 && (
                    <div className="mb-8 p-4 bg-red-500/20 rounded-2xl border border-red-500/30 text-center text-red-200 font-bold">
                      영웅이 쓰러졌습니다... 하지만 당신의 명예는 기록됩니다!
                    </div>
                  )}

                  <div className="grid sm:grid-cols-2 gap-4 mb-8">
                    <div className="dungeon-panel bg-brand/5 border-brand/20">
                      <div className="text-[10px] font-black text-brand uppercase mb-2">Character Profile</div>
                      <div className="text-2xl font-black text-white">{stats.title}</div>
                      <div className="text-xs font-bold text-slate-500 mt-1">Level {stats.level} Warrior</div>
                    </div>
                    <div className="dungeon-panel bg-orange-500/5 border-orange-500/20">
                       <div className="text-[10px] font-black text-orange-500 uppercase mb-2">Final Loot (Score)</div>
                       <div className="text-2xl font-black text-white">{mode === 'single' ? singleScore : totalGroupScore} / {questions.length}</div>
                       <div className="text-xs font-bold text-slate-500 mt-1">{Math.round(( (mode === 'single' ? singleScore : totalGroupScore) / questions.length) * 100)}% Cleared</div>
                    </div>
                  </div>
                </>
              )}

              {mode === 'group' && (
                <div className="mb-8 dungeon-panel">
                   <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest mb-4">파티 기여도 점수</h3>
                   <div className="space-y-2">
                     {new Array(groupSize).fill(0).map((_, i) => (
                       <div key={i} className="flex justify-between items-center text-sm font-bold p-3 bg-slate-900 rounded-xl">
                         <span className="text-slate-400">길드원 {i + 1}</span>
                         <span className="text-white bg-slate-800 px-3 py-1 rounded-lg">{playerScores[i+1]} / 10</span>
                       </div>
                     ))}
                   </div>
                </div>
              )}

              {mode !== 'versus' && (
                <div className="mb-10 dungeon-panel border-brand/30 border-2">
                  <label className="block text-[10px] font-black text-brand uppercase tracking-widest mb-3">
                    {activeRoom ? `명예의 전당 등록 (${activeRoom} 자동 백업 완)` : '전설의 비석에 이름 새기기'}
                  </label>
                  <div className="flex gap-2">
                    <input 
                      value={playerName}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Enter Hero Name..."
                      className="flex-1 bg-slate-900 p-4 rounded-xl border border-slate-700 outline-none focus:border-brand transition-all text-lg font-bold text-white"
                    />
                    <button 
                      onClick={submitScore}
                      disabled={!playerName.trim() || isSaving}
                      className="bg-brand text-white px-6 rounded-xl hover:brightness-110 active:scale-95 transition-all shadow-lg flex items-center justify-center disabled:opacity-50"
                    >
                      <SendHorizontal size={24} />
                    </button>
                  </div>
                  {activeRoom && (
                    <div className="text-[10px] text-green-400 font-bold mt-2 flex items-center gap-1 justify-center">
                      <CheckCircle2 size={12} /> 선생님 대시보드({activeRoom})에 점수가 실시간 전달 및 자동 백업되었습니다!
                    </div>
                  )}
                </div>
              )}

              <div className="flex flex-col gap-3">
                {activeRoom ? (
                  <>
                    <button 
                      onClick={() => {
                        // Keep current name and enter student lobby directly with a fresh score identity
                        setCurrentScoreId(generateId());
                        setSingleScore(0);
                        setPlayerScores([]);
                        setCurrentIndex(0);
                        setPlayerHp(100);
                        setMonsterHp(100);
                        setFeedback(null);
                        setScreen('student-lobby');
                      }}
                      className="btn-primary w-full py-4 text-lg font-black uppercase tracking-widest bg-green-600 hover:bg-green-500 border-green-700 shadow-green-900/30 font-sans"
                    >
                      <RefreshCcw className="inline mr-2" size={20} />대기실로 복귀 (새로운 퀘스트 도전)
                    </button>
                    
                    <button 
                      onClick={() => {
                        // Replay the current game mode with a fresh sequence
                        setCurrentScoreId(generateId());
                        if (mode === 'single') {
                          startSingleMode();
                        } else if (mode === 'group') {
                          startGroupMode();
                        } else {
                          startVsMode();
                        }
                      }}
                      className="btn-primary w-full py-4 text-lg font-black uppercase tracking-widest bg-brand hover:brightness-110 font-sans"
                    >
                      <Zap className="inline mr-2" size={20} />새로운 던전 즉시 공략하기
                    </button>
                  </>
                ) : (
                  <button 
                    onClick={() => {
                      setCurrentScoreId(generateId());
                      if (mode === 'single') {
                        startSingleMode();
                      } else if (mode === 'group') {
                        startGroupMode();
                      } else {
                        startVsMode();
                      }
                    }}
                    className="btn-primary w-full py-4 text-lg font-black uppercase tracking-widest bg-brand hover:brightness-110 font-sans"
                  >
                    <RefreshCcw className="inline mr-2" size={20} />같은 이름으로 다시 도전하기
                  </button>
                )}

                <button 
                  onClick={goMain}
                  className="btn-secondary w-full py-4 text-lg font-black uppercase tracking-widest font-sans border-slate-700 text-slate-400 hover:text-white"
                >
                  캠프(메인)로 돌아가기
                </button>
              </div>
            </motion.div>
          )}

          {screen === 'teacher-auth' && (
            <motion.div
              key="teacher-auth"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="card max-w-md mx-auto text-center"
            >
              <button onClick={goMain} className="mb-8 flex items-center gap-2 text-slate-400 hover:text-white transition-colors font-bold uppercase text-xs">
                <ArrowLeft size={16} /> Back
              </button>

              <div className="w-16 h-16 bg-purple-600/10 text-purple-400 rounded-2xl flex items-center justify-center mx-auto mb-6 border-2 border-purple-500/30 shadow-[0_0_20px_rgba(147,51,234,0.1)]">
                <GraduationCap size={32} />
              </div>

              <h2 className="text-3xl font-black text-white mb-2 tracking-tighter">교사 암호 확인</h2>
              <p className="text-slate-400 text-sm font-bold mb-8">교사 스테이션에 진입하려면 암호가 필요합니다.</p>

              <div className="dungeon-panel border-purple-500/30 mb-8 text-left">
                <label className="block text-[10px] font-black text-purple-400 uppercase tracking-widest mb-3">비밀번호 입력</label>
                <input 
                  type="password"
                  value={enteredPassword}
                  onChange={(e) => setEnteredPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleTeacherAuth();
                  }}
                  placeholder="암호를 입력하세요..."
                  className="w-full bg-slate-900 p-4 rounded-xl border-2 border-slate-700 outline-none focus:border-purple-500 transition-all text-lg font-mono text-center tracking-widest text-white placeholder-slate-600"
                  autoFocus
                />
                <div className="text-[10px] text-slate-500 font-bold mt-2 text-center">
                  * 초기 기본 암호는 <span className="text-purple-400 font-black font-mono">1234</span> 입니다.
                </div>
              </div>

              <button 
                onClick={handleTeacherAuth}
                className="w-full btn-primary bg-purple-600 border-purple-700 py-4 text-lg font-black uppercase tracking-widest hover:brightness-110 active:scale-95 transition-all shadow-lg shadow-purple-900/20 font-sans"
              >
                인증 및 진입
              </button>
            </motion.div>
          )}

          {screen === 'teacher' && (
            <motion.div 
              key="teacher" 
              initial={{ opacity: 0, x: 100 }} 
              animate={{ opacity: 1, x: 0 }} 
              exit={{ opacity: 0, x: -100 }}
              className="card"
            >
              <button onClick={goMain} className="mb-8 flex items-center gap-2 text-slate-400 hover:text-white transition-colors font-bold uppercase text-xs">
                <ArrowLeft size={16} /> Back
              </button>
              <h2 className="text-3xl font-black mb-8 text-white">교사 스테이션</h2>
              
              <div className="space-y-8">
                <div className="dungeon-panel border-purple-500/30">
                  <h3 className="text-purple-400 text-xs font-black uppercase mb-4 tracking-widest">방 코드 생성</h3>
                  <div className="space-y-3">
                    <input 
                      placeholder="교사 성함"
                      value={teacherName}
                      onChange={(e) => setTeacherName(e.target.value)}
                      className="w-full bg-slate-900 p-3 rounded-lg border border-slate-700 text-white font-bold"
                    />
                    <input 
                      placeholder="방 코드 (예: 6-1-수학)"
                      value={teacherRoomCode}
                      onChange={(e) => setTeacherRoomCode(e.target.value)}
                      className="w-full bg-slate-900 p-3 rounded-lg border border-slate-700 text-white font-mono font-bold"
                    />
                    <input 
                      type="password"
                      placeholder="이 방의 진입 비밀번호 설정 (선택, 기본 1234)"
                      value={roomPassword}
                      onChange={(e) => setRoomPassword(e.target.value)}
                      className="w-full bg-slate-900 p-3 rounded-lg border border-slate-700 text-white font-mono"
                    />
                    <button 
                      onClick={handleCreateRoom} 
                      disabled={isSaving}
                      className="w-full btn-primary bg-purple-600 border-purple-700 capitalize font-black disabled:opacity-50"
                    >
                      {isSaving ? '방 생성 중...' : '방 생성 및 대시보드 진입'}
                    </button>
                  </div>
                </div>

                <div className="dungeon-panel border-slate-600">
                  <h3 className="text-slate-400 text-xs font-black uppercase mb-4 tracking-widest">기존 방 데이터 조회</h3>
                  <div className="space-y-3">
                    <input 
                      placeholder="조회할 방 코드"
                      value={roomToView}
                      onChange={(e) => setRoomToView(e.target.value)}
                      className="w-full bg-slate-900 p-3 rounded-lg border border-slate-700 text-white font-mono font-bold"
                    />
                    <input 
                      type="password"
                      placeholder="해당 방의 비밀번호"
                      value={enteredRoomPassword}
                      onChange={(e) => setEnteredRoomPassword(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') viewRoomData();
                      }}
                      className="w-full bg-slate-900 p-3 rounded-lg border border-slate-700 text-white font-mono"
                    />
                    <button 
                      onClick={viewRoomData} 
                      disabled={isSaving}
                      className="w-full btn-secondary py-3 text-sm font-black uppercase border-slate-700 text-slate-300 hover:text-white"
                    >
                      {isSaving ? '조회 중...' : '상황실 조회 및 진입'}
                    </button>
                  </div>
                </div>
              </div>
            </motion.div>
          )}

          {screen === 'teacher-dashboard' && (
            <motion.div 
              key="dashboard" 
              initial={{ opacity: 0, scale: 1.1 }} 
              animate={{ opacity: 1, scale: 1 }} 
              exit={{ opacity: 0, scale: 0.9 }}
              className="card flex flex-col h-[700px]"
            >
              <div className="flex justify-between items-center mb-8">
                <button onClick={() => setScreen('teacher')} className="p-3 bg-slate-800 rounded-xl hover:bg-slate-700 transition-colors">
                  <ArrowLeft size={18} />
                </button>
                <div className="text-center">
                  <h2 
                    onClick={() => {
                      navigator.clipboard.writeText(roomToView);
                      alert('방 코드가 클립보드에 복사되었습니다! 학생들에게 공유해주세요.');
                    }}
                    className="text-xl font-black text-white hover:text-purple-400 cursor-pointer transition-colors flex items-center justify-center gap-1.5"
                    title="클릭하여 방 코드 복사"
                  >
                    <span>{roomToView}</span>
                    <Copy size={14} className="opacity-60" />
                    <span>던전 상황실</span>
                  </h2>
                  <div className="text-[10px] text-purple-400 font-bold uppercase tracking-widest cursor-pointer" onClick={() => {
                    navigator.clipboard.writeText(roomToView);
                    alert('방 코드가 클립보드에 복사되었습니다! 학생들에게 공유해주세요.');
                  }}>Active Heroes Tracking (Click to copy code)</div>
                </div>
                <button 
                  onClick={viewRoomData} 
                  disabled={isSaving}
                  className={`p-3 bg-slate-800 rounded-xl hover:bg-slate-700 transition-all ${isSaving ? 'animate-spin opacity-50' : ''}`}
                >
                  <RefreshCcw size={18} />
                </button>
              </div>

              <div className="flex justify-between items-center mb-4 px-1">
                <span className="text-xs font-bold text-slate-400">참여 영웅: <span className="text-purple-400 font-extrabold">{leaderboard.length}명</span></span>
                {leaderboard.length > 0 && (
                  <button
                    onClick={async () => {
                      if (confirm('정말로 이 상황실의 모든 학생 데이터(기록)를 삭제하시겠습니까? 이 작업은 되돌릴 수 없으며, 모든 연결된 학생용 대시보드가 초기화됩니다.')) {
                        try {
                          setIsSaving(true);
                          await deleteAllScoresInRoom(roomToView);
                          setLeaderboards([]);
                          alert('모든 학생 데이터가 초기화되었습니다.');
                        } catch (error) {
                          alert('전체 삭제에 실패했습니다.');
                        } finally {
                          setIsSaving(false);
                        }
                      }
                    }}
                    disabled={isSaving}
                    className="text-xs bg-red-600/20 text-red-400 hover:bg-red-600 hover:text-white px-3 py-1.5 rounded-lg border border-red-500/20 hover:border-red-600 transition-all font-bold flex items-center gap-1.5"
                  >
                    <Trash2 size={12} />
                    학생 전체 삭제
                  </button>
                )}
              </div>

              <div className="flex-1 overflow-y-auto space-y-3 pr-2 custom-scrollbar">
                {isSaving && leaderboard.length === 0 ? (
                  <div className="text-center py-20">
                    <div className="w-12 h-12 border-4 border-purple-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
                    <p className="text-slate-500 font-black text-xs uppercase tracking-widest">수정구슬로 확인 중...</p>
                  </div>
                ) : leaderboard.length === 0 ? (
                  <div className="text-center py-20 text-slate-600 font-black uppercase text-xs tracking-widest flex flex-col items-center gap-4">
                    <History size={48} className="opacity-10" />
                    아직 입장한 영웅이 없습니다.
                  </div>
                ) : (
                  leaderboard.map((entry, idx) => (
                    <motion.div 
                      key={entry.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: idx * 0.05 }}
                      className="p-4 bg-slate-800/80 rounded-xl border border-slate-700 flex justify-between items-center shadow-lg hover:border-purple-500/50 transition-colors"
                    >
                      <div className="flex items-center gap-4">
                        <div className="w-10 h-10 bg-purple-600 text-white rounded-lg flex items-center justify-center font-black shadow-lg shadow-purple-900/20">
                          {idx + 1}
                        </div>
                        <div>
                          <div className="font-black text-white text-lg leading-tight flex items-center gap-2">
                            {entry.name}
                            <span className={`text-[9px] px-1.5 py-0.5 rounded border ${
                              entry.mode === 'versus' ? 'border-orange-500 text-orange-500' : 
                              entry.mode === 'group' ? 'border-accent text-accent' : 'border-brand text-brand'
                            }`}>
                              {entry.mode}
                            </span>
                          </div>
                          <div className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mt-1">
                            {getTitle(entry.level)} • <span className="text-white">LEVEL {entry.level}</span>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="text-right">
                          <div className="text-2xl font-black text-brand tracking-tighter">{entry.score} <span className="text-[10px] opacity-40">PTS</span></div>
                          <div className="text-[9px] text-slate-600 uppercase font-bold mt-1">
                            {entry.timestamp?.seconds 
                              ? new Date(entry.timestamp.seconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) 
                              : 'Just now'}
                          </div>
                        </div>

                        {deletingId === entry.id ? (
                          <div className="flex gap-1 items-center z-10 bg-slate-900/90 p-1.5 rounded-lg border border-red-500/30">
                            <button 
                              onClick={async (e) => {
                                e.stopPropagation();
                                if (entry.id) {
                                  try {
                                    await deleteScore(entry.id);
                                    setLeaderboards(prev => prev.filter(item => item.id !== entry.id));
                                    setDeletingId(null);
                                  } catch (error) {
                                    alert('삭제에 실패했습니다.');
                                  }
                                }
                              }}
                              className="bg-red-600 hover:bg-red-700 text-white text-[10px] font-bold px-2 py-1 rounded transition-colors"
                            >
                              삭제
                            </button>
                            <button 
                              onClick={(e) => {
                                e.stopPropagation();
                                setDeletingId(null);
                              }}
                              className="bg-slate-700 hover:bg-slate-600 text-slate-200 text-[10px] font-bold px-2 py-1 rounded transition-colors"
                            >
                              취소
                            </button>
                          </div>
                        ) : (
                          <button 
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeletingId(entry.id || null);
                            }}
                            className="p-2 text-slate-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all"
                            title="학생 데이터 삭제"
                          >
                            <Trash2 size={16} />
                          </button>
                        )}
                      </div>
                    </motion.div>
                  ))
                )}
              </div>
              
              <div className="mt-6 p-4 bg-slate-900/80 border border-slate-800 rounded-xl">
                 <div className="text-[10px] font-black text-slate-500 uppercase mb-2">학생들에게 안내하세요</div>
                 <div className="text-xs text-slate-400 font-bold leading-relaxed">
                   메인 화면에서 <span className="text-white font-black">[{roomToView}]</span> 코드를 입력하고 참여하면 이곳에 결과가 실시간으로 나타납니다.
                 </div>
              </div>
            </motion.div>
          )}
          {screen === 'ranking' && (
            <motion.div
              key="ranking"
              initial={{ opacity: 0, y: 50 }}
              animate={{ opacity: 1, y: 0 }}
              className="card min-h-[600px] flex flex-col"
            >
              <div className="flex items-center justify-between mb-8">
                 <button onClick={goMain} className="p-3 bg-slate-800 text-slate-400 hover:text-white rounded-xl transition-all">
                    <ArrowLeft size={18} />
                 </button>
                 <h2 className="text-2xl font-black uppercase tracking-tighter text-white">명예의 전당 (Top Legends)</h2>
                 <div className="w-10" />
              </div>

              <div className="flex gap-2 mb-6 p-1 bg-slate-800 rounded-2xl">
                 <button 
                   onClick={() => { setMode('single'); openRanking(); }}
                   className={`flex-1 p-3 rounded-xl font-black text-xs transition-all uppercase tracking-widest ${mode === 'single' ? 'bg-brand text-white shadow-lg' : 'text-slate-500'}`}
                 >
                   개인 랭킹
                 </button>
                 <button 
                   onClick={() => { setMode('group'); openRanking(); }}
                   className={`flex-1 p-3 rounded-xl font-black text-xs transition-all uppercase tracking-widest ${mode === 'group' ? 'bg-accent text-white shadow-lg' : 'text-slate-500'}`}
                 >
                   연합 랭킹
                 </button>
                 <button 
                   onClick={() => { setMode('versus'); openRanking(); }}
                   className={`flex-1 p-3 rounded-xl font-black text-xs transition-all uppercase tracking-widest ${mode === 'versus' ? 'bg-orange-500 text-white shadow-lg' : 'text-slate-500'}`}
                 >
                   결투 랭킹
                 </button>
              </div>

              <div className="flex-1 overflow-y-auto space-y-4 pr-1 custom-scrollbar">
                {leaderboard.length === 0 ? (
                   <div className="text-center py-24 text-slate-600">
                      <Skull size={64} className="mx-auto mb-6 opacity-10" />
                      <p className="font-black uppercase tracking-widest text-sm translate-y-4">No legends found yet...</p>
                   </div>
                ) : (
                  leaderboard.map((entry, idx) => (
                    <motion.div 
                      key={entry.id}
                      initial={{ opacity: 0, x: -30 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: idx * 0.05 }}
                      className={`p-5 rounded-2xl border-2 flex items-center justify-between hover:scale-[1.02] transition-all ${
                        idx === 0 ? 'bg-warning/10 border-warning/30 shadow-[0_0_20px_rgba(255,190,11,0.1)]' :
                        idx === 1 ? 'bg-slate-300/5 border-slate-300/20' :
                        idx === 2 ? 'bg-orange-300/5 border-orange-300/20' :
                        'bg-slate-800/30 border-slate-700/50'
                      }`}
                    >
                       <div className="flex items-center gap-5">
                          <div className={`w-10 h-10 rounded-xl flex items-center justify-center font-black ${
                            idx === 0 ? 'bg-warning text-slate-900' :
                            idx === 1 ? 'bg-slate-300 text-slate-800' :
                            idx === 2 ? 'bg-orange-300 text-slate-800' :
                            'bg-slate-700 text-slate-400'
                          }`}>
                            {idx + 1}
                          </div>
                          <div>
                             <div className="font-black text-lg text-white mb-0.5">{entry.name}</div>
                             <div className="text-[10px] font-black text-brand uppercase tracking-widest">{getTitle(entry.level)} LV.{entry.level}</div>
                          </div>
                       </div>
                       <div className="flex items-center gap-3">
                          <div className="text-right">
                             <div className="text-2xl font-black text-brand tracking-tighter">{entry.score} <span className="text-xs uppercase ml-1 opacity-60">Quest Points</span></div>
                          </div>

                          {deletingId === entry.id ? (
                            <div className="flex gap-1 items-center z-10 bg-slate-900/90 p-1.5 rounded-lg border border-red-500/30 font-sans">
                              <button 
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  if (entry.id) {
                                    try {
                                      await deleteScore(entry.id);
                                      setLeaderboards(prev => prev.filter(item => item.id !== entry.id));
                                      setDeletingId(null);
                                    } catch (error) {
                                      alert('삭제에 실패했습니다.');
                                    }
                                  }
                                }}
                                className="bg-red-600 hover:bg-red-700 text-white text-[10px] font-bold px-2 py-1 rounded transition-colors font-sans"
                              >
                                삭제
                              </button>
                              <button 
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setDeletingId(null);
                                }}
                                className="bg-slate-700 hover:bg-slate-600 text-slate-200 text-[10px] font-bold px-2 py-1 rounded transition-colors font-sans"
                              >
                                취소
                              </button>
                            </div>
                          ) : (
                            <button 
                              onClick={(e) => {
                                e.stopPropagation();
                                setDeletingId(entry.id || null);
                              }}
                              className="p-2 text-slate-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all"
                              title="기록 삭제"
                            >
                              <Trash2 size={16} />
                            </button>
                          )}
                       </div>
                    </motion.div>
                  ))
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
