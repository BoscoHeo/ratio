import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, getDocs, query, collection, where, serverTimestamp, deleteDoc } from 'firebase/firestore';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInWithCustomToken } from 'firebase/auth';

const projectId = process.env.GCLOUD_PROJECT || 'demo-ratio-security';
if (!projectId.startsWith('demo-') || !process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  throw Error('demo 프로젝트의 로컬 Auth·Firestore 에뮬레이터에서만 실행할 수 있습니다.');
}
process.env.GCLOUD_PROJECT = projectId;
const env = await initializeTestEnvironment({ projectId, firestore: { rules: await readFile('firestore.rules', 'utf8') } });
const require = createRequire(import.meta.url);
const { app } = require('../functions/lib/index.js');
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const post = async (route, body, bearer) => {
  const headers = { 'Content-Type': 'application/json' };
  if (bearer) headers.Authorization = 'Bearer ' + bearer;
  const r = await fetch(origin + route, { method:'POST', headers, body:JSON.stringify(body) });
  return { status:r.status, data:await r.json() };
};
const claims = (role,roomCode,roomVersion) => ({role,roomCode,...(roomVersion?{roomVersion}:{})});
const dbFor = (uid, c) => env.authenticatedContext(uid,c).firestore();
const score = (ownerId,roomCode='room-a',extra={}) => ({ownerId,roomCode,name:'가상용사',score:10,level:2,mode:'single',timestamp:serverTimestamp(),...extra});
await env.withSecurityRulesDisabled(async ctx => {
  for(const code of ['room-a','room-b']) {
    await setDoc(doc(ctx.firestore(),'rooms',code),{code,teacher:'가상교사'});
    await setDoc(doc(ctx.firestore(),'rooms',code,'secret','config'),{accessVersion:'version-1'});
  }
  await setDoc(doc(ctx.firestore(),'leaderboard','legacy'),{roomCode:'room-a',name:'가상기존기록',score:3,level:1,mode:'single',timestamp:serverTimestamp()});
});
const a = dbFor('player-a',claims('player','room-a'));
const b = dbFor('player-b',claims('player','room-b'));
const peer = dbFor('peer',claims('player','room-a'));
const teacherA = dbFor('teacher-a',claims('teacher','room-a','version-1'));
const teacherB = dbFor('teacher-b',claims('teacher','room-b','version-1'));

