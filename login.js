/**
 * 네이버 로그인 (최초 1회 / 세션 만료 시)
 * 실행: node login.js
 *
 * 봇 전용 크롬 프로필에 로그인 세션을 저장한다.
 * 여기서 한 번 로그인해두면 auto-reply.js 가 그 세션을 그대로 사용한다.
 */
import readline from "node:readline/promises";
import { launchBrowser, PROFILE_DIR } from "./auto-reply.js";

const CHECK_URL = "https://smartplace.naver.com/bizes/place/8250200/reviews";

console.log(`\n🔐 네이버 로그인`);
console.log(`   프로필 위치: ${PROFILE_DIR}\n`);

const browser = await launchBrowser(false); // 반드시 창을 띄운다
const page = (await browser.pages())[0] || (await browser.newPage());

await page.goto("https://nid.naver.com/nidlogin.login", { waitUntil: "domcontentloaded" });

console.log("👉 방금 열린 크롬 창에서 네이버에 로그인해주세요.");
console.log("   (아이디/비밀번호는 형이 직접 입력하셔야 합니다)");
console.log("   로그인이 끝나면 이 터미널로 돌아와 Enter 를 누르세요.\n");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await rl.question("로그인 완료 후 Enter ▶ ");
rl.close();

// 실제로 스마트플레이스에 접근되는지 확인
console.log("\n확인 중...");
await page.goto(CHECK_URL, { waitUntil: "networkidle2", timeout: 30000 });
const finalUrl = page.url();

if (finalUrl.includes("nid.naver.com") || finalUrl.includes("nidlogin")) {
  console.log("❌ 아직 로그인되지 않았습니다. 다시 시도해주세요.");
} else {
  console.log("✅ 로그인 성공! 세션이 프로필에 저장됐습니다.");
  console.log("   이제 `node auto-reply.js` 를 실행하시면 됩니다.");
}

await browser.close();
