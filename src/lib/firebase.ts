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
  onSnapshot,
  deleteDoc
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import { ScoreEntry, Room } from '../types';

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

export const deleteScore = async (scoreId: string) => {
  const path = `leaderboard/${scoreId}`;
  try {
    const docRef = doc(db, 'leaderboard', scoreId);
    await deleteDoc(docRef);
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
};

export const getLeaderboard = async (gameMode: 'single' | 'group' | 'versus', roomCode?: string, maxResults = 50): Promise<ScoreEntry[]> => {
  const path = 'leaderboard';
  try {
    let q;
    if (roomCode) {
      q = query(
        collection(db, path),
        where('roomCode', '==', roomCode),
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

export const createRoom = async (code: string, teacher: string, password?: string) => {
  const path = `rooms/${code}`;
  try {
    const roomRef = doc(db, 'rooms', code);
    await setDoc(roomRef, {
      code,
      teacher,
      password: password || '1234',
      createdAt: serverTimestamp()
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
};

export const updateRoomPassword = async (code: string, newPassword: string) => {
  const path = `rooms/${code}`;
  try {
    const roomRef = doc(db, 'rooms', code);
    await setDoc(roomRef, { password: newPassword }, { merge: true });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
};

export const getRoomCodeVariations = (code: string): string[] => {
  const clean = code.trim().toLowerCase();
  const variations = new Set<string>();
  variations.add(clean);
  variations.add(clean.replace(/\s+/g, '')); // No spaces anywhere

  // Handle Korean/alphabetic character followed by digits boundary: "청곡61" -> "청곡 61"
  const match = clean.match(/^([가-힣a-zA-Z]+)(\d+)$/);
  if (match) {
    variations.add(`${match[1]} ${match[2]}`);
  }

  // Handle spaces between Korean/alphabetic characters and digits: "청곡 61" -> "청곡61"
  const matchedSpace = clean.match(/^([가-힣a-zA-Z]+)\s+(\d+)$/);
  if (matchedSpace) {
    variations.add(`${matchedSpace[1]}${matchedSpace[2]}`);
  }

  return Array.from(variations);
};

export const resolveRoomCode = async (enteredCode: string): Promise<string> => {
  if (!enteredCode) return '';
  const variations = getRoomCodeVariations(enteredCode);
  
  // Check variations in parallel for existence
  const checks = await Promise.all(
    variations.map(async (v) => {
      const roomRef = doc(db, 'rooms', v);
      const snap = await getDoc(roomRef);
      return snap.exists() ? v : null;
    })
  );
  
  // Return the first that exists in DB, or the default trimmed lowercase variation if none
  const matched = checks.find((v) => v !== null);
  return matched || variations[0];
};

export const checkRoomPassword = async (code: string, passwordEntered: string): Promise<boolean> => {
  const path = `rooms/${code}`;
  try {
    const roomRef = doc(db, 'rooms', code);
    const snap = await getDoc(roomRef);
    if (!snap.exists()) return false;
    const data = snap.data();
    const actualPassword = data?.password || '1234';
    return actualPassword === passwordEntered;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
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
  const q = query(
    collection(db, path),
    where('roomCode', '==', roomCode),
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
    handleFirestoreError(error, OperationType.GET, path);
  });
};

export const deleteAllScoresInRoom = async (roomCode: string) => {
  const path = 'leaderboard';
  try {
    const q = query(collection(db, 'leaderboard'), where('roomCode', '==', roomCode));
    const snap = await getDocs(q);
    const deletePromises = snap.docs.map(docSnapshot => deleteDoc(docSnapshot.ref));
    await Promise.all(deletePromises);
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
};
