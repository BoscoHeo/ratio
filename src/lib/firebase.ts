import { initializeApp } from 'firebase/app';
import { getAuth, signInWithCustomToken, setPersistence, browserSessionPersistence, inMemoryPersistence, connectAuthEmulator } from 'firebase/auth';
import {
  getFirestore,
  connectFirestoreEmulator,
  collection,
  addDoc,
  getDocs,
  query,
  limit,
  serverTimestamp,
  doc,
  setDoc,
  where,
  onSnapshot
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import { ScoreEntry } from '../types';

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: null,
      email: null,
      emailVerified: null,
      isAnonymous: null,
      tenantId: null,
      providerInfo: []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// 에뮬레이터는 명시적으로 요청한 로컬 개발 화면에서만 연결한다.
const useEmulators = import.meta.env.VITE_USE_EMULATORS === 'true' && ['localhost', '127.0.0.1'].includes(location.hostname);
const app = initializeApp(useEmulators ? { ...firebaseConfig, projectId: 'demo-ratio-security', apiKey: 'emulator-test-api-key' } : firebaseConfig);
const auth = getAuth(app);
if (useEmulators) connectAuthEmulator(auth, 'http://127.0.0.1:9197', { disableWarnings: true });
const authReady = setPersistence(auth, browserSessionPersistence).catch(() => setPersistence(auth, inMemoryPersistence));
export const db = useEmulators ? getFirestore(app) : getFirestore(app, firebaseConfig.firestoreDatabaseId);
if (useEmulators) connectFirestoreEmulator(db, '127.0.0.1', 8187);

// ----------------------------------------------------------------------
// Cloud Functions 2nd Gen API URL 설정 (운영/개발 환경 지원)
// ----------------------------------------------------------------------
const DEFAULT_FUNCTIONS_URL = 'https://asia-northeast3-project-e9661680-15e4-4f40-b06.cloudfunctions.net/api';
export const API_BASE = (import.meta as any).env?.VITE_FUNCTIONS_API_URL || DEFAULT_FUNCTIONS_URL;


async function apiPost(route: string, body: unknown, authenticated = false) {
  await authReady;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authenticated && auth.currentUser) headers.Authorization = 'Bearer ' + await auth.currentUser.getIdToken();
  const response = await fetch(API_BASE + route, { method: 'POST', headers, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '요청을 완료하지 못했습니다.');
  return data;
}
async function acceptAccess(data: { customToken?: string }) {
  if (!data.customToken) throw new Error('서버 업데이트가 필요합니다. 다시 입장해주세요.');
  await authReady;
  await signInWithCustomToken(auth, data.customToken);
}
let accessQueue: Promise<unknown> = Promise.resolve();
export async function joinStudentRoom(roomCode = '') {
  const job = accessQueue.then(async () => {
    await authReady;
    const claims = auth.currentUser ? (await auth.currentUser.getIdTokenResult()).claims : {};
    if (claims.role === 'player' && claims.roomCode === roomCode) return;
    const data = await apiPost('/api/session/join', { roomCode }, true);
    await acceptAccess(data);
  });
  accessQueue = job.catch(() => {});
  return job;
}
async function requireTeacher(roomCode: string) {
  await authReady;
  const claims = auth.currentUser ? (await auth.currentUser.getIdTokenResult()).claims : {};
  if (claims.role !== 'teacher' || claims.roomCode !== roomCode) throw new Error('해당 방의 교사 비밀번호로 다시 입장해주세요.');
}
async function scoreData(entry: Omit<ScoreEntry, 'id' | 'timestamp'>) {
  await joinStudentRoom(entry.roomCode || '');
  return { name: entry.name.trim(), score: entry.score, level: entry.level, mode: entry.mode,
    timestamp: serverTimestamp(), ownerId: auth.currentUser!.uid, roomCode: entry.roomCode || '' };
}

export const saveScore = async (entry: Omit<ScoreEntry, 'id' | 'timestamp'>) => {
  const path = 'leaderboard';
  try {
    const cleanData = await scoreData(entry);
    await addDoc(collection(db, path), cleanData);
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
};

export const getLeaderboard = async (gameMode: 'single' | 'group' | 'versus', roomCode?: string, maxResults = 50): Promise<ScoreEntry[]> => {
  const path = 'leaderboard';
  try {
    let q;
    await authReady;
    const scope = roomCode || '';
    const claims = auth.currentUser ? (await auth.currentUser.getIdTokenResult()).claims : {};
    if (scope && claims.role === 'teacher' && claims.roomCode === scope) {
      await requireTeacher(scope);
      q = query(collection(db, path), where('roomCode', '==', scope), limit(Math.min(maxResults, 100)));
    } else {
      await joinStudentRoom(scope);
      q = query(collection(db, path), where('ownerId', '==', auth.currentUser!.uid), where('roomCode', '==', scope), limit(Math.min(maxResults, 100)));
    }

    const snapshot = await getDocs(q);
    const results = snapshot.docs.map(docSnapshot => {
      const data = docSnapshot.data() as any;
      return { id: docSnapshot.id, ...data } as ScoreEntry;
    });

    if (roomCode && claims.role === 'teacher') {
      return results.sort((a, b) => {
        const t1 = a.timestamp?.seconds || 0;
        const t2 = b.timestamp?.seconds || 0;
        return t2 - t1;
      }).slice(0, maxResults);
    }

    return results.filter(row => row.mode === gameMode).sort((a,b) => b.score-a.score);
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
    return [];
  }
};

// ----------------------------------------------------------------------
// 서버 API 연동: 방 생성 (Cloud Function API 호출)
// ----------------------------------------------------------------------
export const createRoom = async (code: string, teacher: string, password?: string) => {
  if (!password || password.trim().length < 8) throw new Error('새 방 비밀번호를 8자 이상 입력해주세요.');
  await acceptAccess(await apiPost('/api/room/create', { roomCode: code, teacher, password }));
};

export const updateRoomPassword = async (code: string, oldPassword: string, newPassword: string) => {
  await acceptAccess(await apiPost('/api/teacher/change-password', { roomCode: code, password: oldPassword, newPassword }));
};

export const getRoomCodeVariations = (code: string): string[] => {
  const clean = (code || '').trim().toLowerCase().replace(/[/\\?#]/g, '');
  if (!clean) return [];
  const variations = new Set<string>();
  
  variations.add(clean);
  const noSpace = clean.replace(/\s+/g, '');
  variations.add(noSpace);
  const noSpaceNoHyphen = clean.replace(/[\s-]+/g, '');
  variations.add(noSpaceNoHyphen);

  const match = noSpace.match(/^([가-힣a-zA-Z0-9_]+?)[-]?(\d+)(?:[-]?(\d+))?$/);
  if (match) {
    const textPart = match[1];
    const num1 = match[2];
    const num2 = match[3] || '';

    if (!num2) {
      variations.add(`${textPart}${num1}`);
      variations.add(`${textPart} ${num1}`);
    } else {
      variations.add(`${textPart}${num1}-${num2}`);
      variations.add(`${textPart} ${num1}-${num2}`);
      variations.add(`${textPart}${num1}${num2}`);
      variations.add(`${textPart} ${num1}${num2}`);
    }
  }

  return Array.from(variations).filter(Boolean);
};

export const resolveRoomCode = async (enteredCode: string): Promise<string> => {
  const data = await apiPost('/api/room/resolve', { roomCode: enteredCode });
  return data.roomCode || getRoomCodeVariations(enteredCode)[0] || '';
};

// ----------------------------------------------------------------------
// 서버 API 연동: 비밀번호 검증 (Cloud Function API 호출)
// ----------------------------------------------------------------------
export const checkRoomPassword = async (code: string, passwordEntered: string): Promise<boolean> => {
  try {
    await acceptAccess(await apiPost('/api/teacher/verify', { roomCode: code, password: passwordEntered }));
    return true;
  } catch { return false; }
};

export const checkRoomExists = async (code: string): Promise<boolean> => {
  return Boolean((await apiPost('/api/room/resolve', { roomCode: code })).exists);
};

// ----------------------------------------------------------------------
// 학생 실시간 점수 동기화: 기존 Client Firestore setDoc (update) 온전히 유지
// ----------------------------------------------------------------------
export const syncPlayerProgress = async (
  scoreId: string,
  entry: Omit<ScoreEntry, 'id' | 'timestamp'>
) => {
  const path = `leaderboard/${scoreId}`;
  try {
    const docRef = doc(db, 'leaderboard', scoreId);
    const cleanData = await scoreData(entry);
    await setDoc(docRef, cleanData);
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
};

export const subscribeRoomLeaderboard = (
  roomCode: string,
  callback: (entries: ScoreEntry[]) => void,
  maxResults = 50
) => {
  let stopped = false;
  let unsubscribe: (() => void) | undefined;
  requireTeacher(roomCode).then(() => {
    if (stopped) return;
    const q = query(collection(db, 'leaderboard'), where('roomCode', '==', roomCode), limit(Math.min(maxResults, 100)));
    unsubscribe = onSnapshot(q, snapshot => {
      callback(snapshot.docs.map(d => ({ id: d.id, ...d.data() } as ScoreEntry)).sort((a,b) => b.score-a.score));
    }, () => callback([]));
  }).catch(() => callback([]));
  return () => { stopped = true; unsubscribe?.(); };
};

// ----------------------------------------------------------------------
// 서버 API 연동: 개별 학생 기록 삭제 (Cloud Function API 호출)
// ----------------------------------------------------------------------
export const deleteScore = async (scoreId: string, roomCode: string, password: string) => {
  const res = await fetch(`${API_BASE}/api/teacher/delete-score`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      roomCode,
      password,
      scoreId
    })
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || '점수 삭제에 실패했습니다.');
  }
};

// ----------------------------------------------------------------------
// 서버 API 연동: 방 전체 학생 기록 초기화 (Cloud Function API 호출)
// ----------------------------------------------------------------------
export const deleteAllScoresInRoom = async (roomCode: string, password: string) => {
  const res = await fetch(`${API_BASE}/api/teacher/clear-room`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      roomCode,
      password
    })
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || '방 전체 초기화에 실패했습니다.');
  }
};
