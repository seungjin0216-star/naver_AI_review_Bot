import express from "express";
import cors from "cors";
import puppeteer from "puppeteer-core";
import { execSync } from "child_process";

// 시스템 Chromium 경로 찾기
function getChromiumPath() {
  const paths = [
    "/run/current-system/sw/bin/chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/nix/var/nix/profiles/default/bin/chromium",
  ];
  for (const p of paths) {
    try {
      execSync(`test -f ${p}`);
      return p;
    } catch {}
  }
  try {
    return execSync("which chromium || which chromium-browser").toString().trim();
  } catch {}
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

    // 스마트플레이스 접속
    await page.goto("https://smartplace.naver.com", {
      waitUntil: "networkidle2",
      timeout: 30000,
    });

    // 리뷰 API 호출
    const result = await page.evaluate(async (bizId) => {
      const endpoints = [
        `https://smartplace.naver.com/businessticket/v1/businesses/${bizId}/reviews?page=1&size=30&sorted=RECENTLY`,
        `https://smartplace.naver.com/v1/businesses/${bizId}/reviews?page=1&size=30`,
      ];
      for (const url of endpoints) {
        try {
          const r = await fetch(url, {
            credentials: "include",
            headers: { Accept: "application/json" },
          });
          const text = await r.text();
          if (!text.trim().startsWith("<") && r.ok) {
            return { ok: true, data: JSON.parse(text), url };
          }
        } catch (e) {
          continue;
        }
      }
      return { ok: false, error: "모든 엔드포인트 실패" };
    }, businessId);

    await page.close();

    if (!result.ok) {
      return res.status(500).json({ error: result.error });
    }

    const items = result.data.items || result.data.reviews || result.data.list || [];
    const reviews = items.map((r) => ({
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

    res.json({ reviews, source: result.url });

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
