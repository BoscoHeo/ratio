# 운영 적용 기록

2026-11-17 사용자가 운영 반영과 최소 서명 권한 추가를 승인했다.

- 기준 소스: f3209640b43ce19f8766d320ec62b0eb4a6d5d58
- 운영 규칙 백업: 작업 산출물의 ratio-deployment/rules-before.json
- Firebase api 서버: Node.js 22로 업데이트 완료. Node.js 20은 배포 서비스에서 지원 종료로 거부되어 변경했다.
- IAM: 실행 서비스 계정 자신에게만 iam.serviceAccounts.signBlob 단일 권한 역할 부여. 서비스 계정 키는 생성하지 않았다.
- 로컬 검증: 보안/API 테스트 18개, TypeScript, Functions 빌드, Vite 빌드 통과. 교사·학생 별도 브라우저 세션에서 1문항 점수 동기화 확인.
- 화면과 제한 Rules 전환 전 운영 토큰 발급·교환을 확인한다. 최종 결과는 후속 기록으로 남긴다.
