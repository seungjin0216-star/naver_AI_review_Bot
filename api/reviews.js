export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  // 쿠키에서 네이버 토큰 추출
  const cookieStr = req.headers.cookie || "";
  const cookies = Object.fromEntries(
    cookieStr.split("; ").filter(c => c.includes("=")).map(c => {
      const idx = c.indexOf("=");
      return [c.slice(0, idx), c.slice(idx + 1)];
    })
  );
  const token = cookies["naver_token"];
  if (!token) return res.status(401).json({ error: "로그인이 필요합니다" });

  const businessId = req.query.businessId;
  if (!businessId) return res.status(400).json({ error: "businessId is required" });

  try {
    // 네이버 스마트플레이스 리뷰 API 호출
    const reviewRes = await fetch(
      `https://api.place.naver.com/place/v1/businesses/${businessId}/reviews?page=1&size=20&sort=RECENTLY`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0",
        },
      }
    );

    const rawText = await reviewRes.text();

    // 응답 디버깅용 로그
    console.log("Status:", reviewRes.status);
    console.log("Response:", rawText.slice(0, 500));

    if (!reviewRes.ok) {
      // 토큰으로 직접 안되면 스마트플레이스 웹 API 시도
      const reviewRes2 = await fetch(
        `https://smartplace.naver.com/v1/businesses/${businessId}/reviews?page=1&limit=20`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0",
            Referer: "https://smartplace.naver.com/",
          },
        }
      );

      const rawText2 = await reviewRes2.text();
      console.log("Status2:", reviewRes2.status);
      console.log("Response2:", rawText2.slice(0, 500));

      if (!reviewRes2.ok) {
        return res.status(reviewRes2.status).json({
          error: `리뷰 조회 실패 (${reviewRes2.status}): ${rawText2.slice(0, 200)}`,
          debug: { status1: reviewRes.status, status2: reviewRes2.status }
        });
      }

      const data2 = JSON.parse(rawText2);
      return res.status(200).json({ reviews: normalizeReviews(data2), source: "smartplace" });
    }

    const data = JSON.parse(rawText);
    return res.status(200).json({ reviews: normalizeReviews(data), source: "place-api" });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

function normalizeReviews(data) {
  const items = data.items || data.reviews || data.list || data.contents || [];
  return items.map(r => ({
    id: String(r.id || r.reviewId || r.review_id || Math.random()),
    platform: "naver",
    author: r.writer?.nickname || r.writerInfo?.nickname || r.authorName || r.nickname || "익명",
    date: (r.createdAt || r.createDate || r.visitDate || "").slice(0, 10),
    rating: r.starRating || r.rating || r.visitCount || 5,
    content: r.body || r.content || r.text || r.reviewText || "",
    tags: (r.keywords || r.tags || []).map(k => k.text || k.name || k),
    replied: !!(r.reply || r.ownerReply || r.replyContent),
    existingReply: r.reply?.body || r.ownerReply?.content || r.replyContent || "",
    images: (r.photos?.length || r.imageCount || 0) > 0,
  }));
}
