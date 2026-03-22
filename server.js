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
  for (const p of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]) {
    try { execSync(`test -f "${p}"`); return p; } catch {}
  }
  return null;
}

async function getBrowser() {
  if (browser) {
    try { await browser.pages(); return browser; } catch { browser = null; }
  }
  browser = await puppeteer.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
           "--disable-gpu", "--single-process", "--no-zygote"],
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

app.get("/", (req, res) => res.json({ status: "ok", message: "Naver Review Server 🚀" }));

// ─────────────────────────────────────────
// 스마트플레이스 로그인 → 세션 쿠키 반환
// ─────────────────────────────────────────
app.post("/login", auth, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "username, password 필요" });

  let page = null;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    await page.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148");

    // 스마트플레이스 전용 로그인 URL
    await page.goto(
      "https://nid.naver.com/nidlogin.login?mode=form&url=https://smartplace.naver.com/",
      { waitUntil: "networkidle2", timeout: 30000 }
    );

    console.log("Login page loaded:", page.url());

    // 아이디 입력
    await page.waitForSelector("#id", { timeout: 10000 });
    await page.click("#id");
    await new Promise(r => setTimeout(r, 500));
    await page.keyboard.type(username, { delay: 100 });

    // 비번 입력
    await page.click("#pw");
    await new Promise(r => setTimeout(r, 500));
    await page.keyboard.type(password, { delay: 100 });

    // 로그인 버튼
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }).catch(() => {}),
      page.click(".btn_login"),
    ]);

    const afterUrl = page.url();
    console.log("After login URL:", afterUrl);

    // 캡차 체크
    if (afterUrl.includes("captcha") || afterUrl.includes("nidlogin")) {
      const pageContent = await page.content();
      const hasCaptcha = pageContent.includes("captcha") || pageContent.includes("자동입력 방지");
      await page.close();
      if (hasCaptcha) {
        return res.status(400).json({ error: "캡차가 감지됐습니다. 잠시 후 다시 시도해주세요." });
      }
      return res.status(400).json({ error: "로그인 실패. 아이디/비밀번호를 확인해주세요." });
    }

    // 쿠키 획득
    const cookies = await page.cookies();
    const nidAut = cookies.find(c => c.name === "NID_AUT")?.value;
    const nidSes = cookies.find(c => c.name === "NID_SES")?.value;

    await page.close();

    if (!nidAut || !nidSes) {
      return res.status(400).json({ error: "로그인은 됐지만 세션 쿠키를 찾지 못했습니다." });
    }

    console.log("✅ Login success! NID_AUT:", nidAut.slice(0, 10) + "...");
    res.json({ success: true, nidAut, nidSes });

  } catch (e) {
    if (page) await page.close().catch(() => {});
    browser = null;
    console.error("Login error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
// 리뷰 가져오기
// ─────────────────────────────────────────
app.post("/reviews", auth, async (req, res) => {
  const { nidAut, nidSes, businessId } = req.body;
  if (!nidAut || !nidSes || !businessId) return res.status(400).json({ error: "nidAut, nidSes, businessId 필요" });

  let page = null;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36");

    await page.setCookie(
      { name: "NID_AUT", value: nidAut, domain: ".naver.com", path: "/" },
      { name: "NID_SES", value: nidSes, domain: ".naver.com", path: "/" }
    );

    let capturedReviews = null;
    let capturedUrl = null;

    page.on("response", async (response) => {
      const url = response.url();
      if (
        (url.includes("review") || url.includes("Review")) &&
        !url.endsWith(".js") && !url.endsWith(".css") && !url.endsWith(".png")
      ) {
        try {
          const text = await response.text();
          if (!text.trim().startsWith("<") && text.includes("{")) {
            const data = JSON.parse(text);
            const items = data.items || data.reviews || data.list || data.contents || data.result?.reviews;
            if (items && Array.isArray(items) && items.length > 0 && !capturedReviews) {
              capturedReviews = items;
              capturedUrl = url;
              console.log("✅ Reviews captured from:", url, "count:", items.length);
            }
          }
        } catch {}
      }
    });

    // 여러 URL 시도
    const reviewUrls = [
      `https://smartplace.naver.com/places/${businessId}/reviews`,
      `https://smartplace.naver.com/business/${businessId}/review`,
      `https://smartplace.naver.com/${businessId}/review`,
    ];

    for (const url of reviewUrls) {
      if (capturedReviews) break;
      console.log("Navigating to:", url);
      try {
        await page.goto(url, { waitUntil: "networkidle2", timeout: 20000 });
        await new Promise(r => setTimeout(r, 3000));
      } catch (e) {
        console.log("Nav error:", e.message);
      }
    }

    // 추가로 스마트플레이스 관리자 리뷰 페이지도 시도
    if (!capturedReviews) {
      console.log("Trying admin review page...");
      try {
        await page.goto(
          `https://smartplace.naver.com/home`,
          { waitUntil: "networkidle2", timeout: 20000 }
        );
        await new Promise(r => setTimeout(r, 2000));
        // 관리자 페이지에서 직접 API 호출
        const apiResult = await page.evaluate(async (bizId) => {
          const endpoints = [
            `https://smartplace.naver.com/businessticket/v1/businesses/${bizId}/reviews?page=1&size=20&sorted=RECENTLY`,
            `https://smartplace.naver.com/v1/businesses/${bizId}/reviews?page=1&size=20`,
            `https://smartplace.naver.com/api/v1/businesses/${bizId}/reviews?page=1&size=20`,
          ];
          for (const url of endpoints) {
            try {
              const r = await fetch(url, {
                credentials: "include",
                headers: { Accept: "application/json" },
              });
              const text = await r.text();
              console.log("API try:", url, r.status, text.slice(0, 100));
              if (!text.trim().startsWith("<") && r.ok) {
                const data = JSON.parse(text);
                const items = data.items || data.reviews || data.list || data.contents;
                if (items && items.length > 0) return { ok: true, items, url };
              }
            } catch (e) { continue; }
          }
          return { ok: false };
        }, businessId);

        if (apiResult.ok) {
          capturedReviews = apiResult.items;
          capturedUrl = apiResult.url;
          console.log("✅ Got reviews via admin API! count:", capturedReviews.length);
        }
      } catch (e) {
        console.log("Admin page error:", e.message);
      }
    }

    await page.close();

    if (!capturedReviews) {
      return res.status(500).json({ error: "리뷰를 찾지 못했습니다. 로그인 세션을 다시 확인해주세요." });
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
    return res.status(400).json({ error: "필수 값 누락" });
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
