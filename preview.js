/**
 * 답글 미리보기 (등록하지 않음)
 * 실행: node preview.js [건수]
 *   예) node preview.js 5
 *
 * 미답글 리뷰를 읽어 Gemini 답글을 만들어 화면에만 출력한다.
 * 프롬프트를 다듬을 때 실제 리뷰를 소모하지 않기 위한 도구.
 */
import {
  launchBrowser, openReviewPage, collectPendingCards, generateReply, BRANCHES,
} from "./auto-reply.js";

const COUNT = Number(process.argv[2] || 3);

console.log(`\n🧪 답글 미리보기 — 지점당 ${COUNT}건 (등록하지 않습니다)\n`);

const browser = await launchBrowser(false);

try {
  for (const branch of BRANCHES) {
    console.log(`\n${"═".repeat(60)}`);
    console.log(`📍 ${branch.name}`);
    console.log("═".repeat(60));

    let page = null;
    try {
      page = await openReviewPage(browser, branch.businessId);
      const pending = (await collectPendingCards(page)).slice(0, COUNT);

      if (pending.length === 0) {
        console.log("   미답글 없음");
        continue;
      }

      for (const [i, review] of pending.entries()) {
        console.log(`\n──── ${i + 1}. ${review.author} (${review.rating}점) ────`);
        console.log(`[리뷰] ${review.content || "(사진/영수증만)"}`);
        if (review.tags.length) console.log(`[키워드] ${review.tags.join(", ")}`);

        try {
          const reply = await generateReply(review, branch.greeting);
          console.log(`\n[답글 ${reply?.length ?? 0}자]`);
          console.log(reply);
        } catch (e) {
          console.log(`[답글 생성 실패] ${e.message}`);
        }
      }
    } catch (e) {
      console.log(`   실패: ${e.message}`);
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }
} finally {
  await browser.close();
}

console.log("\n\n✅ 미리보기 종료 — 실제로 등록된 답글은 없습니다.\n");
