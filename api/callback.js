export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const { code, state } = req.query;
  if (!code) return res.status(400).json({ error: "code is required" });

  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;

  try {
    // 1. 액세스 토큰 발급
    const tokenRes = await fetch(
      `https://nid.naver.com/oauth2.0/token?grant_type=authorization_code&client_id=${clientId}&client_secret=${clientSecret}&code=${code}&state=${state}`,
      { method: "GET" }
    );
    const tokenData = await tokenRes.json();
    if (tokenData.error) throw new Error(tokenData.error_description);

    const accessToken = tokenData.access_token;

    // 2. 사용자 프로필 조회
    const profileRes = await fetch("https://openapi.naver.com/v1/nid/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const profileData = await profileRes.json();

    // 3. 토큰을 쿠키에 저장 후 메인 페이지로 리디렉션
    res.setHeader("Set-Cookie", [
      `naver_token=${accessToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600`,
      `naver_name=${encodeURIComponent(profileData.response?.name || "사장님")}; Path=/; Max-Age=3600`,
    ]);

    res.redirect(302, "/?login=success");

  } catch (e) {
    res.redirect(302, "/?login=error&msg=" + encodeURIComponent(e.message));
  }
}
