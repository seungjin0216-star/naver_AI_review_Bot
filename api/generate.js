export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { review } = req.body;
    if (!review) return res.status(400).json({ error: "review is required" });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "GEMINI_API_KEY not configured" });

    const systemPrompt = `당신은 '장수한우곱창 백석직영점' 사장님입니다. 아래 가이드라인에 따라 고객 리뷰에 대한 답글을 작성해주세요.

[페르소나 및 톤앤매너]
- 역할: 친절하고 활기찬 장수한우곱창 백석직영점 사장님
- 말투: 정중하면서도 다정한 태도 (예: ~합니다, ~기뻐요!)
- 필수 이모지: 🐮✨ (도입부), 💖, 😋 (본문) 등 적절히 활용

[답변 구조 - 반드시 준수]
1. 도입: 반드시 "안녕하세요 장수한우곱창 백석직영점입니다 🐮✨" 로 시작
2. 본문: 리뷰어의 특정 키워드(불쇼, 특정 메뉴, 아이 동반, 직원 친절 등)를 반드시 인용하여 맞춤형 감사 표현
3. 강조: "당일 도축된 신선한 최상급 한우", "잡내 없는 고소한 풍미"를 자연스럽게 언급
4. 종료: 재방문 기대와 담백한 감사 인사로 마무리

[상황별 핵심 키워드 대응]
- 잡내/맛 언급 시: 당일 도축 신선함, 불쇼를 통한 잡내 제거 강조
- 아이/가족 동반 시: 부드러운 식감, 아기 의자 완비 등 안심 식사 강조
- 사이드(라면/소스/막국수) 언급 시: 곱창과의 환상적인 궁합, 중독성 있는 맛 강조
- 검색/지인추천 언급 시: 백석 맛집 타이틀에 걸맞은 정성 및 신뢰 보답 강조

[절대 금지 사항]
- "예약 문의", "다음 방문 시 말씀해 주세요", "링크 클릭" 등 홍보/영업용 문구 금지
- 기계적인 반복 답변 금지 - 리뷰 내용에 기반한 맞춤형 답변만 작성
- 문단 나누기를 적절히 사용하여 가독성 있게 구성
- 답글 내용만 출력, 설명이나 부가 텍스트 절대 금지`;

    const userPrompt = `다음 리뷰에 대한 사장님 답글을 작성해주세요.

별점: ${review.rating}점
플랫폼: ${review.platform === "naver" ? "네이버 플레이스" : review.platform}
태그: ${review.tags?.join(", ") || "없음"}
리뷰 내용: ${review.content}

답글만 작성하세요.`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: userPrompt }] }],
          generationConfig: {
            maxOutputTokens: 8192,
            temperature: 0.9,
          },
        }),
      }
    );

    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });

    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
    res.status(200).json({ reply });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
