import { onRequest } from "firebase-functions/v2/https";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue, DocumentReference } from "firebase-admin/firestore";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import crypto from "crypto";
import { getAuth } from "firebase-admin/auth";

// 1. Firebase Admin SDK 초기화 (Application Default Credentials 사용)
const adminApp = getApps().length ? getApps()[0] : initializeApp();
const FIRESTORE_DATABASE_ID = "ai-studio-db5afd57-723c-40d3-bd17-b9f24e370ff2";

// 에뮬레이터 환경에서는 로컬 인스턴스, 프로덕션 GCP 런타임에서는 명시적 Named Database 연결
const isEmulator = Boolean(process.env.FUNCTIONS_EMULATOR || process.env.FIRESTORE_EMULATOR_HOST);
const db = isEmulator
  ? getFirestore(adminApp)
  : getFirestore(adminApp, FIRESTORE_DATABASE_ID);

// 2. 방 코드 변형 유틸리티 (공백/하이픈 등 입력 포맷 정규화)
export function getRoomCodeVariations(code: string): string[] {
  const clean = (code || "").trim().toLowerCase().replace(/[/\\?#]/g, "");
  if (!clean) return [];
  const variations = new Set<string>();

  variations.add(clean);
  const noSpace = clean.replace(/\s+/g, "");
  variations.add(noSpace);
  const noSpaceNoHyphen = clean.replace(/[\s-]+/g, "");
  variations.add(noSpaceNoHyphen);

  const match = noSpace.match(/^([가-힣a-zA-Z0-9_]+?)[-]?(\d+)(?:[-]?(\d+))?$/);
  if (match) {
    const textPart = match[1];
    const num1 = match[2];
    const num2 = match[3] || "";

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
}

// 3. Node 내장 crypto.scrypt 기반 비밀번호 해싱 및 검증 유틸
export function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString("hex");
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(`scrypt$v1$${salt}$${derivedKey.toString("hex")}`);
    });
  });
}

export function verifyPassword(password: string, combinedHash: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!combinedHash || !combinedHash.startsWith("scrypt$v1$")) {
      return resolve(false);
    }
    const parts = combinedHash.split("$");
    if (parts.length !== 4) return resolve(false);

    const salt = parts[2];
    const storedKeyHex = parts[3];

    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) return resolve(false);
      const storedKeyBuffer = Buffer.from(storedKeyHex, "hex");
      if (storedKeyBuffer.length !== derivedKey.length) return resolve(false);
      resolve(crypto.timingSafeEqual(storedKeyBuffer, derivedKey));
    });
  });
}

// 4. IP 기반 인메모리 Rate Limiter (단일 인스턴스 보호용, multi-instance 분산 환경에서는 인스턴스별 제한)
interface RateLimitRecord {
  count: number;
  resetAt: number;
}
const rateLimitMap = new Map<string, RateLimitRecord>();

function rateLimiter(limit: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.path + ":" + (req.ip || "unknown");
    const now = Date.now();
    const record = rateLimitMap.get(ip);

    if (!record || now > record.resetAt) {
      rateLimitMap.set(ip, { count: 1, resetAt: now + windowMs });
      return next();
    }

    record.count++;
    if (record.count > limit) {
      res.status(429).json({ error: "요청이 너무 많습니다. 잠시 후 다시 시도해주세요." });
      return;
    }
    next();
  };
}

// 5. Express 앱 구성
export const app = express();

const ALLOWED_ORIGINS = [
  "https://ratio-bj5.pages.dev",
  "https://ratio.pages.dev",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173"
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("CORS not allowed"));
    }
  },
  credentials: true
}));

app.use(express.json({ limit: "16kb" }));


async function teacherAccess(roomCode: string) {
  const secret = db.collection("rooms").doc(roomCode).collection("secret").doc("config");
  const roomVersion = await db.runTransaction(async tx => {
    const snapshot = await tx.get(secret);
    const existing = snapshot.data()?.accessVersion;
    if (typeof existing === "string" && existing) return existing;
    const version = crypto.randomUUID();
    tx.set(secret, { accessVersion: version }, { merge: true });
    return version;
  });
  return getAuth().createCustomToken("teacher_" + crypto.randomUUID(), {
    role: "teacher", roomCode, roomVersion
  });
}

