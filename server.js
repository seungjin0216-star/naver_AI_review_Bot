import express from "express";
import cors from "cors";
import puppeteer from "puppeteer-core";
import { execSync } from "child_process";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const AUTH_TOKEN = process.env.AUTH_TOKEN || "review-bot-2026";

let browser = null;

function getChromiumPath() {
  const envPath = process.env.CHROMIUM_PATH;
  if (envPath) return envPath;
  const paths = ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"];
  for (const p of paths) {
    try { execSync(`test -f "${p}"`); return p; } catch {}
  }
  return null;
}

async function getBrowser() {
  if (browser) {
    try { await browser.pages(); return browser; } catch { browser = null; }
  }
  browser = await puppeteer.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--single-process", "--no-zygote"],
    defaultViewport: { width: 1280, height: 800 },
    executablePath: getChromiumPath(),
    headless: true,
  });
  console.log("Browser launched");
  return browser;
}

function auth(req, res, next) {
  if (req.headers["x-auth-token"] !== AUTH_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  next();
}

app.get("/", (req, res) => res.json({ status: "ok" }));

// ─────────────────────────────────────────
// 네이버 로그인 → 세션 쿠키 반환
// ─────────────────────────────────────────
app.post("/login", auth, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "username and password required" });

  let page = null;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

    // 네이버 로그인 페이지
    await page.goto("https://nid.naver.com/nidlogin.login", { waitUntil: "networkidle2", timeout: 30000 });

    // 아이디/비번 입력 (키보드 타이핑 방식 - 봇 탐지 우회)
    await page.click("#id");
    await page.keyboard.type(username, { delay: 80 });
    await page.click("#pw");
    await page.keyboard.type(password, { delay: 80 });

    // 로그인 버튼 클릭
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch(() => {}),
      page.click(".btn_login"),
    ]);

    // 현재 URL 확인
    const currentUrl = page.url();
    console.log("After login URL:", currentUrl);

    // 캡차 또는 추가 인증 체크
    if (currentUrl.includes("captcha") || currentUrl.includes("login")) {
      await page.close();
      return res.status(400).json({ error: "로그인 실패: 캡차 또는 추가 인증이 필요합니다. 네이버 앱에서 먼저 로그인해주세요." });
    }

    // 쿠키 획득
    const cookies = await page.cookies();
    const nidAut = cookies.find(c => c.name === "NID_AUT")?.value;
    const nidSes = cookies.find(c => c.name === "NID_SES")?.value;

    await page.close();

    if (!nidAut || !nidSes) {
      return res.status(400).json({ error: "로그인 실패: 네이버 계정 정보를 확인해주세요." });
    }

    console.log("Login successful, cookies obtained");
    res.json({ success: true, nidAut, nidSes });

  } catch (e) {
    if (page) await page.close().catch(() => {});
    browser = null;
    console.error("Login error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
// 리뷰 가져오기 (실제 세션 쿠키 사용)
// ─────────────────────────────────────────
app.post("/reviews", auth, async (req, res) => {
  const { nidAut, nidSes, businessId } = req.body;
  if (!nidAut || !nidSes || !businessId) return res.status(400).json({ error: "nidAut, nidSes, businessId required" });

  let page = null;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

    // 실제 네이버 세션 쿠키 세팅
    await page.setCookie(
      { name: "NID_AUT", value: nidAut, domain: ".naver.com", path: "/" },
      { name: "NID_SES", value: nidSes, domain: ".naver.com", path: "/" }
    );

    // 네트워크 요청 가로채기
    let capturedReviews = null;
    let capturedUrl = null;

    page.on("response", async (response) => {
      const url = response.url();
      if (url.includes("review") && (url.includes(businessId) || url.includes("place")) && !url.endsWith(".js") && !url.endsWith(".css")) {
        try {
          const text = await response.text();
          if (!text.trim().startsWith("<") && text.includes("{")) {
            const data = JSON.parse(text);
            const items = data.items || data.reviews || data.list || data.contents || data.result?.reviews;
            if (items && items.length > 0 && !capturedReviews) {
              capturedReviews = items;
              capturedUrl = url;
              console.log("✅ Captured reviews from:", url, "count:", items.length);
            }
          }
        } catch {}
      }
    });

    await page.goto(`https://smartplace.naver.com/places/${businessId}/reviews`, {
      waitUntil: "networkidle2",
      timeout: 30000,
    });

    await new Promise(r => setTimeout(r, 3000));
    await page.close();

    if (!capturedReviews) {
      return res.status(500).json({ error: "리뷰를 찾지 못했습니다. 로그인 세션이 만료됐을 수 있습니다." });
    }

    const reviews = capturedReviews.map(r => ({
      id: String(r.id || r.reviewId || Math.random()),
      platform: "naver",
      author: r.writer?.nickname || r.writerInfo?.nickname || r.authorName || "익명",
      date: (r.createdAt || r.createDate || "").slice(0, 10),
      rating: r.starRating || r.rating || 5,
      content: r.body || r.content || r.text || "",
      tags: (r.keywords || r.tags || []).map(k => k.text || k.name || k),
      replied: !!(r.reply || r.ownerReply),
      existingReply: r.reply?.body || r.ownerReply?.content || "",
      images: (r.photos?.length || 0) > 0,
    }));

    res.json({ reviews, source: capturedUrl });

  } catch (e) {
    if (page) await page.close().catch(() => {});
    browser = null;
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
// 답글 등록
// ─────────────────────────────────────────
app.post("/reply", auth, async (req, res) => {
  const { nidAut, nidSes, businessId, reviewId, replyContent } = req.body;
  if (!nidAut || !nidSes || !businessId || !reviewId || !replyContent) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  let page = null;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36");

    await page.setCookie(
      { name: "NID_AUT", value: nidAut, domain: ".naver.com", path: "/" },
      { name: "NID_SES", value: nidSes, domain: ".naver.com", path: "/" }
    );

    await page.goto("https://smartplace.naver.com", { waitUntil: "networkidle2", timeout: 30000 });

    const result = await page.evaluate(async (bizId, revId, content) => {
      const urls = [
        `https://smartplace.naver.com/businessticket/v1/businesses/${bizId}/reviews/${revId}/reply`,
        `https://smartplace.naver.com/v1/businesses/${bizId}/reviews/${revId}/reply`,
      ];
      for (const url of urls) {
        try {
          const r = await fetch(url, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content }),
          });
          if (r.ok) return { ok: true };
          const text = await r.text();
          if (!text.startsWith("<")) return { ok: false, error: `${r.status}: ${text.slice(0, 200)}` };
        } catch (e) { continue; }
      }
      return { ok: false, error: "답글 등록 실패" };
    }, businessId, reviewId, replyContent);

    await page.close();
    if (!result.ok) return res.status(500).json({ error: result.error });
    res.json({ success: true });

  } catch (e) {
    if (page) await page.close().catch(() => {});
    browser = null;
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
