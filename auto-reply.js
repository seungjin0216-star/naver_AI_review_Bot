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
import { sendNotify } from "./notify.js";

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

export const BRANCHES = [
  { name: "백석직영점", businessId: "8250200",  placeId: "1757412660", bookingBusinessId: "898097",  greeting: "장수한우곱창 백석직영점" },
  { name: "마곡발산점", businessId: "11542564", placeId: "2073101570", bookingBusinessId: "1482386", greeting: "장수한우곱창 마곡발산점" },
];

// 답글 미등록 리뷰만 보이는 주소 (hasReply=false)
export function reviewUrl(branch) {
  return `https://new.smartplace.naver.com/bizes/place/${branch.businessId}/reviews`
       + `?bookingBusinessId=${branch.bookingBusinessId}&hasReply=false&menu=visitor`;
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const MAX_PER_RUN  = Number(process.env.MAX_PER_RUN || 5); // 1회 실행당 최대 답글 수
const HEADLESS     = process.env.HEADLESS === "true" ? "new" : false;
export const PROFILE_DIR = process.env.CHROME_PROFILE || path.resolve("chrome-profile");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const randomDelay = (min, max) => delay(Math.floor((min + Math.random() * (max - min)) * 1000));

// ─── 화면 선택자 (2026-08 스마트플레이스 기준) ────────────────────────────────
const CARD_SEL   = "li[class*='Review_pui_review']";
const AI_BTN_SEL = "button[class*='ai_review_show_btn']";

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
    args: [
      "--disable-dev-shm-usage",
      "--window-size=1280,900",
      "--no-first-run",
      // 자동화 탐지 회피: 네이버가 navigator.webdriver 를 보고 앱 초기화를 막는다
      "--disable-blink-features=AutomationControlled",
      "--exclude-switches=enable-automation",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  };
  // 실제 설치된 크롬을 우선 사용 (봇 탐지에 유리), 없으면 puppeteer 내장 크롬
  try {
    return await puppeteer.launch({ ...options, channel: "chrome" });
  } catch {
    return puppeteer.launch(options);
  }
}

// 페이지가 열리기 전에 자동화 흔적을 지운다
export async function hideAutomation(page) {
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "languages", { get: () => ["ko-KR", "ko"] });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    window.chrome = window.chrome || { runtime: {} };
  });
}

// 로그인이 풀렸는지 확인
function assertLoggedIn(page) {
  const url = page.url();
  if (url.includes("nid.naver.com") || url.includes("nidlogin")) {
    throw new Error("네이버 로그인이 풀렸습니다. 노트북에서 `node login.js` 를 실행해 다시 로그인해주세요.");
  }
}