try {
  await test('비인증 사용자의 점수 조회와 쓰기를 차단한다', async()=>{
    const unauth=env.unauthenticatedContext().firestore();
    await assertFails(getDocs(collection(unauth,'leaderboard')));
    await assertFails(setDoc(doc(unauth,'leaderboard','unauth'),score('x')));
  });
  await test('학생은 본인 방에 본인 기록만 생성하고 갱신한다',async()=>{
    await assertSucceeds(setDoc(doc(a,'leaderboard','score-a'),score('player-a')));
    await assertSucceeds(setDoc(doc(a,'leaderboard','score-a'),score('player-a','room-a',{score:20})));
    await assertFails(setDoc(doc(a,'leaderboard','fake-owner'),score('peer')));
    await assertFails(setDoc(doc(a,'leaderboard','wrong-room'),score('player-a','room-b')));
  });
  await test('다른 학생과 다른 방은 기록을 읽거나 덮어쓰지 못한다',async()=>{
    await assertFails(getDoc(doc(peer,'leaderboard','score-a')));
    await assertFails(getDoc(doc(b,'leaderboard','score-a')));
    await assertFails(setDoc(doc(peer,'leaderboard','score-a'),score('peer')));
    await assertFails(setDoc(doc(b,'leaderboard','score-a'),score('player-b','room-b')));
  });
  await test('기록 소유자·학급 변경, 임의 필드, 범위 밖 점수를 거부한다',async()=>{
    await assertFails(setDoc(doc(a,'leaderboard','score-a'),score('player-a','room-b')));
    await assertFails(setDoc(doc(a,'leaderboard','score-a'),score('player-a','room-a',{ownerId:'peer'})));
    for(const extra of [{score:101},{score:-1},{score:1.5},{level:0},{level:101},{password:'금지필드'},{timestamp:new Date(0)}]) {
      await assertFails(setDoc(doc(a,'leaderboard','invalid'),score('player-a','room-a',extra)));
    }
  });
  await test('개별 조회와 제한 쿼리만 허용하고 전체 순위표는 거부한다',async()=>{
    await assertSucceeds(getDoc(doc(a,'leaderboard','score-a')));
    await assertSucceeds(getDocs(query(collection(a,'leaderboard'),where('ownerId','==','player-a'),where('roomCode','==','room-a'))));
    await assertFails(getDocs(collection(a,'leaderboard')));
    await assertFails(getDocs(query(collection(a,'leaderboard'),where('roomCode','==','room-a'))));
  });
  await test('교사는 인증한 방만 조회하고 직접 점수를 쓰거나 삭제하지 못한다',async()=>{
    await assertSucceeds(getDocs(query(collection(teacherA,'leaderboard'),where('roomCode','==','room-a'))));
    await assertFails(getDoc(doc(teacherB,'leaderboard','score-a')));
    await assertFails(getDocs(collection(teacherA,'leaderboard')));
    await assertFails(setDoc(doc(teacherA,'leaderboard','teacher-write'),score('teacher-a')));
    await assertFails(deleteDoc(doc(teacherA,'leaderboard','score-a')));
  });
  await test('기존 소유자 없는 기록은 해당 교사만 읽고 학생은 인수하지 못한다',async()=>{
    await assertSucceeds(getDoc(doc(teacherA,'leaderboard','legacy')));
    await assertFails(getDoc(doc(a,'leaderboard','legacy')));
    await assertFails(setDoc(doc(a,'leaderboard','legacy'),score('player-a')));
  });
  await test('개인 모드 기록은 작성자에게만 공개된다',async()=>{
    const personal=dbFor('solo',claims('player',''));
    await assertSucceeds(setDoc(doc(personal,'leaderboard','solo'),score('solo','')));
    await assertSucceeds(getDocs(query(collection(personal,'leaderboard'),where('ownerId','==','solo'),where('roomCode','==',''))));
    await assertFails(getDoc(doc(a,'leaderboard','solo')));
  });
  await test('클라이언트는 방 문서와 비밀번호 저장소를 직접 읽지 못한다',async()=>{
    for(const db of [a,teacherA,env.unauthenticatedContext().firestore()]) {
      await assertFails(getDoc(doc(db,'rooms','room-a')));
      await assertFails(getDoc(doc(db,'rooms','room-a','secret','config')));
    }
  });
  await test('비밀번호 버전을 바꾸면 기존 교사 토큰을 즉시 거부한다',async()=>{
    await env.withSecurityRulesDisabled(ctx=>setDoc(doc(ctx.firestore(),'rooms','room-a','secret','config'),{accessVersion:'version-2'}));
    await assertFails(getDoc(doc(teacherA,'leaderboard','score-a')));
    await assertSucceeds(getDoc(doc(dbFor('teacher-new',claims('teacher','room-a','version-2')),'leaderboard','score-a')));
  });
  let teacherToken,playerToken,firstPlayerId;
  const authApps=[];
  const login=async token=>{
    const instance=initializeApp({projectId,apiKey:'emulator-test-api-key',authDomain:'localhost'},'session-'+authApps.length);
    authApps.push(instance);const auth=getAuth(instance);
    connectAuthEmulator(auth,'http://'+process.env.FIREBASE_AUTH_EMULATOR_HOST,{disableWarnings:true});
    const {user}=await signInWithCustomToken(auth,token);
    return {uid:user.uid,idToken:await user.getIdToken(),claims:(await user.getIdTokenResult()).claims};
  };
  await test('새 방은 약한 기본 비밀번호와 빈 코드를 거부한다',async()=>{
    assert.equal((await post('/api/room/create',{roomCode:'new-room',teacher:'가상교사',password:'1234'})).status,400);
    assert.equal((await post('/api/room/create',{roomCode:'///',teacher:'가상교사',password:'test-pass-2026'})).status,400);
  });
  await test('방 생성은 비밀번호를 노출하지 않고 실제 교사 인증 토큰을 발급한다',async()=>{
    const r=await post('/api/room/create',{roomCode:'api-room',teacher:'가상교사',password:'test-pass-2026'});
    assert.equal(r.status,201);assert.ok(r.data.customToken);assert.equal(r.data.password,undefined);
    const logged=await login(r.data.customToken);teacherToken=logged.idToken;
    assert.equal(logged.claims.role,'teacher');assert.equal(logged.claims.roomCode,'api-room');
    assert.equal((await post('/api/room/create',{roomCode:'api-room',teacher:'가상교사',password:'test-pass-2026'})).status,409);
  });
  await test('방 조회는 존재 여부만 반환하고 잘못된 비밀번호를 거부한다',async()=>{
    const r=await post('/api/room/resolve',{roomCode:'API-ROOM'});
    assert.deepEqual(Object.keys(r.data).sort(),['exists','roomCode']);assert.equal(r.data.roomCode,'api-room');
    assert.equal((await post('/api/teacher/verify',{roomCode:'api-room',password:'wrong'})).status,401);
    assert.equal((await post('/api/teacher/verify',{roomCode:'api-room',password:'test-pass-2026'})).status,200);
  });
  await test('학생 참여는 해당 방 학생 권한만 발급하고 위조 토큰·없는 방을 거부한다',async()=>{
    const r=await post('/api/session/join',{roomCode:'api-room'});assert.equal(r.status,200);
    const player=await login(r.data.customToken);playerToken=player.idToken;firstPlayerId=player.uid;
    assert.equal(player.claims.role,'player');assert.equal(player.claims.roomCode,'api-room');assert.equal(player.claims.roomVersion,undefined);
    assert.equal((await post('/api/session/join',{roomCode:'api-room'},'forged-token')).status,401);
    assert.equal((await post('/api/session/join',{roomCode:'missing-room'})).status,404);
  });
  await test('재입장 시 서버가 검증한 UID를 유지하고 교사 권한을 인수하지 못한다',async()=>{
    const r=await post('/api/session/join',{roomCode:'room-b'},playerToken);
    const player=await login(r.data.customToken);assert.equal(player.uid,firstPlayerId);assert.equal(player.claims.roomCode,'room-b');
    const demoted=await login((await post('/api/session/join',{roomCode:'api-room'},teacherToken)).data.customToken);
    assert.equal(demoted.claims.role,'player');assert.equal(demoted.claims.roomVersion,undefined);
  });
  await test('방 비밀번호 변경으로 접근 버전을 교체하고 예전 비밀번호를 거부한다',async()=>{
    const r=await post('/api/teacher/change-password',{roomCode:'api-room',password:'test-pass-2026',newPassword:'new-test-pass-2026'});
    assert.equal(r.status,200);assert.ok(r.data.customToken);
    assert.equal((await post('/api/teacher/verify',{roomCode:'api-room',password:'test-pass-2026'})).status,401);
    assert.equal((await post('/api/teacher/verify',{roomCode:'api-room',password:'new-test-pass-2026'})).status,200);
  });
  await test('다른 학급 기록 삭제는 서버에서도 차단한다',async()=>{
    const r=await post('/api/teacher/delete-score',{roomCode:'api-room',password:'new-test-pass-2026',scoreId:'score-a'});
    assert.equal(r.status,403);
  });
  await test('Auth 에뮬레이터로 발급한 실제 토큰의 학급과 소유권이 Rules에 적용된다',async()=>{
    const r=await post('/api/session/join',{roomCode:'api-room'});const p=await login(r.data.customToken);
    // 앞선 Rules 테스트는 서명 역할만 지정했다. 여기서는 실제 Custom Token 교환 결과를 사용한다.
    const real=dbFor(p.uid,p.claims);
    await assertSucceeds(setDoc(doc(real,'leaderboard','real-session'),score(p.uid,'api-room')));
    await assertFails(getDoc(doc(real,'leaderboard','score-a')));
  });
  for(const a of authApps) await deleteApp(a);
} finally {
  await env.cleanup();
  await new Promise(resolve=>server.close(resolve));
  // 테스트는 demo 에뮬레이터 메모리 데이터만 사용한다.
  const functionRequire=createRequire(new URL('../functions/package.json',import.meta.url));
  const { getApps, deleteApp:deleteAdminApp }=functionRequire('firebase-admin/app');
  await Promise.all(getApps().map(deleteAdminApp));
}
