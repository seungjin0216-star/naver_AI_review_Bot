/**
 * 네이버 리뷰 자동 답글 스크립트
 * 실행: node auto-reply.js
 *
 * 로그인은 전용 크롬 프로필(chrome-profile 폴더)에 저장된 세션을 그대로 사용한다.
 * 최초 1회 `node login.js` 로 로그인해두면 이후에는 자동으로 유지된다.
 *
 * 필수 환경변수: GEMINI_API_KEY
 * 선택 환경변수: MAX_PER_RUN(기본 5), HEADLESS(기본 false), CHROME_PROFILE
 */
import puppeteer from "puppeteer";
import path from "node:path";
import { fileURLToPath } from "node:url";

// .env 파일이 있으면 읽기 (Node 20.6+ 내장, 별도 패키지 불필요)
// 시스템 환경변수가 이미 있으면 그쪽이 우선이므로, .env 값을 항상 덮어쓴다.
try {
  const before = { ...process.env };
  process.loadEnvFile();
  const fs = await import("node:fs");
  for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i < 1 || line.trim().startsWith("#")) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (before[k] !== undefined && before[k] !== v) {
      console.log(`   ⚠️ 시스템 환경변수 ${k} 를 .env 값으로 덮어씁니다.`);
    }
    process.env[k] = v;
  }
} catch { /* .env 없으면 시스템 환경변수 사용 */ }

const BRANCHES = [
  { name: "백석직영점", businessId: "8250200",  placeId: "1757412660", greeting: "장수한우곱창 백석직영점" },
  { name: "마곡발산점", businessId: "11542564", placeId: "2073101570", greeting: "장수한우곱창 마곡발산점" },
];

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const MAX_PER_RUN  = Number(process.env.MAX_PER_RUN || 5); // 1회 실행당 최대 답글 수
const HEADLESS     = process.env.HEADLESS === "true" ? "new" : false;
export const PROFILE_DIR = process.env.CHROME_PROFILE || path.resolve("chrome-profile");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const randomDelay = (min, max) => delay(Math.floor((min + Math.random() * (max - min)) * 1000));

// ─── 실제 네이버 GraphQL 쿼리 (2026-08 브라우저 캡처 기준) ────────────────────
const CREATE_REPLY_QUERY = `fragment CommonReviewReplyFields on ReviewReply {
  text
  isSuspended
  isQualified
  createdDateTime
  updatedDateTime
  isDeleted
  useReplyCandidate
  replierDisplayName
  suspendPostingReason
  __typename
}

mutation createReply($input: CreateReviewReplyInput!) {
  createReviewReply(input: $input) {
    reply {
      ...CommonReviewReplyFields
      __typename
    }
    __typename
  }
}
`;

const CANDIDATES_QUERY = `query GetReviewReplyCandidates($id: String!) {
  reviewReplyCandidates(id: $id) {
    id
    text
    isOutdated
    status
    type
    lengthPolicy
    personaTypeKey
    personaLengthKey
    __typename
  }
}
`;

// ─── 브라우저 ─────────────────────────────────────────────────────────────────
// 전용 크롬 프로필을 사용한다. 로그인 세션(쿠키 전체)이 이 폴더에 저장돼 있어
// 별도로 쿠키를 주입할 필요가 없다.
export async function launchBrowser(headless = HEADLESS) {
  const options = {
    userDataDir: PROFILE_DIR,
    headless,
    defaultViewport: null,
    args: ["--disable-dev-shm-usage", "--window-size=1280,900", "--no-first-run"],
  };
  // 실제 설치된 크롬을 우선 사용 (봇 탐지에 유리), 없으면 puppeteer 내장 크롬
  try {
    return await puppeteer.launch({ ...options, channel: "chrome" });
  } catch {
    return puppeteer.launch(options);
  }
}