// ─── 리뷰 페이지 열기 ─────────────────────────────────────────────────────────
export async function openReviewPage(browser, branch) {
  const page = await browser.newPage();
  await hideAutomation(page);

  const url = reviewUrl(branch);
  console.log(`   이동 중: ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

  // 리뷰 카드가 그려질 때까지 대기 (최대 40초)
  try {
    await page.waitForSelector(CARD_SEL, { timeout: 40000 });
  } catch {
    await assertLoggedInDeep(page, branch.businessId);
    console.log("   미답글이 한 건도 없습니다 ✨");
    return page; // 카드가 0건일 수도 있으므로 오류로 처리하지 않는다
  }
  await delay(2000);
  await assertLoggedInDeep(page, branch.businessId);
  return page;
}

async function dumpScreen(page, tag) {
  const shot = path.resolve(`debug-${tag}.png`);
  try {
    await page.screenshot({ path: shot });
    console.log(`   📸 화면 저장: ${shot}`);
  } catch { /* 스크린샷 실패는 무시 */ }
  const body = await page.evaluate(() => document.body?.innerText?.slice(0, 200) || "");
  console.log(`   화면 내용: ${body.replace(/\n+/g, " / ")}`);
}

// URL은 그대로 두고 모달만 띄우는 경우가 있어 화면 문구까지 확인한다
async function assertLoggedInDeep(page, tag) {
  assertLoggedIn(page);
  const needLogin = await page.evaluate(() =>
    (document.body?.innerText || "").includes("네이버 로그인이 필요한")
  );
  if (needLogin) {
    await dumpScreen(page, tag);
    throw new Error("네이버 로그인이 풀렸습니다. 노트북에서 `node login.js` 를 실행해 다시 로그인해주세요.");
  }
}

// ─── 미답글 카드 수집 (AI 초안 버튼이 있는 카드 = 아직 답글 없음) ─────────────
export async function collectPendingCards(page) {
  return page.evaluate((cardSel, aiBtnSel) => {
    const allCards = Array.from(document.querySelectorAll(cardSel));
    const cards = allCards
      .map((card, index) => {
        if (!card.querySelector(aiBtnSel)) return null;

        // 본문이 접혀 있으면 펼치기
        const more = Array.from(card.querySelectorAll("button, a"))
          .find((b) => (b.innerText || "").trim() === "더보기");
        if (more) more.click();

        const raw = card.innerText || "";
        const textEl = card.querySelector("[data-pui-click-code='text']");
        // 프로필 요소가 2개(이미지·이름)라서 텍스트가 있는 쪽을 고른다
        const profEl = Array.from(card.querySelectorAll("[data-pui-click-code='profile']"))
          .find((el) => (el.innerText || "").trim().length > 0);
        const ratingMatch = raw.match(/별점\s*([\d.]+)/);

        // 키워드 칩 ("음식이 맛있어요+3 개의 리뷰가..." 형태에서 앞부분만)
        const chipEl = card.querySelector("[data-pui-click-code='rv.keywordmore']");
        const chips = chipEl ? (chipEl.previousElementSibling?.innerText || "") : "";

        const author  = ((profEl?.innerText || "").split("리뷰")[0] || "").trim() || "익명";
        const content = (textEl?.innerText || "").trim();

        // 카드를 다시 찾기 위한 열쇠.
        // 2단 컬럼 레이아웃이라 카드 순서(index)가 수시로 바뀌므로 내용으로 식별한다.
        const squashed = content.replace(/\s+/g, "");
        const key = squashed.length >= 8 ? squashed.slice(0, 25) : `작성자:${author}`;

        return { index, key, author, content, rating: ratingMatch ? Number(ratingMatch[1]) : 5,
                 tags: chips.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 5) };
      })
      .filter(Boolean);
    return { total: allCards.length, cards };
  }, CARD_SEL, AI_BTN_SEL);
}

// ─── Gemini 답글 생성 ─────────────────────────────────────────────────────────
function buildPrompt(review, greeting) {
  return `당신은 친절하고 활기찬 '${greeting}' 사장님입니다. 손님 리뷰에 답글을 답니다.

[가장 중요한 원칙 — 리뷰를 되풀이하지 말 것]
손님이 쓴 내용을 하나하나 다시 읊는 답글은 성의 없어 보입니다.
- 리뷰에서 **가장 인상적인 포인트 딱 1~2가지만** 골라 언급하세요. 나머지는 과감히 버립니다.
- 손님이 쓴 표현을 그대로 옮기지 말고, **사장님의 말로 바꿔서** 짧게 받아주세요.
- 손님이 언급한 메뉴·상황을 순서대로 나열하는 것은 금지입니다.

나쁜 예) 곱창도 맛있고 대창도 좋고 볶음밥까지 완벽했다고 해주시고 직원분들도 친절했다고 하시니…
좋은 예) 마무리 볶음밥까지 남김없이 즐겨주셨다니 그것만으로 배부릅니다.

[구성]
1. 도입: "안녕하세요 ${greeting}입니다 🐮✨" 로 고정 시작
2. 본문: 위 원칙대로 핵심 1~2가지에만 반응 (2~3문장)
3. 가치: 문맥에 맞을 때만 자연스럽게 한 번 — 당일 도축한 신선한 한우, 불쇼로 잡내를 잡은 고소한 풍미
4. 마무리: 재방문 기대 + 담백한 감사 (1문장)

[상황별 힌트] — 해당될 때만 사용
- 맛/품질 → 신선함, 잡내 없는 풍미
- 가족/아이 → 부드러운 식감, 아기 의자 완비
- 사이드/주류 → 메인과의 궁합
- 검색/지인추천 → 믿고 찾아주신 데 대한 보답

[금지]
- 따옴표("")로 리뷰 인용 금지
- 예약 문의, 서비스 약속, 링크 등 홍보 문구 금지
- 별점·평점 언급 금지
- 이모지는 전체에서 2~3개까지 (💖 😋 ✨ 🐮 중)
- 180~230자

