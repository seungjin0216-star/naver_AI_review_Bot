/**
 * 리뷰 페이지 DOM 정찰용 스크립트 (실제 동작 없음, 조사만 함)
 * 실행: node inspect.js
 *
 * 답글 등록 UI 자동화를 위해 실제 화면 구조를 확인한다.
 */
import path from "node:path";
import { launchBrowser, hideAutomation, BRANCHES, reviewUrl } from "./auto-reply.js";

const BUSINESS_ID = process.argv[2] || "8250200";
const branch = BRANCHES.find((b) => b.businessId === BUSINESS_ID) || BRANCHES[0];
const URL = reviewUrl(branch);

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await launchBrowser(false);
const page = await browser.newPage();
await hideAutomation(page);

console.log(`\n🔍 정찰 시작: ${URL}\n`);
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
await delay(8000); // SPA 렌더링 대기

const info = await page.evaluate(() => {
  const out = {};

  // 1) 화면의 모든 버튼 텍스트
  const btns = Array.from(document.querySelectorAll("button, [role='button'], a[class*='btn']"));
  out.buttons = [...new Set(
    btns.map((b) => (b.innerText || b.textContent || "").trim().replace(/\s+/g, " "))
        .filter((t) => t && t.length < 30)
  )];

  // 2) 리뷰 카드 후보 찾기 — 리뷰 텍스트를 담고 있는 li/div 중 가장 바깥
  const findCard = () => {
    const all = Array.from(document.querySelectorAll("li, article, div"));
    // 자식 중에 '답글' 관련 버튼을 가진 가장 작은 컨테이너
    const cands = all.filter((el) => {
      const t = el.innerText || "";
      return t.includes("답글") && t.length > 30 && t.length < 3000;
    });
    return cands.sort((a, b) => (a.innerText || "").length - (b.innerText || "").length)[0] || null;
  };

  const card = findCard();
  if (card) {
    out.cardTag = card.tagName;
    out.cardClass = (card.className || "").toString().slice(0, 200);
    out.cardDataAttrs = Object.entries(card.dataset || {}).slice(0, 10);
    out.cardText = (card.innerText || "").slice(0, 300).replace(/\n+/g, " | ");

    // 카드 내부 버튼들
    out.cardButtons = Array.from(card.querySelectorAll("button, [role='button']")).map((b) => ({
      text: (b.innerText || "").trim().replace(/\s+/g, " ").slice(0, 30),
      cls: (b.className || "").toString().slice(0, 80),
      data: Object.entries(b.dataset || {}).slice(0, 5),
    }));

    // 카드 조상 중 data-* 속성(리뷰 ID일 가능성)
    out.ancestors = [];
    let p = card;
    for (let i = 0; i < 4 && p; i++) {
      out.ancestors.push({
        tag: p.tagName,
        cls: (p.className || "").toString().slice(0, 100),
        data: Object.entries(p.dataset || {}).slice(0, 5),
      });
      p = p.parentElement;
    }
  } else {
    out.cardTag = "찾지 못함";
  }

  // 3) 페이지 전체에서 data-* 속성에 review 가 들어간 요소
  out.reviewDataEls = Array.from(document.querySelectorAll("*"))
    .filter((el) => Object.keys(el.dataset || {}).some((k) => /review|reply/i.test(k)))
    .slice(0, 5)
    .map((el) => ({ tag: el.tagName, data: Object.entries(el.dataset) }));

  // 4) textarea 존재 여부
  out.textareaCount = document.querySelectorAll("textarea").length;

  return out;
});

console.log("═══════ 화면의 모든 버튼 ═══════");
console.log(info.buttons.join("  |  "));

console.log("\n═══════ 리뷰 카드 ═══════");
console.log("태그:", info.cardTag);
console.log("클래스:", info.cardClass);
console.log("data 속성:", JSON.stringify(info.cardDataAttrs));
console.log("내용:", info.cardText);

console.log("\n═══════ 카드 안 버튼 ═══════");
console.log(JSON.stringify(info.cardButtons, null, 1));

console.log("\n═══════ 상위 요소 (리뷰 ID 탐색) ═══════");
console.log(JSON.stringify(info.ancestors, null, 1));

console.log("\n═══════ review/reply data 속성 요소 ═══════");
console.log(JSON.stringify(info.reviewDataEls, null, 1));

