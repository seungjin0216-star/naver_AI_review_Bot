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
// 답글 등록 (API 우선 → 실패 시 UI 자동화)
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
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36");

    await page.setCookie(
      { name: "NID_AUT", value: nidAut, domain: ".naver.com", path: "/" },
      { name: "NID_SES", value: nidSes, domain: ".naver.com", path: "/" }
    );

    // ── 1단계: 기존 API 직접 호출 시도 ──
    await page.goto("https://smartplace.naver.com", { waitUntil: "networkidle2", timeout: 30000 });

    const apiResult = await page.evaluate(async (bizId, revId, content) => {
      const endpoints = [
        `https://smartplace.naver.com/businessticket/v1/businesses/${bizId}/reviews/${revId}/reply`,
        `https://smartplace.naver.com/v1/businesses/${bizId}/reviews/${revId}/reply`,
        `https://smartplace.naver.com/api/v1/businesses/${bizId}/reviews/${revId}/reply`,
      ];
      for (const url of endpoints) {
        try {
          const r = await fetch(url, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content }),
          });
          if (r.ok) return { ok: true, url };
          const text = await r.text();
          console.log(`[API] ${url} → ${r.status}: ${text.slice(0, 100)}`);
        } catch (e) { continue; }
      }
      return { ok: false };
    }, businessId, reviewId, replyContent);

    if (apiResult.ok) {
      console.log("✅ 답글 API 성공:", apiResult.url);
      await page.close();
      return res.json({ success: true, method: "api" });
    }

    // ── 2단계: UI 자동화 (새 네이버 AI 초안 흐름) ──
    console.log("API 실패 → UI 자동화 시작");

    // 리뷰 관리 페이지로 이동
    const reviewPageUrls = [
      `https://smartplace.naver.com/places/${businessId}/reviews`,
      `https://smartplace.naver.com/business-home/${businessId}/reviews`,
      `https://smartplace.naver.com/${businessId}/reviews`,
    ];
    for (const url of reviewPageUrls) {
      try {
        await page.goto(url, { waitUntil: "networkidle2", timeout: 20000 });
        const found = await page.evaluate(() => !!document.querySelector("[class*='review']"));
        if (found) { console.log("✅ 리뷰 페이지:", url); break; }
      } catch {}
    }
    await new Promise(r => setTimeout(r, 2000));

    // 해당 리뷰의 '답글 작성' 버튼 클릭
    const replyWriteClicked = await page.evaluate((revId) => {
      // reviewId 기반으로 리뷰 컨테이너 탐색
      const containers = document.querySelectorAll("[data-review-id], [data-id]");
      for (const el of containers) {
        if (el.dataset.reviewId === revId || el.dataset.id === revId) {
          const btn = el.querySelector("button");
          if (btn) { btn.click(); return true; }
        }
      }
      // fallback: 텍스트로 버튼 탐색
      const allBtns = Array.from(document.querySelectorAll("button"));
      const writeBtn = allBtns.find(b => b.textContent.trim().includes("답글 작성"));
      if (writeBtn) { writeBtn.click(); return "fallback"; }
      return false;
    }, reviewId);
    console.log("답글 작성 클릭:", replyWriteClicked);

    // 네이버 AI 초안 패널 로딩 대기 (최대 8초)
    await new Promise(r => setTimeout(r, 3000));
    try {
      await page.waitForFunction(
        () => {
          const btns = Array.from(document.querySelectorAll("button, [role='button']"));
          return btns.some(b => b.textContent.includes("이 답글 수정") || b.textContent.includes("답글 수정"));
        },
        { timeout: 8000 }
      );
    } catch {
      console.log("AI 초안 패널 미감지, 계속 진행...");
    }

    // '이 답글 수정' 버튼 클릭
    const editClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, [role='button']"));
      const editBtn = btns.find(b =>
        b.textContent.includes("이 답글 수정") || b.textContent.includes("답글 수정")
      );
      if (!editBtn) return false;
      editBtn.click();
      return true;
    });
    console.log("이 답글 수정 클릭:", editClicked);

    await new Promise(r => setTimeout(r, 1500));

    // textarea 찾아서 내용 교체 (React 상태 업데이트 트리거 포함)
    const textFilled = await page.evaluate((content) => {
      const ta = document.querySelector("textarea");
      if (!ta) return false;
      // React/Vue controlled input 우회
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(ta, content);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, replyContent);
    console.log("텍스트 입력:", textFilled);

    if (!textFilled) {
      await page.close();
      return res.status(500).json({ error: "텍스트 입력창을 찾지 못했습니다. 네이버 UI가 추가로 변경됐을 수 있습니다." });
    }

    await new Promise(r => setTimeout(r, 800));

    // 등록/완료 버튼 클릭
    const submitted = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, [role='button']"));
      const submitBtn = btns.find(b =>
        b.textContent.trim() === "등록" ||
        b.textContent.trim() === "완료" ||
        b.textContent.trim() === "저장" ||
        b.textContent.includes("답글 등록")
      );
      if (!submitBtn) return false;
      submitBtn.click();
      return true;
    });
    console.log("등록 클릭:", submitted);

    await new Promise(r => setTimeout(r, 2000));
    await page.close();

    if (!submitted) {
      return res.status(500).json({ error: "등록 버튼을 찾지 못했습니다." });
    }

    res.json({ success: true, method: "ui" });

  } catch (e) {
    if (page) await page.close().catch(() => {});
    browser = null;
    console.error("Reply error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
