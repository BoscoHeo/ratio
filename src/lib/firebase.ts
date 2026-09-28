import { initializeApp } from 'firebase/app';
import {
  getFirestore,
  collection,
  addDoc,
  getDocs,
  query,
  orderBy,
  limit,
  serverTimestamp,
  doc,
  setDoc,
  getDoc,
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

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);

// ----------------------------------------------------------------------
// Cloud Functions 2nd Gen API URL 설정 (운영/개발 환경 지원)
// ----------------------------------------------------------------------
const DEFAULT_FUNCTIONS_URL = 'https://asia-northeast3-project-e9661680-15e4-4f40-b06.cloudfunctions.net/api';
export const API_BASE = (import.meta as any).env?.VITE_FUNCTIONS_API_URL || DEFAULT_FUNCTIONS_URL;

export const saveScore = async (entry: Omit<ScoreEntry, 'id' | 'timestamp'>) => {
  const path = 'leaderboard';
  try {
    const cleanData: any = {
      name: entry.name,
      score: entry.score,
      level: entry.level,
      mode: entry.mode,
      timestamp: serverTimestamp()
    };
    if (entry.roomCode !== undefined && entry.roomCode !== null && entry.roomCode !== '') {
      cleanData.roomCode = entry.roomCode;
    }
    await addDoc(collection(db, path), cleanData);
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
};

export const getLeaderboard = async (gameMode: 'single' | 'group' | 'versus', roomCode?: string, maxResults = 50): Promise<ScoreEntry[]> => {
  const path = 'leaderboard';
  try {
    let q;
    if (roomCode) {
      const roomVariations = getRoomCodeVariations(roomCode);
      q = query(
        collection(db, path),
        where('roomCode', 'in', roomVariations),
        limit(maxResults * 2)
      );
    } else {
      q = query(
        collection(db, path),
        where('mode', '==', gameMode),
        orderBy('score', 'desc'),
        limit(maxResults)
      );
    }
    
    const snapshot = await getDocs(q);
    const results = snapshot.docs.map(docSnapshot => {
      const data = docSnapshot.data() as any;
      return { id: docSnapshot.id, ...data } as ScoreEntry;
    });

    if (roomCode) {
      return results.sort((a, b) => {
        const t1 = a.timestamp?.seconds || 0;
        const t2 = b.timestamp?.seconds || 0;
        return t2 - t1;
      }).slice(0, maxResults);
    }

    return results;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
    return [];
  }
};

// ----------------------------------------------------------------------
// 서버 API 연동: 방 생성 (Cloud Function API 호출)
// ----------------------------------------------------------------------
export const createRoom = async (code: string, teacher: string, password?: string) => {
  const res = await fetch(`${API_BASE}/api/room/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      roomCode: code,
      teacher,
      password: password || '1234'
    })
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || '방 생성에 실패했습니다.');
  }
};

// ----------------------------------------------------------------------
// 서버 API 연동: 비밀번호 변경 (Cloud Function API 호출)
// ----------------------------------------------------------------------
export const updateRoomPassword = async (code: string, oldPassword: string, newPassword: string) => {
  const res = await fetch(`${API_BASE}/api/teacher/change-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      roomCode: code,
      password: oldPassword,
      newPassword
    })
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || '비밀번호 변경에 실패했습니다.');
  }
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
  if (!enteredCode) return '';
  const variations = getRoomCodeVariations(enteredCode);
  if (variations.length === 0) return '';
  
  try {
    const checks = await Promise.all(
      variations.map(async (v) => {
        try {
          const roomRef = doc(db, 'rooms', v);
          const snap = await getDoc(roomRef);
          return snap.exists() ? v : null;
        } catch (e) {
          console.error("Error resolving single variation:", v, e);
          return null;
        }
      })
    );
    
    const matched = checks.find((v) => v !== null);
    return matched || variations[0];
  } catch (err) {
    console.error("Error resolving variations in parallel:", err);
    return variations[0];
  }
};

// ----------------------------------------------------------------------
// 서버 API 연동: 비밀번호 검증 (Cloud Function API 호출)
// ----------------------------------------------------------------------
export const checkRoomPassword = async (code: string, passwordEntered: string): Promise<boolean> => {
  try {
    const res = await fetch(`${API_BASE}/api/teacher/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomCode: code,
        password: passwordEntered
      })
    });
    return res.status === 200;
  } catch (error) {
    console.error('Password verification failed:', error);
    return false;
  }
};

export const checkRoomExists = async (code: string): Promise<boolean> => {
  const path = `rooms/${code}`;
  try {
    const roomRef = doc(db, 'rooms', code);
    const snap = await getDoc(roomRef);
    return snap.exists();
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
    return false;
  }
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
    const cleanData: any = {
      name: entry.name,
      score: entry.score,
      level: entry.level,
      mode: entry.mode,
      timestamp: serverTimestamp()
    };
    if (entry.roomCode !== undefined && entry.roomCode !== null && entry.roomCode !== '') {
      cleanData.roomCode = entry.roomCode;
    }
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
  const path = 'leaderboard';
  const roomVariations = getRoomCodeVariations(roomCode);
  const q = query(
    collection(db, path),
    where('roomCode', 'in', roomVariations),
    limit(maxResults * 2)
  );

  return onSnapshot(q, (snapshot) => {
    const results = snapshot.docs.map(docSnapshot => {
      const data = docSnapshot.data() as any;
      return { id: docSnapshot.id, ...data } as ScoreEntry;
    });

    const sorted = results.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      const t1 = a.timestamp?.seconds || 0;
      const t2 = b.timestamp?.seconds || 0;
      return t2 - t1;
    }).slice(0, maxResults);

    callback(sorted);
  }, (error) => {
    console.error("error subscribing to leaderboard:", error);
  });
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
