import express from "express";
import cors from "cors";
import puppeteer from "puppeteer-core";
import { execSync } from "child_process";

// Chromium 경로 (환경변수 또는 고정 경로)
function getChromiumPath() {
  const envPath = process.env.CHROMIUM_PATH;
  if (envPath) {
    console.log("Chromium from env:", envPath);
    return envPath;
  }
  const paths = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ];
  for (const p of paths) {
    try {
      execSync(`test -f "${p}"`);
      console.log("Chromium found at:", p);
      return p;
    } catch {}
  }
  console.log("Chromium not found!");
  return null;
}

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const AUTH_TOKEN = process.env.AUTH_TOKEN || "review-bot-2026";

let browser = null;

async function getBrowser() {
  if (browser) {
    try {
      await browser.pages();
    } catch {
      browser = null;
    }
  }
  if (!browser) {
    const executablePath = getChromiumPath();
    console.log("Chromium path:", executablePath);
    browser = await puppeteer.launch({
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
        "--no-zygote",
        "--disable-extensions",
      ],
      defaultViewport: { width: 1280, height: 800 },
      executablePath,
      headless: true,
    });
    console.log("Browser launched successfully");
  }
  return browser;
}

function auth(req, res, next) {
  const token = req.headers["x-auth-token"];
  if (token !== AUTH_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  next();
}

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Naver Review Server Running 🚀" });
});

app.post("/reviews", auth, async (req, res) => {
  const { naverToken, businessId } = req.body;
  if (!naverToken || !businessId) {
    return res.status(400).json({ error: "naverToken and businessId required" });
  }

  let page = null;
  try {
    const b = await getBrowser();
    page = await b.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    // 네이버 쿠키 세팅
    await page.setCookie(
      { name: "NID_AUT", value: naverToken, domain: ".naver.com" },
      { name: "NID_SES", value: naverToken, domain: ".naver.com" }
    );

    // 네이버 로그인 페이지로 이동하여 쿠키 세팅
    await page.goto("https://naver.com", {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });

    // 스마트플레이스 리뷰 페이지로 이동 + 네트워크 요청 가로채기
    let capturedReviews = null;
    let capturedUrl = null;

    page.on("response", async (response) => {
      const url = response.url();
      if (
        url.includes("review") &&
        url.includes(businessId) &&
        !url.includes(".css") &&
        !url.includes(".js")
      ) {
        try {
          const text = await response.text();
          if (!text.startsWith("<") && text.includes("{")) {
            const data = JSON.parse(text);
            const items = data.items || data.reviews || data.list || data.contents;
            if (items && items.length > 0) {
              capturedReviews = items;
              capturedUrl = url;
              console.log("Captured reviews from:", url);
            }
          }
        } catch {}
      }
    });

    await page.goto(
      `https://smartplace.naver.com/places/${businessId}/reviews`,
      { waitUntil: "networkidle2", timeout: 30000 }
    );

    // 잠시 대기
    await new Promise(r => setTimeout(r, 3000));

    await page.close();

    if (!capturedReviews) {
      return res.status(500).json({ error: "리뷰를 찾지 못했습니다. 로그인 상태를 확인해주세요." });
    }

    const reviews = capturedReviews.map((r) => ({
      id: String(r.id || r.reviewId || Math.random()),
      platform: "naver",
      author: r.writer?.nickname || r.authorName || "익명",
      date: (r.createdAt || r.createDate || "").slice(0, 10),
      rating: r.starRating || r.rating || 5,
      content: r.body || r.content || r.text || "",
      tags: (r.keywords || r.tags || []).map((k) => k.text || k.name || k),
      replied: !!(r.reply || r.ownerReply),
      existingReply: r.reply?.body || r.ownerReply?.content || "",
      images: (r.photos?.length || 0) > 0,
    }));

    res.json({ reviews, source: capturedUrl });

  } catch (e) {
    if (page) await page.close().catch(() => {});
    browser = null;
    console.error("Reviews error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post("/reply", auth, async (req, res) => {
  const { naverToken, businessId, reviewId, replyContent } = req.body;
  if (!naverToken || !businessId || !reviewId || !replyContent) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  let page = null;
  try {
    const b = await getBrowser();
    page = await b.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
    );

    await page.setCookie(
      { name: "NID_AUT", value: naverToken, domain: ".naver.com" },
      { name: "NID_SES", value: naverToken, domain: ".naver.com" }
    );

    await page.goto("https://smartplace.naver.com", {
      waitUntil: "networkidle2",
      timeout: 30000,
    });

    const result = await page.evaluate(async (bizId, revId, content) => {
      const endpoints = [
        `https://smartplace.naver.com/businessticket/v1/businesses/${bizId}/reviews/${revId}/reply`,
        `https://smartplace.naver.com/v1/businesses/${bizId}/reviews/${revId}/reply`,
      ];
      for (const url of endpoints) {
        try {
          const r = await fetch(url, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content }),
          });
          if (r.ok) return { ok: true };
          const text = await r.text();
          if (!text.startsWith("<")) return { ok: false, error: text };
        } catch (e) {
          continue;
        }
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
