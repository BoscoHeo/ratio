if(!process.env.GCLOUD_PROJECT?.startsWith('demo-') || !process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw Error('로컬 demo 에뮬레이터 전용');
const {app}=require('../functions/lib/index.js');
const server=app.listen(5107,'127.0.0.1',async()=>{
 const r=await fetch('http://127.0.0.1:5107/api/room/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({roomCode:'ui-room',teacher:'가상교사',password:'ui-test-pass-2026'})});
 if(r.status!==201)throw Error('시험방 준비 실패');
 console.log('로컬 시험 API 준비 완료: http://127.0.0.1:5107');
});
process.on('SIGINT',()=>server.close(()=>process.exit()));
