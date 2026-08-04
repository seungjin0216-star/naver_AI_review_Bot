/**
 * 카카오톡 "나에게 보내기" 알림
 *
 * 최초 1회 `node kakao-setup.js` 로 토큰을 발급받아야 한다.
 * .env 에 KAKAO_REST_KEY, KAKAO_REFRESH_TOKEN 이 있으면 동작한다.
 *
 * 카카오 access_token 은 6시간, refresh_token 은 2개월짜리다.
 * refresh_token 은 사용할 때마다 만료가 1개월 미만이면 자동으로 새로 발급되므로,
 * 봇이 매일 도는 한 사실상 끊기지 않는다.
 */
import fs from "node:fs";

const REST_KEY = () => process.env.KAKAO_REST_KEY;
const REFRESH  = () => process.env.KAKAO_REFRESH_TOKEN;

// 새 refresh_token 이 내려오면 .env 에 갱신해 둔다
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

async function getAccessToken() {
  const res = await fetch("https://kauth.kakao.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: REST_KEY(),
      refresh_token: REFRESH(),
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`토큰 갱신 실패: ${JSON.stringify(data).slice(0, 200)}`);
  }
  // 카카오가 refresh_token 을 새로 주면 저장
  if (data.refresh_token) updateEnvFile("KAKAO_REFRESH_TOKEN", data.refresh_token);
  return data.access_token;
}

/** 카카오톡 나에게 메시지 보내기. 설정이 없으면 조용히 건너뛴다. */
export async function sendKakao(text, linkUrl = "https://new.smartplace.naver.com") {
  if (!REST_KEY() || !REFRESH()) {
    console.log("   (카톡 알림 미설정 — node kakao-setup.js 로 설정할 수 있습니다)");
    return false;
  }
  try {
    const accessToken = await getAccessToken();
    const res = await fetch("https://kapi.kakao.com/v2/api/talk/memo/default/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
      },
      body: new URLSearchParams({
        template_object: JSON.stringify({
          object_type: "text",
          text: text.slice(0, 900), // 카카오 텍스트 제한 대응
          link: { web_url: linkUrl, mobile_web_url: linkUrl },
          button_title: "스마트플레이스 열기",
        }),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.result_code !== 0) {
      throw new Error(JSON.stringify(data).slice(0, 200));
    }
    console.log("   📨 카톡 알림 전송 완료");
    return true;
  } catch (e) {
    console.error(`   ⚠️ 카톡 알림 실패: ${e.message}`);
    return false;
  }
}