[리뷰]
별점 ${review.rating}점 / 키워드: ${review.tags.join(", ") || "없음"}
${review.content || "(사진/영수증만 있는 리뷰)"}

답글 본문만 출력하세요.`;
}

export async function generateReply(review, greeting, retryCount = 0) {
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

// ─── 답글 등록 (UI 자동화) ────────────────────────────────────────────────────
// 사람이 하는 순서 그대로 진행한다.
//   AI가 답글 초안을 작성했어요! → 이 답글 수정 → 텍스트 교체 → 이대로 등록
// 요청 헤더는 네이버 앱이 알아서 만들어주므로 API를 직접 흉내 낼 필요가 없다.

// 브라우저 안에서 실행될 카드 탐색 함수 (문자열로 주입)
// 2단 컬럼 레이아웃이라 카드 순서가 수시로 바뀌므로 매번 내용으로 다시 찾는다.
const LOCATE_FN = `
function __locate(cardSel, key) {
  const cards = Array.from(document.querySelectorAll(cardSel));
  if (key.startsWith("작성자:")) {
    const name = key.slice(4);
    return cards.find((c) => {
      const p = Array.from(c.querySelectorAll("[data-pui-click-code='profile']"))
        .find((e) => (e.innerText || "").trim());
      return ((p?.innerText || "").split("리뷰")[0] || "").trim() === name;
    }) || null;
  }
  return cards.find((c) => {
    const t = c.querySelector("[data-pui-click-code='text']");
    return t && (t.innerText || "").replace(/\\s+/g, "").includes(key);
  }) || null;
}`;

// 카드 안에서 특정 텍스트를 가진 버튼 클릭
async function clickInCard(page, key, pattern) {
  return page.evaluate(new Function("cardSel", "key", "src", `
    ${LOCATE_FN}
    const card = __locate(cardSel, key);
    if (!card) return "카드없음";
    const re = new RegExp(src);
    const btn = Array.from(card.querySelectorAll("button, [role='button'], a"))
      .find((b) => re.test((b.innerText || "").replace(/\\s+/g, " ")));
    if (!btn) return "버튼없음";
    btn.scrollIntoView({ block: "center" });
    btn.click();
    return "ok";
  `), CARD_SEL, key, pattern.source);
}

// 카드 안에 특정 텍스트의 버튼이 나타날 때까지 대기
async function waitButtonInCard(page, key, pattern, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await page.evaluate(new Function("cardSel", "key", "src", `
      ${LOCATE_FN}
      const card = __locate(cardSel, key);
      if (!card) return false;
      const re = new RegExp(src);
      return Array.from(card.querySelectorAll("button, [role='button'], a"))
        .some((b) => re.test((b.innerText || "").replace(/\\s+/g, " ")));
    `), CARD_SEL, key, pattern.source);
    if (found) return true;
    await delay(500);
  }
  return false;
}

// 편집 중인 textarea 를 찾는 단일 로직 (대기·입력이 같은 규칙을 쓴다)
//  1순위: 우리 카드 안
//  2순위: 페이지에 textarea 가 딱 하나뿐이면 그것 (편집 모드는 한 번에 하나만 열린다)
const FIND_TA_FN = `
function __findTextarea(cardSel, key) {
  const card = __locate(cardSel, key);
  if (!card) return null;
  const inCard = card.querySelector("textarea");
  if (inCard) return inCard;
  const all = Array.from(document.querySelectorAll("textarea"))
    .filter((t) => !t.disabled && !t.readOnly);
  if (all.length === 1) return all[0];
  // 여러 개면 우리 카드에 가장 가까운 것을 고른다
  return all.find((t) => t.closest(cardSel) === card) || null;
}`;

async function fillTextarea(page, key, text) {
  return page.evaluate(new Function("cardSel", "key", "text", `
    ${LOCATE_FN}
    ${FIND_TA_FN}
    if (!__locate(cardSel, key)) return "카드없음";
    const ta = __findTextarea(cardSel, key);
    if (!ta) return "입력창없음";

    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    ta.scrollIntoView({ block: "center" });
    ta.focus();
    setter.call(ta, "");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    setter.call(ta, text);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.dispatchEvent(new Event("change", { bubbles: true }));
    return ta.value === text ? "ok" : "반영안됨";
  `), CARD_SEL, key, text);
}

// textarea 가 나타날 때까지 대기 — 편집 모드 진입의 진짜 신호
async function waitTextarea(page, key, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await page.evaluate(new Function("cardSel", "key", `
      ${LOCATE_FN}
      ${FIND_TA_FN}
      return !!__findTextarea(cardSel, key);
    `), CARD_SEL, key);
    if (ok) return true;
    await delay(500);
  }
  return false;
}

// 실패 원인 파악용 — 화면에 무엇이 있는지 기록
async function describeState(page, key) {
  return page.evaluate(new Function("cardSel", "key", `
    ${LOCATE_FN}
    const card = __locate(cardSel, key);
    const all = Array.from(document.querySelectorAll("textarea"));
    return {
      카드있음: !!card,
      전체textarea: all.length,
      카드내textarea: card ? card.querySelectorAll("textarea").length : 0,
      카드내버튼: card ? Array.from(card.querySelectorAll("button, [role='button']"))
        .map((b) => (b.innerText || "").trim().replace(/\\s+/g, " "))
        .filter((t) => t && t.length < 20) : [],
    };
  `), CARD_SEL, key);
}

async function postReplyViaUI(page, key, replyContent) {
  // 패널이 열렸다가 도로 닫히는 경우가 있어, 매 시도마다 처음(AI 초안 클릭)부터 다시 한다.
  let inEdit = false;

  for (let attempt = 1; attempt <= 3 && !inEdit; attempt++) {
    // 1) 패널이 닫혀 있으면 AI 초안 버튼부터 클릭
    const panelOpen = await waitButtonInCard(page, key, /이\s*답글\s*수정|수정\s*취소/, 500);
    if (!panelOpen) {
      const opened = await clickInCard(page, key, /답글\s*초안|초안을\s*작성/);
      if (opened !== "ok" && attempt === 3)
        throw new Error(`AI 초안 버튼 클릭 실패 (${opened})`);

      if (!(await waitButtonInCard(page, key, /이\s*답글\s*수정|수정\s*취소/, 30000))) {
        console.log(`      ↻ AI 초안이 열리지 않음 — 재시도 (${attempt}/3)`);
        await delay(3000);
        continue;
      }
      await delay(1200); // 패널 렌더링 안정화
    }

    // 2) 편집 모드 진입 (이미 편집 중이면 다시 누르지 않는다)
    if (!(await waitButtonInCard(page, key, /수정\s*취소/, 500))) {
      const clicked = await clickInCard(page, key, /이\s*답글\s*수정/);
      if (clicked !== "ok") {
        console.log(`      ↻ 수정 버튼 클릭 결과: ${clicked} — 재시도 (${attempt}/3)`);
        await delay(2500);
        continue;
      }
    }

    inEdit = await waitTextarea(page, key, 12000);
    if (!inEdit) {
      console.log(`      ↻ 입력창이 뜨지 않음 — 재시도 (${attempt}/3)`);
      await delay(2500);
    }
  }

  if (!inEdit) {
    const state = await describeState(page, key);
    throw new Error(`편집 모드 전환 실패 — ${JSON.stringify(state)}`);
  }

  await delay(600);

  // 3) 텍스트 교체
  const filled = await fillTextarea(page, key, replyContent);
  if (filled !== "ok") {
    const state = await describeState(page, key);
    throw new Error(`답글 입력 실패 (${filled}) — ${JSON.stringify(state)}`);
  }
  await delay(1000);

  // 4) 등록 — 실제 서버 응답으로 성공 여부를 판정한다
  const responsePromise = page
    .waitForResponse((r) => r.url().includes("opName=createReply"), { timeout: 25000 })
    .catch(() => null);

  const submitted = await clickInCard(page, key, /이대로\s*등록/);
  if (submitted !== "ok") throw new Error(`등록 버튼 클릭 실패 (${submitted})`);

  const res = await responsePromise;
  if (!res) throw new Error("등록 요청이 전송되지 않았습니다.");

  const body = await res.text().catch(() => "");
  if (res.status() !== 200 || body.includes('"errors"')) {
    throw new Error(`등록 거부됨 (${res.status()}) ${body.slice(0, 120)}`);
  }
  return true;
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
        page = await openReviewPage(browser, branch);
        const failedKeys = new Set(); // 이번 실행에서 실패한 리뷰는 건너뛴다

        for (let n = 0; n < MAX_PER_RUN; n++) {
          // 등록할 때마다 화면이 다시 그려지므로 매번 새로 수집한다
          const { total, cards } = await collectPendingCards(page);
          const pending = cards.filter((r) => !failedKeys.has(r.key));

          if (pending.length === 0) {
            if (n === 0 && total === 0) console.log("   미답글 없음 ✨");
            else if (n === 0) console.log(`   미답글 ${total}건이 있으나 AI 초안을 쓸 수 있는 리뷰가 없습니다.`);
            else if (failedKeys.size) console.log(`   처리 가능한 미답글 없음 (건너뛴 ${failedKeys.size}건 제외)`);
            else console.log("   남은 미답글 없음 ✨");
            break;
          }
          if (n === 0) console.log(`   미답글 ${total}건 (AI 초안 가능 ${cards.length}건) — 최대 ${MAX_PER_RUN}건 처리`);

          const review = pending[0];
          console.log(`   [${n + 1}/${MAX_PER_RUN}] ${review.author} (${review.rating}점) — ${review.content.slice(0, 30)}...`);

          try {
            const reply = await generateReply(review, branch.greeting);
            if (!reply) throw new Error("답글 생성 실패 (빈 응답)");

            await postReplyViaUI(page, review.key, reply);

            console.log(`   ✅ [${review.author}] 등록 완료`);
            report.success++;
            report.details.push({ branch: branch.name, author: review.author, status: "✅" });
          } catch (e) {
            console.error(`   ❌ [${review.author}] ${e.message} → 건너뜁니다`);
            failedKeys.add(review.key); // 같은 리뷰를 붙잡고 반복하지 않는다
            await dumpScreen(page, `${branch.businessId}-${n}`);
            report.fail++;
            report.details.push({ branch: branch.name, author: review.author, status: "❌", error: e.message });
          }

          // 사람처럼 보이도록 20~60초 랜덤 간격 후 새로고침
          await randomDelay(20, 60);
          await page.reload({ waitUntil: "domcontentloaded" });
          await page.waitForSelector(CARD_SEL, { timeout: 40000 }).catch(() => {});
          await delay(2000);
        }
      } catch (e) {
        console.error(`   지점 처리 실패: ${e.message}`);
        if (e.message.includes("로그인")) report.needLogin = true;
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

  await sendReport(report, startTime);

  if (report.success === 0 && report.fail > 0) process.exit(1);
}

// ─── 카톡 리포트 ──────────────────────────────────────────────────────────────
async function sendReport(report, startTime, fatal = null) {
  const byBranch = {};
  for (const d of report.details) {
    byBranch[d.branch] ??= { ok: 0, ng: 0 };
    d.status === "✅" ? byBranch[d.branch].ok++ : byBranch[d.branch].ng++;
  }

  let msg;
  if (fatal) {
    msg = `🚨 리뷰봇 오류\n${startTime}\n\n${fatal}\n\n노트북에서 확인이 필요합니다.`;
  } else if (report.needLogin) {
    msg = `🔐 네이버 로그인 필요\n${startTime}\n\n노트북에서 아래를 실행해주세요.\ncd C:\\ai-staff\\naver_AI_review_Bot\nnode login.js`;
  } else if (report.success === 0 && report.fail === 0) {
    msg = `🐮 리뷰봇 실행 완료\n${startTime}\n\n새로 답글 달 리뷰가 없습니다 ✨`;
  } else {
    const lines = Object.entries(byBranch)
      .map(([b, v]) => `· ${b}  성공 ${v.ok}건${v.ng ? ` / 실패 ${v.ng}건` : ""}`);
    msg = `🐮 리뷰봇 실행 완료\n${startTime}\n\n${lines.join("\n")}\n\n합계 ✅ ${report.success}건`
        + (report.fail ? ` / ❌ ${report.fail}건` : "");
    if (report.fail) {
      const reasons = [...new Set(report.details.filter((d) => d.error).map((d) => d.error.split(" —")[0]))];
      msg += `\n\n실패 사유\n${reasons.slice(0, 3).map((r) => `· ${r}`).join("\n")}`;
    }
  }
  await sendNotify(msg);
}

// login.js 가 이 파일을 import 할 때는 실행하지 않는다.
const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch(async (e) => {
    console.error("💥 Fatal:", e.message);
    const now = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
    await sendReport({ success: 0, fail: 0, skipped: 0, details: [] }, now, e.message).catch(() => {});
    process.exit(1);
  });
}
