/**
 * 네이버 리뷰 자동 답글 스크립트
 * GitHub Actions에서 매일 9시/18시 실행
 * 환경변수: NAVER_NID_AUT, NAVER_NID_SES, GEMINI_API_KEY
 */
import puppeteer from "puppeteer";

const BRANCHES = [
  { name: "백석직영점", businessId: "8250200",  placeId: "1757412660",  greeting: "장수한우곱창 백석직영점" },
  { name: "마곡발산점", businessId: "11542564", placeId: "2073101570",  greeting: "장수한우곱창 마곡발산점" },
];

const NID_AUT        = process.env.NAVER_NID_AUT;
const NID_SES        = process.env.NAVER_NID_SES;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── 브라우저 실행 ───────────────────────────────────────────────────────────
async function launchBrowser() {
  return puppeteer.launch({
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--window-size=1280,800",
    ],
    headless: "new",
    defaultViewport: { width: 1280, height: 800 },
  });
}

// ─── 네이버 쿠키 세션 (로그인 없이 직접 주입) ────────────────────────────────
function getSession() {
  if (!NID_AUT || !NID_SES) throw new Error("NAVER_NID_AUT, NAVER_NID_SES 환경변수가 없습니다.");
  console.log("✅ 네이버 쿠키 세션 사용");
  return { nidAut: NID_AUT, nidSes: NID_SES };
}

// ─── 미답글 리뷰 수집 ─────────────────────────────────────────────────────────
async function fetchUnrepliedReviews(browser, { nidAut, nidSes }, businessId, placeId) {
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
  );
  await page.setCookie(
    { name: "NID_AUT", value: nidAut, domain: ".naver.com", path: "/" },
    { name: "NID_SES", value: nidSes, domain: ".naver.com", path: "/" }
  );

  let captured = null;

  page.on("response", async (response) => {
    if (captured) return;
    const url = response.url();

    // getReviews GraphQL만 타겟
    const isReviewGql = url.includes("graphql") && url.includes("getReviews");
    // REST fallback
    const isReviewRest = !url.includes("graphql") && (url.includes("review") || url.includes("Review"))
                         && !url.endsWith(".js") && !url.endsWith(".css");
    if (!isReviewGql && !isReviewRest) return;

    try {
      const text = await response.text();
      if (text.trim().startsWith("<") || !text.includes("{")) return;

      const data = JSON.parse(text);
      let items = null;

      if (isReviewGql && data.data) {
        // getReviews 응답: data.data.getReviews.* 탐색
        const gql = data.data.getReviews || data.data.reviews || Object.values(data.data)[0];
        if (gql) {
          items = gql.items || gql.reviews || gql.list || gql.contents;
          if (!items) {
            // 한 단계 더 깊이 탐색
            for (const v of Object.values(gql)) {
              if (Array.isArray(v) && v.length > 0) { items = v; break; }
            }
          }
        }
        // 구조 디버깅
        console.log(`   [DEBUG] getReviews: ${text.slice(0, 400)}`);
      } else {
        items = data.items || data.reviews || data.list || data.contents || data.result?.reviews;
      }

      if (items && Array.isArray(items) && items.length > 0) {
        captured = items;
        console.log(`   ✅ 리뷰 캡처: ${items.length}개`);
      }
    } catch {}
  });

  for (const url of [
    `https://smartplace.naver.com/bizes/place/${businessId}/reviews`,
    `https://smartplace.naver.com/places/${businessId}/reviews`,
    `https://smartplace.naver.com/business/${businessId}/review`,
  ]) {
    if (captured) break;
    try {
      console.log(`   이동 중: ${url}`);
      await page.goto(url, { waitUntil: "networkidle2", timeout: 20000 });
      const finalUrl = page.url();
      const title = await page.title();
      console.log(`   현재 URL: ${finalUrl} / 타이틀: ${title}`);
      await delay(4000);
    } catch (e) {
      console.log(`   이동 실패: ${e.message}`);
    }
  }

  // Admin API fallback
  if (!captured) {
    console.log(`   API 직접 호출 시도...`);
    try {
      await page.goto("https://smartplace.naver.com/home", { waitUntil: "networkidle2", timeout: 20000 });
      await delay(2000);
      const result = await page.evaluate(async (bizId) => {
        const log = [];
        for (const url of [
          `https://smartplace.naver.com/businessticket/v1/businesses/${bizId}/reviews?page=1&size=20&sorted=RECENTLY`,
          `https://smartplace.naver.com/v1/businesses/${bizId}/reviews?page=1&size=20`,
          `https://smartplace.naver.com/api/v1/businesses/${bizId}/reviews?page=1&size=20`,
        ]) {
          try {
            const r = await fetch(url, { credentials: "include", headers: { Accept: "application/json" } });
            const text = await r.text();
            log.push(`${r.status} ${url.slice(0, 60)} → ${text.slice(0, 80)}`);
            if (r.ok) {
              const data = JSON.parse(text);
              const items = data.items || data.reviews || data.list || data.contents;
              if (items?.length > 0) return { ok: true, items, log };
            }
          } catch (e) {
            log.push(`ERR ${url.slice(0, 60)} → ${e.message}`);
          }
        }
        return { ok: false, log };
      }, businessId);
      result.log?.forEach(l => console.log(`   [API] ${l}`));
      if (result.ok) captured = result.items;
    } catch (e) {
      console.log(`   Admin 페이지 오류: ${e.message}`);
    }
  }

  await page.close();
  if (!captured) return [];

  // 구조 파악용 디버그 (첫 번째 아이템만)
  if (captured.length > 0) {
    console.log(`   [STRUCT] 첫 리뷰 키: ${JSON.stringify(Object.keys(captured[0]))}`);
    console.log(`   [STRUCT] 샘플: ${JSON.stringify(captured[0]).slice(0, 500)}`);
  }

  return captured
    .map((r) => ({
      id:               String(r.id || r.reviewId || r.reviewNo || ""),
      author:           r.author?.displayName || r.writer?.nickname || r.authorName || "익명",
      rating:           r.rating || r.starRating || 5,
      content:          r.content?.text || r.body || (typeof r.content === "string" ? r.content : "") || r.text || "",
      tags:             (Array.isArray(r.keywords) ? r.keywords : Array.isArray(r.tags) ? r.tags : Array.isArray(r.content?.tags) ? r.content.tags : []).map((k) => k.text || k.name || k),
      replied:          !!(r.hasReply || r.reply),
      bookingBusinessId: r.bookingDetail?.businessId || null,
    }))
    .filter((r) => !r.replied && r.id);
}

