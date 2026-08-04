/**
 * 카카오톡 "나에게 보내기" 최초 설정 (1회만 실행)
 * 실행: node kakao-setup.js
 *
 * 사전 준비 (developers.kakao.com):
 *   1) 애플리케이션 추가하기
 *   2) 앱 설정 > 플랫폼 > Web 등록 → 사이트 도메인 http://localhost:5000
 *   3) 카카오 로그인 > 활성화 ON
 *   4) 카카오 로그인 > Redirect URI 등록 → http://localhost:5000/oauth
 *   5) 카카오 로그인 > 동의항목 > "카카오톡 메시지 전송" 사용 설정
 *   6) 앱 키 > REST API 키 복사
 */
import http from "node:http";
import fs from "node:fs";
import readline from "node:readline/promises";

try { process.loadEnvFile(); } catch { /* .env 없으면 새로 만든다 */ }

const PORT = 5000;
const REDIRECT_URI = `http://localhost:${PORT}/oauth`;

function saveEnv(pairs) {
  let lines = [];
  try { lines = fs.readFileSync(".env", "utf8").split(/\r?\n/); } catch { /* 새 파일 */ }
  for (const [k, v] of Object.entries(pairs)) {
    const i = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (i >= 0) lines[i] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
  }
  fs.writeFileSync(".env", lines.filter((l, i, a) => l !== "" || i < a.length - 1).join("\n"));
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

console.log("\n🔔 카카오톡 알림 설정\n");
console.log("developers.kakao.com 에서 아래를 먼저 완료해주세요:");
console.log("  · 애플리케이션 추가");
console.log("  · 앱 설정 > 플랫폼 > Web → 사이트 도메인  http://localhost:5000");
console.log("  · 카카오 로그인 활성화 ON");
console.log(`  · 카카오 로그인 > Redirect URI  ${REDIRECT_URI}`);
console.log("  · 동의항목 > '카카오톡 메시지 전송' 사용 설정\n");

const restKey = (await rl.question("REST API 키를 붙여넣으세요 ▶ ")).trim();
if (!restKey) { console.log("키가 없습니다. 종료합니다."); process.exit(1); }

const authUrl =
  `https://kauth.kakao.com/oauth/authorize?client_id=${restKey}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=talk_message`;

console.log("\n아래 주소를 브라우저에 붙여넣고 '동의하고 계속하기'를 눌러주세요.\n");
console.log(authUrl);
console.log("\n동의가 끝나면 자동으로 진행됩니다. 기다리는 중...\n");

const code = await new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname !== "/oauth") { res.writeHead(404).end(); return; }
    const c = url.searchParams.get("code");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(c
      ? "<h2>연결되었습니다. 터미널로 돌아가세요.</h2>"
      : "<h2>인가 코드를 받지 못했습니다.</h2>");
    server.close();
    c ? resolve(c) : reject(new Error("인가 코드 없음"));
  });
  server.listen(PORT);
  setTimeout(() => { server.close(); reject(new Error("5분 안에 동의가 완료되지 않았습니다.")); }, 300000);
});

console.log("인가 코드 수신 완료. 토큰 발급 중...");

const res = await fetch("https://kauth.kakao.com/oauth/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    client_id: restKey,
    redirect_uri: REDIRECT_URI,
    code,
  }),
});
const data = await res.json();

if (!data.refresh_token) {
  console.log("❌ 토큰 발급 실패:", JSON.stringify(data).slice(0, 300));
  process.exit(1);
}

saveEnv({ KAKAO_REST_KEY: restKey, KAKAO_REFRESH_TOKEN: data.refresh_token });
console.log("✅ .env 에 저장했습니다.");

// 테스트 발송
process.env.KAKAO_REST_KEY = restKey;
process.env.KAKAO_REFRESH_TOKEN = data.refresh_token;
const { sendKakao } = await import("./notify.js");
await sendKakao("🐮 장수한우곱창 리뷰봇 알림이 연결되었습니다.\n앞으로 실행 결과를 여기로 보내드릴게요.");

console.log("\n카카오톡을 확인해보세요. 메시지가 왔으면 설정 완료입니다.\n");
rl.close();
process.exit(0);