console.log("\ntextarea 개수:", info.textareaCount);

const shot = path.resolve("inspect-1.png");
await page.screenshot({ path: shot, fullPage: false });
console.log(`\n📸 화면 저장: ${shot}`);

// ── 2단계: 'AI가 답글 초안을 작성했어요' 클릭 후 나타나는 UI 조사 ──
// (등록 버튼은 절대 누르지 않는다)
console.log("\n═══════ AI 초안 패널 열기 ═══════");

const opened = await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll("button, [role='button'], a"));
  const t = btns.find((b) => /답글\s*초안|초안을\s*작성/.test(b.innerText || ""));
  if (!t) return false;
  t.scrollIntoView({ block: "center" });
  t.click();
  return (t.innerText || "").trim().replace(/\s+/g, " ");
});
console.log("클릭한 버튼:", opened || "❌ 찾지 못함");

await delay(6000);

const panel = await page.evaluate(() => {
  const out = {};
  out.buttons = [...new Set(
    Array.from(document.querySelectorAll("button, [role='button']"))
      .map((b) => (b.innerText || "").trim().replace(/\s+/g, " "))
      .filter((t) => t && t.length < 30)
  )];
  const tas = Array.from(document.querySelectorAll("textarea"));
  out.textareas = tas.map((ta) => ({
    cls: (ta.className || "").toString().slice(0, 80),
    placeholder: ta.placeholder || "",
    valueLen: (ta.value || "").length,
    valueHead: (ta.value || "").slice(0, 60),
    readOnly: ta.readOnly,
  }));
  out.editableDivs = Array.from(document.querySelectorAll("[contenteditable='true']")).length;
  return out;
});

console.log("\n── 패널 열린 뒤 버튼 목록 ──");
console.log(panel.buttons.join("  |  "));
console.log("\n── textarea 상태 ──");
console.log(JSON.stringify(panel.textareas, null, 1));
console.log("contenteditable 요소 수:", panel.editableDivs);

const shot2 = path.resolve("inspect-2.png");
await page.screenshot({ path: shot2, fullPage: false });
console.log(`\n📸 화면 저장: ${shot2}`);

// ── 3단계: '이 답글 수정' 클릭 후 입력창 조사 ──
console.log("\n═══════ '이 답글 수정' 클릭 ═══════");
const edited = await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll("button, [role='button'], a"));
  const t = btns.find((b) => /답글\s*수정/.test(b.innerText || ""));
  if (!t) return false;
  t.click();
  return (t.innerText || "").trim().replace(/\s+/g, " ");
});
console.log("클릭한 버튼:", edited || "❌ 찾지 못함");

await delay(3000);

const editor = await page.evaluate(() => ({
  buttons: [...new Set(
    Array.from(document.querySelectorAll("button, [role='button']"))
      .map((b) => (b.innerText || "").trim().replace(/\s+/g, " "))
      .filter((t) => t && t.length < 30)
  )],
  textareas: Array.from(document.querySelectorAll("textarea")).map((ta) => ({
    cls: (ta.className || "").toString().slice(0, 80),
    placeholder: ta.placeholder || "",
    valueLen: (ta.value || "").length,
    readOnly: ta.readOnly,
    disabled: ta.disabled,
  })),
  editableDivs: Array.from(document.querySelectorAll("[contenteditable='true']")).map((d) => ({
    cls: (d.className || "").toString().slice(0, 80),
    textLen: (d.innerText || "").length,
  })),
}));

console.log("\n── 편집 모드 버튼 목록 ──");
console.log(editor.buttons.join("  |  "));
console.log("\n── 입력창 ──");
console.log("textarea:", JSON.stringify(editor.textareas, null, 1));
console.log("contenteditable:", JSON.stringify(editor.editableDivs, null, 1));

const shot3 = path.resolve("inspect-3.png");
await page.screenshot({ path: shot3, fullPage: false });
console.log(`📸 화면 저장: ${shot3}`);
console.log("\n⚠️ 등록 버튼은 누르지 않았습니다. 실제 답글은 올라가지 않았습니다.");

console.log("\n⏸  브라우저를 20초 더 열어둡니다. 화면을 직접 확인해보세요.");
await delay(20000);
await browser.close();
console.log("완료.\n");