// ─── Gemini AI 답글 생성 ──────────────────────────────────────────────────────
function buildPrompt(review, greeting) {
  return `당신은 친절하고 활기찬 '${greeting}' 사장님입니다.

[답변 구조]
- 도입: "안녕하세요 ${greeting}입니다 🐮✨" 로 고정 시작
- 본문: 고객 리뷰 내용을 따옴표 없이 문장 속에 자연스럽게 녹여서 언급
  예) "너무 맛있어요"라고 하셨을 때(X) → 너무 맛있다고 말씀해 주셔서(O)
- 가치 강조: "당일 도축된 신선한 최상급 한우", "잡내 없는 고소한 풍미" 문맥에 맞게 포함
- 마무리: 재방문 기대 + 담백한 감사 인사 (💖 😋 ✨ 중 1~2개 활용)

[상황별 대응]
- 맛/품질 언급 → 신선함과 불쇼를 통한 잡내 제거 강조
- 가족/아이 동반 → 부드러운 식감, 아기 의자 완비 강조
- 사이드/주류 언급 → 메인과의 환상적 궁합, 중독성 강조
- 검색/지인추천 → 맛집 타이틀 자부심과 신뢰 보답 강조

[금지사항]
- 리뷰 인용 시 따옴표("") 절대 금지
- 예약 문의, 서비스 약속, 링크 안내 등 홍보 문구 금지
- 별점/평점 언급 금지
- 200~250자 이내

[리뷰 정보]
별점: ${review.rating}점 / 태그: ${review.tags.join(", ") || "없음"}
내용: ${review.content || "(사진/영수증 리뷰)"}

답글만 출력하세요.`;
}

async function generateReply(review, greeting, retryCount = 0) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildPrompt(review, greeting) }] }],
        generationConfig: {
          maxOutputTokens: 1024,
          temperature: 0.7,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    }
  );
  const data = await res.json();

  if (data.error) {
    const msg = data.error.message || "";
    if ((msg.includes("quota") || msg.includes("rate") || res.status === 429) && retryCount < 3) {
      const wait = 20 + retryCount * 15;
      console.log(`   ⏳ API 한도 초과 → ${wait}초 대기 후 재시도 (${retryCount + 1}/3)`);
      await delay(wait * 1000);
      return generateReply(review, greeting, retryCount + 1);
    }
    throw new Error(msg);
  }

  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
}