// 로그인이 풀렸는지 확인
function assertLoggedIn(page) {
  const url = page.url();
  if (url.includes("nid.naver.com") || url.includes("nidlogin")) {
    throw new Error("네이버 로그인이 풀렸습니다. 노트북에서 `node login.js` 를 실행해 다시 로그인해주세요.");
  }
}

// ─── 미답글 리뷰 수집 ─────────────────────────────────────────────────────────
// 리뷰 목록을 담은 page를 그대로 반환한다. 이후 답글 등록에 재사용해서
// 같은 페이지 컨텍스트(Referer/Origin)에서 요청이 나가도록 한다.
async function fetchUnrepliedReviews(browser, businessId) {
  const page = await browser.newPage();

  let captured = null;
  page.on("response", async (response) => {
    if (captured) return;
    const url = response.url();
    if (!(url.includes("graphql") && url.includes("getReviews"))) return;
    try {
      const data = JSON.parse(await response.text());
      const gql = data?.data?.reviews || data?.data?.getReviews;
      const items = gql?.items || gql?.reviews || gql?.list;
      if (Array.isArray(items) && items.length > 0) {
        captured = items;
        console.log(`   ✅ 리뷰 캡처: ${items.length}개 (전체 ${gql.totalCount ?? "?"}건)`);
      }
    } catch { /* 파싱 실패한 응답은 무시 */ }
  });

  const url = `https://smartplace.naver.com/bizes/place/${businessId}/reviews`;
  console.log(`   이동 중: ${url}`);
  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
  await delay(4000);
  assertLoggedIn(page);

  if (!captured) {
    console.log(`   ⚠️ 리뷰를 가져오지 못했습니다. (현재 URL: ${page.url()})`);
    return { page, reviews: [] };
  }

  const reviews = captured
    .map((r) => ({
      id:      String(r.id || ""),
      author:  r.author?.displayName || "익명",
      rating:  r.rating || 5,
      content: r.content?.text || "",
      tags: (Array.isArray(r.keywords) ? r.keywords
           : Array.isArray(r.tags)     ? r.tags
           : Array.isArray(r.content?.tags) ? r.content.tags
           : []).map((k) => k.text || k.name || k),
      replied: !!(r.hasReply || r.reply),
    }))
    .filter((r) => !r.replied && r.id);

  return { page, reviews };
}

// ─── Gemini 답글 생성 ─────────────────────────────────────────────────────────
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
// 실제 브라우저가 보내는 요청을 그대로 재현한다.
//   POST https://smartplace.naver.com/graphql?opName=createReply
//   { operationName, variables: { input: { text, reviewId, placeId, replyCandidateId? } }, query }
// replyCandidateId 는 네이버 AI 초안을 쓸 때만 붙는 값으로 보이므로
// 1차로 생략하고 시도, 거부되면 후보 ID를 조회해 재시도한다.
async function postReply(page, placeId, reviewId, replyContent) {
  const result = await page.evaluate(
    async (createQuery, candidatesQuery, revId, plcId, text) => {
      const logs = [];

      async function gql(opName, body) {
        const r = await fetch(`https://smartplace.naver.com/graphql?opName=${opName}`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(body),
        });
        return { status: r.status, text: await r.text() };
      }
      const succeeded = (r) => r.status === 200 && !r.text.includes('"errors"');

      // 1차 — replyCandidateId 없이
      let res = await gql("createReply", {
        operationName: "createReply",
        variables: { input: { text, reviewId: revId, placeId: plcId } },
        query: createQuery,
      });
      logs.push(`1차(후보ID 없음): ${res.status} → ${res.text.slice(0, 160)}`);
      if (succeeded(res)) return { ok: true, method: "no-candidate", logs };

      // 2차 — 네이버 AI 초안 후보 ID를 받아서 재시도
      const cand = await gql("GetReviewReplyCandidates", {
        operationName: "GetReviewReplyCandidates",
        variables: { id: revId },
        query: candidatesQuery,
      });
      logs.push(`후보 조회: ${cand.status} → ${cand.text.slice(0, 160)}`);

      let candidateId = null;
      try {
        const list = JSON.parse(cand.text)?.data?.reviewReplyCandidates || [];
        candidateId = (list.find((c) => !c.isOutdated) || list[0])?.id || null;
      } catch { /* 파싱 실패 시 후보 없음으로 처리 */ }

      if (!candidateId) {
        logs.push("후보 ID를 찾지 못했습니다.");
        return { ok: false, logs };
      }

      res = await gql("createReply", {
        operationName: "createReply",
        variables: { input: { text, reviewId: revId, placeId: plcId, replyCandidateId: candidateId } },
        query: createQuery,
      });
      logs.push(`2차(후보ID ${candidateId}): ${res.status} → ${res.text.slice(0, 160)}`);
      if (succeeded(res)) return { ok: true, method: "with-candidate", logs };

      return { ok: false, logs };
    },
    CREATE_REPLY_QUERY, CANDIDATES_QUERY, reviewId, placeId, replyContent
  );

  result.logs?.forEach((l) => console.log(`      [REPLY] ${l}`));
  return result.ok;
}