async function findRoom(code: unknown): Promise<string | null> {
  if (typeof code !== "string" || !code.trim() || code.length > 32) return null;
  for (const variation of getRoomCodeVariations(code)) {
    if ((await db.collection("rooms").doc(variation).get()).exists) return variation;
  }
  return null;
}

// 공개 응답에는 존재 여부와 정규화 코드만 넣고 비밀번호·교사 이름은 제외한다.
app.post("/api/room/resolve", rateLimiter(120, 60000), async (req, res) => {
  try {
    const roomCode = await findRoom(req.body?.roomCode);
    res.json({ exists: Boolean(roomCode), roomCode });
  } catch {
    res.status(500).json({ error: "학습방을 확인하지 못했습니다." });
  }
});

// 방 코드를 알고 참여한 학생에게 그 방의 학생 권한만 발급한다.
// 개인 모드는 자기 기록만 읽으며 전체 공개 순위표에는 참여하지 않는다.
app.post("/api/session/join", rateLimiter(120, 60000), async (req, res) => {
  try {
    const requested = req.body?.roomCode;
    if (requested !== undefined && (typeof requested !== "string" || requested.length > 32)) {
      res.status(400).json({ error: "올바른 방 코드를 입력해주세요." }); return;
    }
    const roomCode = requested ? await findRoom(requested) : "";
    if (requested && !roomCode) {
      res.status(404).json({ error: "존재하지 않는 방입니다." }); return;
    }
    let uid = "player_" + crypto.randomUUID();
    const bearer = req.headers.authorization;
    if (bearer) {
      if (!bearer.startsWith("Bearer ")) { res.status(401).json({ error: "다시 입장해주세요." }); return; }
      try { uid = (await getAuth().verifyIdToken(bearer.slice(7))).uid; }
      catch { res.status(401).json({ error: "입장 정보가 만료됐습니다. 다시 입장해주세요." }); return; }
    }
    const customToken = await getAuth().createCustomToken(uid, { role: "player", roomCode: roomCode || "" });
    res.json({ customToken, roomCode: roomCode || "" });
  } catch (error: any) {
    console.error("Session token issuance failed", { code: error?.code, message: error?.message });
    res.status(500).json({ error: "안전한 입장 정보를 만들지 못했습니다." });
  }
});

// 교사 인증 및 점진적 해시 마이그레이션 공통 함수
async function authenticateTeacher(roomCode: string, passwordEntered: string): Promise<{ success: boolean; resolvedCode?: string; error?: string }> {
  if (!roomCode || typeof roomCode !== "string" || roomCode.length > 32 || !passwordEntered || typeof passwordEntered !== "string" || passwordEntered.length > 64) {
    return { success: false, error: "방 코드와 비밀번호를 올바르게 입력해주세요." };
  }

  const variations = getRoomCodeVariations(roomCode);
  let targetRef: DocumentReference | null = null;
  let targetCode = "";

  for (const v of variations) {
    const ref = db.collection("rooms").doc(v);
    const snap = await ref.get();
    if (snap.exists) {
      targetRef = ref;
      targetCode = v;
      break;
    }
  }

  if (!targetRef) {
    return { success: false, error: "존재하지 않는 방입니다." };
  }

  const secretRef = targetRef.collection("secret").doc("config");
  const secretSnap = await secretRef.get();

  if (secretSnap.exists) {
    const passwordHash = secretSnap.data()?.passwordHash;
    const isValid = await verifyPassword(passwordEntered, passwordHash);
    if (!isValid) return { success: false, error: "비밀번호가 올바르지 않습니다." };
    return { success: true, resolvedCode: targetCode };
  }

  // Legacy 지원: root 문서의 평문 password 확인
  const rootSnap = await targetRef.get();
  const legacyPassword = rootSnap.data()?.password || "1234";

  // 문자열 비교 (길이 일치 확인 후 timingSafeEqual 또는 안전 비교)
  const isLegacyMatch = (legacyPassword === passwordEntered);
  if (!isLegacyMatch) {
    return { success: false, error: "비밀번호가 올바르지 않습니다." };
  }

  // 성공 시 Progressive Migration: secret/config에 passwordHash 저장 후 root 평문 password 삭제
  try {
    const newHash = await hashPassword(passwordEntered);
    const batch = db.batch();
    batch.set(secretRef, {
      passwordHash: newHash,
      migratedAt: FieldValue.serverTimestamp()
    });
    batch.update(targetRef, {
      password: FieldValue.delete()
    });
    await batch.commit();
  } catch (err) {
    console.error("Legacy password migration failed:", err);
  }

  return { success: true, resolvedCode: targetCode };
}