// ─── 답글 등록 ────────────────────────────────────────────────────────────────
async function postReply(browser, { nidAut, nidSes }, businessId, placeId, reviewId, replyContent) {
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
  );
  await page.setCookie(
    { name: "NID_AUT", value: nidAut, domain: ".naver.com", path: "/" },
    { name: "NID_SES", value: nidSes, domain: ".naver.com", path: "/" }
  );

  await page.goto("https://smartplace.naver.com", { waitUntil: "networkidle2", timeout: 30000 });

  const apiResult = await page.evaluate(async (bizId, placeId, revId, content) => {
    const logs = [];

    // 1. GraphQL mutation 시도
    const gqlMutations = [
      { name: "CreateOwnerReply",   field: "createOwnerReply" },
      { name: "WriteOwnerReply",    field: "writeOwnerReply" },
      { name: "CreateReviewReply",  field: "createReviewReply" },
      { name: "AddOwnerReply",      field: "addOwnerReply" },
    ];
    for (const { name, field } of gqlMutations) {
      try {
        const r = await fetch("https://smartplace.naver.com/graphql", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            operationName: name,
            variables: { reviewId: revId, content, placeId },
            query: `mutation ${name}($reviewId:ID!,$content:String!,$placeId:ID){${field}(reviewId:$reviewId,content:$content,placeId:$placeId){id content __typename}}`,
          }),
        });
        const text = await r.text();
        logs.push(`GQL ${name}: ${r.status} → ${text.slice(0, 80)}`);
        if (r.ok && !text.includes('"errors"')) return { ok: true, method: `gql:${name}`, logs };
      } catch (e) { logs.push(`GQL ${name} ERR: ${e.message}`); }
    }

    // 2. REST 엔드포인트 시도 (placeId 기반)
    for (const url of [
      `https://smartplace.naver.com/businessticket/v1/businesses/${placeId}/reviews/${revId}/reply`,
      `https://smartplace.naver.com/api/v1/businesses/${placeId}/reviews/${revId}/reply`,
      `https://smartplace.naver.com/businessticket/v1/businesses/${bizId}/reviews/${revId}/reply`,
    ]) {
      try {
        const r = await fetch(url, {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        });
        const text = await r.text();
        logs.push(`REST ${url.slice(40, 90)}: ${r.status} → ${text.slice(0, 60)}`);
        if (r.ok) return { ok: true, method: "rest", logs };
      } catch (e) { logs.push(`REST ERR: ${e.message}`); }
    }

    return { ok: false, logs };
  }, businessId, placeId, reviewId, replyContent);

  // 디버그 로그 출력
  apiResult.logs?.forEach(l => console.log(`      [REPLY] ${l}`));

  await page.close();
  return apiResult.ok;
}

// ─── 메인 ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!NID_AUT || !NID_SES || !GEMINI_API_KEY) {
    console.error("❌ 환경변수 누락: NAVER_NID_AUT, NAVER_NID_SES, GEMINI_API_KEY 를 설정하세요.");
    process.exit(1);
  }

  const startTime = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  console.log(`\n🚀 네이버 리뷰 자동 답글 시작 — ${startTime}`);

  const report = { success: 0, fail: 0, skipped: 0, details: [] };
  const browser = await launchBrowser();

  try {
    const session = getSession();

    for (const branch of BRANCHES) {
      console.log(`\n📍 [${branch.name}] 처리 중...`);

      let reviews;
      try {
        reviews = await fetchUnrepliedReviews(browser, session, branch.businessId, branch.placeId);
      } catch (e) {
        console.error(`   리뷰 수집 실패: ${e.message}`);
        report.skipped++;
        continue;
      }

      if (reviews.length === 0) {
        console.log("   미답글 없음 ✨");
        continue;
      }

      console.log(`   미답글 ${reviews.length}개 처리 시작`);

      for (const review of reviews) {
        try {
          const reply = await generateReply(review, branch.greeting);
          if (!reply) throw new Error("답글 생성 실패 (빈 응답)");

          const posted = await postReply(browser, session, branch.businessId, branch.placeId, review.id, reply);
          if (!posted) throw new Error("답글 등록 API 실패");

          console.log(`   ✅ [${review.author}] 완료`);
          report.success++;
          report.details.push({ branch: branch.name, author: review.author, status: "✅" });

          await delay(5000); // 요청 간격
        } catch (e) {
          console.error(`   ❌ [${review.author}] ${e.message}`);
          report.fail++;
          report.details.push({ branch: branch.name, author: review.author, status: "❌", error: e.message });
          await delay(2000);
        }
      }
    }
  } finally {
    await browser.close();
  }

  // ─── 결과 리포트 ───
  console.log("\n════════════ 결과 리포트 ════════════");
  console.log(`✅ 성공: ${report.success}개`);
  console.log(`❌ 실패: ${report.fail}개`);
  if (report.skipped) console.log(`⏭ 수집 실패: ${report.skipped}개 지점`);
  report.details.forEach((d) =>
    console.log(`  ${d.status} [${d.branch}] ${d.author}${d.error ? ` — ${d.error}` : ""}`)
  );
  console.log("═════════════════════════════════════\n");

  if (report.success === 0 && report.fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("💥 Fatal:", e.message);
  process.exit(1);
});