// ─── 메인 ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!GEMINI_API_KEY) {
    console.error("❌ 환경변수 누락: GEMINI_API_KEY 를 .env 에 설정하세요.");
    process.exit(1);
  }

  const startTime = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  console.log(`\n🚀 네이버 리뷰 자동 답글 시작 — ${startTime}`);
  console.log(`   프로필: ${PROFILE_DIR}`);
  console.log(`   1회 최대 처리: ${MAX_PER_RUN}건 / 지점당`);

  const report = { success: 0, fail: 0, skipped: 0, details: [] };
  const browser = await launchBrowser();

  try {
    for (const branch of BRANCHES) {
      console.log(`\n📍 [${branch.name}] 처리 중...`);

      let page = null;
      try {
        const result = await fetchUnrepliedReviews(browser, branch.businessId);
        page = result.page;
        const reviews = result.reviews.slice(0, MAX_PER_RUN);

        if (reviews.length === 0) {
          console.log("   미답글 없음 ✨");
          continue;
        }
        console.log(`   미답글 ${result.reviews.length}건 중 ${reviews.length}건 처리`);

        for (const review of reviews) {
          try {
            const reply = await generateReply(review, branch.greeting);
            if (!reply) throw new Error("답글 생성 실패 (빈 응답)");

            const posted = await postReply(page, branch.placeId, review.id, reply);
            if (!posted) throw new Error("답글 등록 실패");

            console.log(`   ✅ [${review.author}] 완료`);
            report.success++;
            report.details.push({ branch: branch.name, author: review.author, status: "✅" });
          } catch (e) {
            console.error(`   ❌ [${review.author}] ${e.message}`);
            report.fail++;
            report.details.push({ branch: branch.name, author: review.author, status: "❌", error: e.message });
          }
          // 사람처럼 보이도록 20~60초 랜덤 간격
          await randomDelay(20, 60);
        }
      } catch (e) {
        console.error(`   리뷰 수집 실패: ${e.message}`);
        report.skipped++;
      } finally {
        if (page) await page.close().catch(() => {});
      }
    }
  } finally {
    await browser.close();
  }

  console.log("\n════════════ 결과 리포트 ════════════");
  console.log(`✅ 성공: ${report.success}건`);
  console.log(`❌ 실패: ${report.fail}건`);
  if (report.skipped) console.log(`⏭ 수집 실패: ${report.skipped}개 지점`);
  report.details.forEach((d) =>
    console.log(`  ${d.status} [${d.branch}] ${d.author}${d.error ? ` — ${d.error}` : ""}`)
  );
  console.log("═════════════════════════════════════\n");

  if (report.success === 0 && report.fail > 0) process.exit(1);
}

// login.js 가 이 파일을 import 할 때는 실행하지 않는다.
const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((e) => {
    console.error("💥 Fatal:", e.message);
    process.exit(1);
  });
}
