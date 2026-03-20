export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  // 쿠키에서 네이버 토큰 추출
  const cookies = Object.fromEntries(
    (req.headers.cookie || "").split("; ").map(c => c.split("="))
  );
  const token = cookies["naver_token"];
  if (!token) return res.status(401).json({ error: "로그인이 필요합니다" });

  const businessId = req.query.businessId;
  if (!businessId) return res.status(400).json({ error: "businessId is required" });

  try {
    // 스마트플레이스 리뷰 목록 조회
    const reviewRes = await fetch(
      `https://api.place.naver.com/place/v1/businesses/${businessId}/reviews?page=1&size=20&sorted=RECENTLY`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!reviewRes.ok) {
      const errText = await reviewRes.text();
      throw new Error(`리뷰 조회 실패: ${reviewRes.status} ${errText}`);
    }

    const data = await reviewRes.json();

    // 리뷰 데이터 정규화
    const reviews = (data.items || data.reviews || []).map(r => ({
      id: r.id || r.reviewId,
      platform: "naver",
      author: r.writer?.nickname || r.authorName || "익명",
      date: r.createdAt?.slice(0, 10) || "",
      rating: r.starRating || r.rating || 5,
      content: r.body || r.content || "",
      tags: r.keywords?.map(k => k.text) || [],
      replied: !!(r.reply || r.ownerReply),
      existingReply: r.reply?.body || r.ownerReply?.content || "",
      images: (r.photos?.length || r.images?.length || 0) > 0,
    }));

    res.status(200).json({ reviews });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
