/**
 * 솔라피에 등록된 카카오톡 채널(발신프로필) 목록 조회
 * 실행: node solapi-channels.js
 *
 * .env 의 SOLAPI_API_KEY / SOLAPI_API_SECRET 을 사용한다.
 * 출력되는 pfId 를 .env 의 SOLAPI_PFID 에 넣으면 친구톡으로 발송된다.
 */
import crypto from "node:crypto";

try { process.loadEnvFile(); } catch { /* 시스템 환경변수 사용 */ }

const KEY = (process.env.SOLAPI_API_KEY || "").trim();
const SECRET = (process.env.SOLAPI_API_SECRET || "").trim();

if (!KEY || !SECRET) {
  console.error("❌ .env 에 SOLAPI_API_KEY, SOLAPI_API_SECRET 을 먼저 넣어주세요.");
  process.exit(1);
}

function authHeader() {
  const date = new Date().toISOString();
  const salt = crypto.randomBytes(32).toString("hex");
  const signature = crypto.createHmac("sha256", SECRET).update(date + salt).digest("hex");
  return `HMAC-SHA256 apiKey=${KEY}, date=${date}, salt=${salt}, signature=${signature}`;
}

// v2 / v1 순서로 시도한다 (계정에 따라 지원 버전이 다르다)
const endpoints = [
  "https://api.solapi.com/kakao/v2/channels",
  "https://api.solapi.com/kakao/v1/plus-friends",
];

let found = false;

for (const url of endpoints) {
  try {
    const res = await fetch(url, { headers: { Authorization: authHeader() } });
    const text = await res.text();
    if (!res.ok) {
      console.log(`· ${url.replace("https://api.solapi.com", "")} → ${res.status} ${text.slice(0, 120)}`);
      continue;
    }

    const data = JSON.parse(text);
    const list = data.channelList || data.plusFriendList || data.data || (Array.isArray(data) ? data : []);
    if (!Array.isArray(list) || list.length === 0) {
      console.log(`· ${url.replace("https://api.solapi.com", "")} → 등록된 채널 없음`);
      continue;
    }

    console.log(`\n✅ 등록된 카카오톡 채널 ${list.length}개\n`);
    for (const c of list) {
      const pfId = c.pfId || c.channelId || c.id || "?";
      const name = c.searchId || c.name || c.channelName || "";
      const status = c.status || c.state || "";
      console.log(`  채널명 : ${name}`);
      console.log(`  pfId   : ${pfId}`);
      if (status) console.log(`  상태   : ${status}`);
      console.log("");
    }
    console.log("→ 위 pfId 를 .env 의 SOLAPI_PFID= 에 넣으면 친구톡으로 발송됩니다.\n");
    found = true;
    break;
  } catch (e) {
    console.log(`· ${url.replace("https://api.solapi.com", "")} → 오류: ${e.message}`);
  }
}

if (!found) {
  console.log("\n채널을 찾지 못했습니다.");
  console.log("솔라피 콘솔 > 카카오 > 채널 관리 에서 직접 확인해주세요. (KA01PF... 형태)");
  console.log("pfId 없이도 문자(LMS)로는 정상 발송됩니다.\n");
}
