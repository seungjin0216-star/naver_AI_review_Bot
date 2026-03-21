import express from "express";
import cors from "cors";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const AUTH_TOKEN = process.env.AUTH_TOKEN || "my-secret-token";

// ─────────────────────────────────────────
// 브라우저 인스턴스 재사용
// ─────────────────────────────────────────
let browser = null;

async function getBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });
    console.log("Browser launched");
  }
  return browser;
}

// ─────────────────────────────────────────
// 인증 미들웨어
// ─────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers["x-auth-token"];
  if (token !== AUTH_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ─────────────────────────────────────────
// 헬스체크
// ─────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Naver Review Server Running" });
});

// ─────────────────────────────────────────
// 네이버 로그인 + 스마트플레이스 리뷰 가져오기
// ─────────────────────────────────────────
app.post("/reviews", auth, async (req, res) => {
  const { naverToken, businessId } = req.body;
  if (!naverToken || !businessId) {
    return res.status(400).json({ error: "naverToken and businessId required" });
  }

  let page = null;
  try {
    const b = await getBrowser();
    page = await b.newPage();

    // User Agent 설정
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    // 네이버 쿠키 설정 (OAuth 토큰 → 네이버 도메인 쿠키)
    await page.setCookie(
      { name: "NID_AUT", value: naverToken, domain: ".naver.com" },
      { name: "NID_SES", value: naverToken, domain: ".naver.com" }
    );

    // 스마트플레이스 리뷰 API 직접 호출
    const response = await page.evaluate(async (bizId) => {
      const urls = [
        `https://smartplace.naver.com/businessticket/v1/businesses/${bizId}/reviews?page=1&size=30&sorted=RECENTLY`,
        `https://smartplace.naver.com/v1/businesses/${bizId}/reviews?page=1&size=30`,
      ];

      for (const url of urls) {
        try {
          const r = await fetch(url, {
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            credentials: "include",
          });
          const text = await r.text();
          if (!text.startsWith("<") && r.ok) {
            return { ok: true, data: JSON.parse(text), url };
          }
        } catch (e) {
          continue;
        }
      }
      return { ok: false, error: "All endpoints failed" };
    }, businessId);

    if (!response.ok) {
      // 쿠키 방식 실패 시 → 스마트플레이스 페이지에서 직접 추출 시도
      await page.goto(
        `https://smartplace.naver.com/places/${businessId}/reviews`,
        { waitUntil: "networkidle2", timeout: 30000 }
      );

      // 페이지 내 리뷰 데이터 추출
      const reviews = await page.evaluate(() => {
        const items = document.querySelectorAll(".ReviewItem, [class*='review-item'], [class*='ReviewItem']");
        return Array.from(items).map((el, i) => ({
          id: `review_${i}`,
          platform: "naver",
          author: el.querySelector("[class*='writer'], [class*='name']")?.textContent?.trim() || "익명",
          date: el.querySelector("[class*='date'], time")?.textContent?.trim() || "",
          rating: el.querySelectorAll("[class*='star'][class*='active'], [class*='filled']").length || 5,
          content: el.querySelector("[class*='body'], [class*='content'], p")?.textContent?.trim() || "",
          tags: [],
          replied: !!el.querySelector("[class*='reply'], [class*='owner']"),
          existingReply: el.querySelector("[class*='reply'] p, [class*='owner'] p")?.textContent?.trim() || "",
          images: el.querySelectorAll("img").length > 0,
        }));
      });

      await page.close();
      return res.json({ reviews, source: "page-scrape" });
    }

    await page.close();

    // 데이터 정규화
    const data = response.data;
    const items = data.items || data.reviews || data.list || data.contents || [];
    const reviews = items.map((r) => ({
      id: String(r.id || r.reviewId || Math.random()),
      platform: "naver",
      author: r.writer?.nickname || r.writerInfo?.nickname || r.authorName || "익명",
      date: (r.createdAt || r.createDate || "").slice(0, 10),
      rating: r.starRating || r.rating || 5,
      content: r.body || r.content || r.text || "",
      tags: (r.keywords || r.tags || []).map((k) => k.text || k.name || k),
      replied: !!(r.reply || r.ownerReply),
      existingReply: r.reply?.body || r.ownerReply?.content || "",
      images: (r.photos?.length || 0) > 0,
    }));

    res.json({ reviews, source: response.url });
  } catch (e) {
    if (page) await page.close().catch(() => {});
    console.error("Error:", e.message);

    // 브라우저 재시작
    if (browser) {
      await browser.close().catch(() => {});
      browser = null;
    }

    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
// 리뷰 답글 등록
// ─────────────────────────────────────────
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

    // 스마트플레이스로 이동 (쿠키 인증)
    await page.goto("https://smartplace.naver.com", {
      waitUntil: "networkidle2",
      timeout: 30000,
    });

    // 답글 등록 API 호출
    const result = await page.evaluate(async (bizId, revId, content) => {
      const urls = [
        `https://smartplace.naver.com/businessticket/v1/businesses/${bizId}/reviews/${revId}/reply`,
        `https://smartplace.naver.com/v1/businesses/${bizId}/reviews/${revId}/reply`,
      ];

      for (const url of urls) {
        try {
          const r = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ content }),
          });
          if (r.ok) return { ok: true, url };
          const text = await r.text();
          if (!text.startsWith("<")) {
            return { ok: false, error: text, status: r.status };
          }
        } catch (e) {
          continue;
        }
      }
      return { ok: false, error: "All reply endpoints failed" };
    }, businessId, reviewId, replyContent);

    await page.close();

    if (!result.ok) {
      return res.status(500).json({ error: result.error });
    }

    res.json({ success: true });
  } catch (e) {
    if (page) await page.close().catch(() => {});
    if (browser) {
      await browser.close().catch(() => {});
      browser = null;
    }
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
