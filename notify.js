/**
 * 알림 전송 — 솔라피(우선) → 카카오 나에게 보내기(대체)
 *
 * 테스트: node notify.js "보낼 내용"
 *
 * [솔라피 설정] .env
 *   SOLAPI_API_KEY     솔라피 API Key
 *   SOLAPI_API_SECRET  솔라피 API Secret
 *   SOLAPI_FROM        발신번호 (솔라피에 등록된 번호)
 *   SOLAPI_TO          받을 번호
 *   SOLAPI_PFID        (선택) 카카오톡 채널 발신프로필 ID
 *                      · 있으면 친구톡(14원)으로 발송, 실패 시 문자로 대체
 *                      · 없으면 문자(LMS 29원)로 발송
 */
import crypto from "node:crypto";
import fs from "node:fs";

try { process.loadEnvFile(); } catch { /* 시스템 환경변수 사용 */ }

const env = (k) => (process.env[k] || "").trim();
const onlyDigits = (s) => s.replace(/\D/g, "");

/** 문자 요금 기준 바이트 수 (한글·이모지는 2바이트로 계산) */
export function byteLength(s) {
  let n = 0;
  for (const ch of s) n += ch.charCodeAt(0) > 0x7f ? 2 : 1;
  return n;
}

// ─── 솔라피 ───────────────────────────────────────────────────────────────────
async function sendSolapi(text) {
  const key = env("SOLAPI_API_KEY");
  const secret = env("SOLAPI_API_SECRET");
  const from = onlyDigits(env("SOLAPI_FROM"));
  const to = onlyDigits(env("SOLAPI_TO"));
  if (!key || !secret || !from || !to) return null; // 미설정 → 다음 수단으로

  const date = new Date().toISOString();
  const salt = crypto.randomBytes(32).toString("hex");
  const signature = crypto.createHmac("sha256", secret).update(date + salt).digest("hex");

  const body = text.slice(0, 900);

  // 친구톡은 2025-12-31 종료되어 요청해도 브랜드메시지(BMS, 고가)로 대체 발송된다.
  // 따라서 기본은 문자로 보내고, 길이에 따라 SMS(13원)/LMS(29원)를 자동으로 고른다.
  //   SMS 한도 = 90바이트 (한글 2바이트)
  const type = env("SOLAPI_TYPE") || (byteLength(body) <= 90 ? "SMS" : "LMS");

  const message = { to, from, text: body, type };
  if (type === "LMS" || type === "MMS") message.subject = "리뷰봇";

  const res = await fetch("https://api.solapi.com/messages/v4/send", {
    method: "POST",
    headers: {
      Authorization: `HMAC-SHA256 apiKey=${key}, date=${date}, salt=${salt}, signature=${signature}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message }),
  });

  const data = await res.json().catch(() => ({}));
  const code = data.statusCode || data.errorCode;
  if (!res.ok || (code && code !== "2000")) {
    throw new Error(`솔라피 ${res.status} ${code || ""} ${data.statusMessage || data.errorMessage || JSON.stringify(data).slice(0, 150)}`);
  }
  // 실제로 어떤 유형으로 나갔는지 로그에 남긴다 (요금 사고 방지)
  return `솔라피 ${data.type || type} · ${byteLength(body)}바이트`;
}

// ─── 카카오 나에게 보내기 (대체 수단) ─────────────────────────────────────────
function updateEnvFile(key, value) {
  try {
    const lines = fs.readFileSync(".env", "utf8").split(/\r?\n/);
    let found = false;
    const next = lines.map((l) => {
      if (l.startsWith(`${key}=`)) { found = true; return `${key}=${value}`; }
      return l;
    });
    if (!found) next.push(`${key}=${value}`);
    fs.writeFileSync(".env", next.join("\n"));
    process.env[key] = value;
  } catch { /* .env 갱신 실패는 치명적이지 않다 */ }
}

async function sendKakaoMemo(text, linkUrl) {
  const restKey = env("KAKAO_REST_KEY");
  const refresh = env("KAKAO_REFRESH_TOKEN");
  if (!restKey || !refresh) return null;

  const tokenRes = await fetch("https://kauth.kakao.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: restKey, refresh_token: refresh }),
  });
  const token = await tokenRes.json();
  if (!token.access_token) throw new Error(`카카오 토큰 갱신 실패: ${JSON.stringify(token).slice(0, 150)}`);
  if (token.refresh_token) updateEnvFile("KAKAO_REFRESH_TOKEN", token.refresh_token);

  const res = await fetch("https://kapi.kakao.com/v2/api/talk/memo/default/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
    },
    body: new URLSearchParams({
      template_object: JSON.stringify({
        object_type: "text",
        text: text.slice(0, 900),
        link: { web_url: linkUrl, mobile_web_url: linkUrl },
        button_title: "스마트플레이스 열기",
      }),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.result_code !== 0) throw new Error(`카카오 ${JSON.stringify(data).slice(0, 150)}`);
  return "카카오(나에게 보내기)";
}

// ─── 공개 함수 ────────────────────────────────────────────────────────────────
/** 설정된 수단으로 알림을 보낸다. 설정이 없으면 조용히 건너뛴다. */
export async function sendNotify(text, linkUrl = "https://new.smartplace.naver.com") {
  for (const [name, fn] of [["솔라피", () => sendSolapi(text)], ["카카오", () => sendKakaoMemo(text, linkUrl)]]) {
    try {
      const via = await fn();
      if (via) { console.log(`   📨 알림 전송 완료 — ${via}`); return true; }
    } catch (e) {
      console.error(`   ⚠️ ${name} 알림 실패: ${e.message}`);
    }
  }
  console.log("   (알림 미설정 — .env 에 SOLAPI_* 값을 넣으면 전송됩니다)");
  return false;
}

// 이전 이름 호환
export const sendKakao = sendNotify;

// 직접 실행하면 테스트 발송
if (process.argv[1] && process.argv[1].endsWith("notify.js")) {
  const msg = process.argv[2] || "🐮 장수한우곱창 리뷰봇 알림 테스트입니다.";
  console.log("테스트 발송 중...");
  const ok = await sendNotify(msg);
  process.exit(ok ? 0 : 1);
}
