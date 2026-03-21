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

  const businessId = req.query.businessId || "8250200";

  // 시도할 엔드포인트 목록
  const endpoints = [
    `https://smartplace.naver.com/businessticket/v1/businesses/${businessId}/reviews?page=1&size=20`,
    `https://smartplace.naver.com/v1/businesses/${businessId}/reviews?page=1&size=20`,
    `https://m.place.naver.com/place/${businessId}/review/visitor?page=1&display=20`,
  ];

  const headers = {
    "Authorization": `Bearer ${token}`,
    "Cookie": `NID_AUT=${token}`,
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Referer": "https://smartplace.naver.com/",
    "Accept": "application/json",
  };

  let lastError = "";

  for (const url of endpoints) {
    try {
      const r = await fetch(url, { headers });
      const text = await r.text();

      // HTML 응답이면 스킵
      if (text.trim().startsWith("<")) {
        lastError = `${url} → HTML 응답 (${r.status})`;
        continue;
      }

      const data = JSON.parse(text);
      if (r.ok && (data.items || data.reviews || data.list || data.contents)) {
        return res.status(200).json({
          reviews: normalizeReviews(data),
          source: url,
        });
      }
      lastError = `${url} → ${r.status}: ${text.slice(0, 100)}`;
    } catch (e) {
      lastError = `${url} → ${e.message}`;
    }
  }

  // 모든 엔드포인트 실패 시 상세 오류 반환
  return res.status(500).json({
    error: "리뷰를 가져오지 못했습니다. 네이버 스마트플레이스 API 접근이 제한되어 있습니다.",
    detail: lastError,
    solution: "스마트플레이스 직접 세션 로그인 방식으로 전환이 필요합니다.",
  });
}

function normalizeReviews(data) {
  const items = data.items || data.reviews || data.list || data.contents || [];
  return items.map(r => ({
    id: String(r.id || r.reviewId || r.review_id || Math.random()),
    platform: "naver",
    author: r.writer?.nickname || r.writerInfo?.nickname || r.authorName || r.nickname || "익명",
    date: (r.createdAt || r.createDate || r.visitDate || "").slice(0, 10),
    rating: r.starRating || r.rating || 5,
    content: r.body || r.content || r.text || r.reviewText || "",
    tags: (r.keywords || r.tags || []).map(k => k.text || k.name || k),
    replied: !!(r.reply || r.ownerReply || r.replyContent),
    existingReply: r.reply?.body || r.ownerReply?.content || r.replyContent || "",
    images: (r.photos?.length || r.imageCount || 0) > 0,
  }));
}