// ----------------------------------------------------------------------
// API 1: 방 생성 (POST /api/room/create)
// ----------------------------------------------------------------------
app.post("/api/room/create", rateLimiter(20, 60000), async (req: Request, res: Response): Promise<void> => {
  try {
    const { roomCode, teacher, password } = req.body;

    if (!roomCode || typeof roomCode !== "string" || roomCode.trim().length === 0 || roomCode.trim().length > 32) {
      res.status(400).json({ error: "올바른 방 코드를 입력해주세요 (1~32자)." });
      return;
    }
    if (!teacher || typeof teacher !== "string" || teacher.trim().length === 0 || teacher.trim().length > 32) {
      res.status(400).json({ error: "올바른 교사 성함을 입력해주세요 (1~32자)." });
      return;
    }

    const cleanCode = roomCode.trim().toLowerCase().replace(/[/\\?#]/g, "");
    if (!cleanCode) { res.status(400).json({ error: "올바른 방 코드를 입력해주세요." }); return; }
    const cleanTeacher = teacher.trim();
    const rawPassword = typeof password === "string" ? password.trim() : "";

    if (rawPassword.length < 8 || rawPassword.length > 64 || rawPassword === "12345678") {
      res.status(400).json({ error: "새 방 비밀번호는 추측하기 어려운 8~64자로 정해주세요." });
      return;
    }

    const roomRef = db.collection("rooms").doc(cleanCode);
    const secretRef = roomRef.collection("secret").doc("config");

    // 원자적 생성 (기존 방 덮어쓰기 방지)
    const passwordHash = await hashPassword(rawPassword);

    await db.runTransaction(async (transaction) => {
      const existing = await transaction.get(roomRef);
      if (existing.exists) {
        throw new Error("ROOM_ALREADY_EXISTS");
      }

      // Root 문서: 공개 메타데이터만 저장 (비밀번호/해시 없음)
      transaction.set(roomRef, {
        code: cleanCode,
        teacher: cleanTeacher,
        createdAt: FieldValue.serverTimestamp()
      });

      // Secret 서브컬렉션: passwordHash 격리 저장
      transaction.set(secretRef, {
        passwordHash,
        accessVersion: crypto.randomUUID(),
        createdAt: FieldValue.serverTimestamp()
      });
    });

    res.status(201).json({
      success: true,
      roomCode: cleanCode,
      teacher: cleanTeacher,
      customToken: await teacherAccess(cleanCode)
    });
  } catch (error: any) {
    if (error.message === "ROOM_ALREADY_EXISTS") {
      res.status(409).json({ error: "이미 존재하는 방 코드입니다." });
      return;
    }
    console.error("Room creation error:", error);
    res.status(500).json({ error: "방 생성 중 오류가 발생했습니다." });
  }
});

// ----------------------------------------------------------------------
// API 2: 교사 비밀번호 검증 (POST /api/teacher/verify)
// ----------------------------------------------------------------------
app.post("/api/teacher/verify", rateLimiter(30, 60000), async (req: Request, res: Response): Promise<void> => {
  try {
    const { roomCode, password } = req.body;
    const authResult = await authenticateTeacher(roomCode, password);

    if (!authResult.success) {
      res.status(401).json({ error: authResult.error || "인증 실패" });
      return;
    }

    res.status(200).json({
      success: true,
      resolvedCode: authResult.resolvedCode,
      customToken: await teacherAccess(authResult.resolvedCode!)
    });
  } catch (error) {
    console.error("Teacher verify error:", error);
    res.status(500).json({ error: "인증 처리 중 오류가 발생했습니다." });
  }
});

// ----------------------------------------------------------------------
// API 3: 개별 학생 기록 삭제 (POST /api/teacher/delete-score)
// ----------------------------------------------------------------------
app.post("/api/teacher/delete-score", rateLimiter(60, 60000), async (req: Request, res: Response): Promise<void> => {
  try {
    const { roomCode, password, scoreId } = req.body;

    if (!scoreId || typeof scoreId !== "string") {
      res.status(400).json({ error: "삭제할 점수 ID가 필요합니다." });
      return;
    }

    const authResult = await authenticateTeacher(roomCode, password);
    if (!authResult.success || !authResult.resolvedCode) {
      res.status(401).json({ error: authResult.error || "인증 실패" });
      return;
    }

    const scoreRef = db.collection("leaderboard").doc(scoreId);
    const scoreSnap = await scoreRef.get();

    if (!scoreSnap.exists) {
      res.status(404).json({ error: "기록을 찾을 수 없습니다." });
      return;
    }

    // 소속 검증: 삭제하려는 점수가 인증된 방 코드에 속해 있는지 확인
    const scoreData = scoreSnap.data();
    const scoreRoomCode = scoreData?.roomCode;
    if (!scoreRoomCode || scoreRoomCode !== authResult.resolvedCode) {
      res.status(403).json({ error: "다른 방의 학생 기록은 삭제할 수 없습니다." });
      return;
    }

    await scoreRef.delete();
    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Delete score error:", error);
    res.status(500).json({ error: "점수 삭제 중 오류가 발생했습니다." });
  }
});

// ----------------------------------------------------------------------
// API 4: 방 전체 학생 기록 초기화 (POST /api/teacher/clear-room)
// ----------------------------------------------------------------------
app.post("/api/teacher/clear-room", rateLimiter(15, 60000), async (req: Request, res: Response): Promise<void> => {
  try {
    const { roomCode, password } = req.body;

    const authResult = await authenticateTeacher(roomCode, password);
    if (!authResult.success || !authResult.resolvedCode) {
      res.status(401).json({ error: authResult.error || "인증 실패" });
      return;
    }

    const snapshot = await db.collection("leaderboard")
      .where("roomCode", "==", authResult.resolvedCode)
      .get();

    if (snapshot.empty) {
      res.status(200).json({ success: true, count: 0 });
      return;
    }

    // 배치 삭제 처리 (최대 500개씩 분할)
    const batches = [];
    let currentBatch = db.batch();
    let count = 0;

    for (const doc of snapshot.docs) {
      currentBatch.delete(doc.ref);
      count++;
      if (count % 450 === 0) {
        batches.push(currentBatch.commit());
        currentBatch = db.batch();
      }
    }
    batches.push(currentBatch.commit());
    await Promise.all(batches);

    res.status(200).json({ success: true, count: snapshot.size });
  } catch (error) {
    console.error("Clear room error:", error);
    res.status(500).json({ error: "방 전체 기록 초기화 중 오류가 발생했습니다." });
  }
});

// ----------------------------------------------------------------------
// API 5: 방 비밀번호 변경 (POST /api/teacher/change-password)
// ----------------------------------------------------------------------
app.post("/api/teacher/change-password", rateLimiter(15, 60000), async (req: Request, res: Response): Promise<void> => {
  try {
    const { roomCode, password, newPassword } = req.body;

    if (!newPassword || typeof newPassword !== "string" || newPassword.trim().length < 8 || newPassword.trim().length > 64) {
      res.status(400).json({ error: "새 비밀번호는 8~64자여야 합니다." });
      return;
    }

    const authResult = await authenticateTeacher(roomCode, password);
    if (!authResult.success || !authResult.resolvedCode) {
      res.status(401).json({ error: authResult.error || "기존 비밀번호가 올바르지 않습니다." });
      return;
    }

    const newHash = await hashPassword(newPassword.trim());
    const roomRef = db.collection("rooms").doc(authResult.resolvedCode);
    const secretRef = roomRef.collection("secret").doc("config");

    const batch = db.batch();
    batch.set(secretRef, {
      passwordHash: newHash,
      accessVersion: crypto.randomUUID(),
      updatedAt: FieldValue.serverTimestamp()
    });
    // 혹시 root에 남아있는 레거시 평문 password 필드 제거
    batch.update(roomRef, {
      password: FieldValue.delete()
    });

    await batch.commit();
    res.status(200).json({ success: true, customToken: await teacherAccess(authResult.resolvedCode) });
  } catch (error) {
    console.error("Change password error:", error);
    res.status(500).json({ error: "비밀번호 변경 중 오류가 발생했습니다." });
  }
});

// 405 Method Not Allowed / 404 Not Found 핸들러
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: "요청하신 엔드포인트를 찾을 수 없습니다." });
});

// 6. Cloud Functions 2nd Gen HTTPS 함수 export
export const api = onRequest({
  region: "asia-northeast3",
  cors: false,
  invoker: "public",
  maxInstances: 10
}, app);
