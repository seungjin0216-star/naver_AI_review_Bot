import { useState, useEffect, useCallback } from "react";

// ============================================================
// CONFIG - 여기에 본인 정보 입력
// ============================================================
const CONFIG = {
  // 네이버 개발자센터에서 발급받은 Client ID
  NAVER_CLIENT_ID: "YOUR_NAVER_CLIENT_ID",
  // 네이버 개발자센터에 등록한 Callback URL (현재 도메인과 일치해야 함)
  NAVER_REDIRECT_URI: window.location.origin + "/callback",
  // ★ Google AI Studio에서 발급받은 Gemini API Key 입력
  // 발급 주소: https://aistudio.google.com/app/apikey
  GEMINI_API_KEY: "AIzaSyA6qxRGBChLTblx3EFvg3zz1VQO-cJmAlU",
};

// ============================================================
// MOCK DATA - 실제 연동 전 테스트용
// ============================================================
const MOCK_REVIEWS = [
  {
    id: "rev_001",
    platform: "naver",
    author: "지현**",
    date: "2026-03-15",
    rating: 5,
    content:
      "친구추천으로 왔는데 곱창이 정말 신선하고 맛있었어요! 잡내가 전혀 없고 고소한 맛이 일품이었습니다. 직원분들도 너무 친절하시고 다음에도 꼭 올게요~",
    tags: ["음식이 맛있어요", "친절해요"],
    replied: false,
    images: true,
  },
  {
    id: "rev_002",
    platform: "naver",
    author: "맛집탐방**",
    date: "2026-03-14",
    rating: 5,
    content:
      "백석역 근처 곱창 맛집 찾다가 왔는데 대박이네요. 당일도축 한우라서 그런지 신선도가 달라요. 대창이 특히 맛있었고 반찬도 깔끔하게 잘 나왔어요.",
    tags: ["음식이 맛있어요", "고기 질이 좋아요"],
    replied: false,
    images: false,
  },
  {
    id: "rev_003",
    platform: "naver",
    author: "abc****",
    date: "2026-03-13",
    rating: 4,
    content:
      "초등아들이랑 남편이랑 재방문입니다! 아이도 곱창을 너무 맛있게 잘 먹네요. 다른 집들보다 대창이랑 곱창이 너무 맛있고 잡내 전혀없고 고소합니다.",
    tags: ["음식이 맛있어요", "반찬이 잘 나와요"],
    replied: true,
    existingReply:
      "초딩 아드님과 함께 다시 찾아주셔서 정말 감사합니다! 아이도 곱창을 맛있게 잘 먹었다니 저희도 너무 뿌듯해요!",
    images: true,
  },
  {
    id: "rev_004",
    platform: "baemin",
    author: "당당45",
    date: "2026-03-12",
    rating: 5,
    content:
      "방어가 제철이라 한 번 시켜봤는데 정말 기름지고 너무 맛있어요!! 다음에 또 주문할게요!",
    tags: [],
    replied: false,
    images: false,
  },
];

// ============================================================
// 실제 답글 예시 (AI 학습용 few-shot)
// ============================================================
const REPLY_EXAMPLES = [
  {
    review:
      "사진까지 예쁘게 찍어주시고 정성 가득한 후기 감사합니다! 사진 보니 저도 배가 고파지네요.",
    reply:
      "사진까지 예쁘게 찍어주시고 정성 가득한 후기 감사합니다! 사진 보니 저도 배가 고파지네요. 다음 방문 때는 더 큰 감동 드릴 수 있도록 연구하고 노력하겠습니다!",
  },
  {
    review: "초등아들이랑 남편이랑 재방문입니다! 아이도 곱창을 너무 맛있게 잘 먹네요.",
    reply:
      "초딩 아드님과 함께 다시 찾아주셔서 정말 감사합니다! 😊 아이도 곱창을 맛있게 잘 먹었다니 저희도 너무 뿌듯해요! 잡내 없이 고소한 대창과 곱창이 당일 도축한 신선한 한우라서 그런가 봐요~ 👍 다음에도 맛있는 곱창으로 보답하는 장수한우곱창 백석직영점이 되겠습니다! 또 방문해 주세요~",
  },
];

// ============================================================
// COMPONENTS
// ============================================================

const platformColors = {
  naver: { bg: "#03C75A", text: "white", label: "N" },
  baemin: { bg: "#2AC1BC", text: "white", label: "배" },
  yogiyo: { bg: "#FA0050", text: "white", label: "요" },
  coupang: { bg: "#FECD00", text: "#333", label: "쿠" },
  ddangyo: { bg: "#FF6B00", text: "white", label: "땡" },
};

const StarRating = ({ rating }) => (
  <span style={{ color: "#FFB800", fontSize: "14px", letterSpacing: "1px" }}>
    {"★".repeat(rating)}{"☆".repeat(5 - rating)}
  </span>
);

const PlatformBadge = ({ platform }) => {
  const p = platformColors[platform] || platformColors.naver;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      width: "28px", height: "28px", borderRadius: "8px",
      background: p.bg, color: p.text,
      fontSize: "12px", fontWeight: "700",
    }}>{p.label}</span>
  );
};

// ============================================================
// MAIN APP
// ============================================================
export default function App() {
  const [stage, setStage] = useState("login"); // login | main
  const [naverToken, setNaverToken] = useState(null);
  const [reviews, setReviews] = useState(MOCK_REVIEWS);
  const [selectedReview, setSelectedReview] = useState(null);
  const [generatedReply, setGeneratedReply] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [isPosting, setIsPosting] = useState(false);
  const [filter, setFilter] = useState("unreplied"); // all | unreplied
  const [toast, setToast] = useState(null);
  const [customPrompt, setCustomPrompt] = useState(
    "장수한우곱창 백석직영점 사장님 톤으로, 당일도축 한우의 신선함을 강조하며, 따뜻하고 친근하게, 이모지 1-2개 포함, 150-250자 이내로 답글을 작성해주세요."
  );
  const [showSettings, setShowSettings] = useState(false);

  const showToast = (msg, type = "success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  // 네이버 OAuth 로그인
  const handleNaverLogin = () => {
    const state = Math.random().toString(36).substring(2);
    sessionStorage.setItem("naver_state", state);
    // 실제 환경에서는 아래 URL로 리디렉션
    // const url = `https://nid.naver.com/oauth2.0/authorize?response_type=code&client_id=${CONFIG.NAVER_CLIENT_ID}&redirect_uri=${encodeURIComponent(CONFIG.NAVER_REDIRECT_URI)}&state=${state}`;
    // window.location.href = url;
    
    // 데모: 바로 로그인 성공 처리
    setNaverToken("demo_token_장수한우곱창");
    setStage("main");
    showToast("네이버 로그인 성공! 리뷰를 불러오는 중...");
  };

  // 리뷰 크롤링 (실제: smartplace API 호출)
  const fetchReviews = useCallback(async () => {
    showToast("리뷰를 불러왔습니다 ✓");
    // 실제 구현:
    // const res = await fetch("https://smartplace.naver.com/businessticket/reviews", {
    //   headers: { Cookie: `NID_AUT=${naverToken}` }
    // });
  }, [naverToken]);

  useEffect(() => {
    if (stage === "main") fetchReviews();
  }, [stage]);

  // AI 답글 생성
  const generateReply = async (review) => {
    setIsGenerating(true);
    setGeneratedReply("");

    const prompt = `
당신은 "${review.platform === "naver" ? "네이버 플레이스" : "배달앱"}" 리뷰에 답글을 다는 장수한우곱창 사장님입니다.

[매장 정보]
- 매장명: 장수한우곱창 백석직영점
- 특징: 당일도축 한우만 사용, 잡내 없는 고소한 곱창/대창

[답글 스타일 예시]
${REPLY_EXAMPLES.map((e, i) => `예시${i+1})\n리뷰: ${e.review}\n답글: ${e.reply}`).join("\n\n")}

[추가 지시사항]
${customPrompt}

[작성할 리뷰]
별점: ${review.rating}점
태그: ${review.tags.join(", ") || "없음"}
내용: ${review.content}

위 리뷰에 대한 사장님 답글만 작성해주세요. 설명이나 부가 텍스트 없이 답글 내용만 출력하세요.`;

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${CONFIG.GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: 600, temperature: 0.8 },
          }),
        }
      );
      const data = await response.json();
      if (data.error) throw new Error(data.error.message);
      const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || "답글 생성에 실패했습니다.";
      setGeneratedReply(reply.trim());
    } catch (e) {
      setGeneratedReply("⚠️ Gemini API 오류: " + e.message + "\nCONFIG의 GEMINI_API_KEY를 확인해주세요.");
    }
    setIsGenerating(false);
  };

  // 답글 등록
  const postReply = async () => {
    if (!generatedReply || !selectedReview) return;
    setIsPosting(true);

    // 실제 구현:
    // await fetch(`https://smartplace.naver.com/businessticket/reviews/${selectedReview.id}/reply`, {
    //   method: "POST",
    //   headers: { "Content-Type": "application/json", Cookie: `NID_AUT=${naverToken}` },
    //   body: JSON.stringify({ content: generatedReply }),
    // });

    await new Promise(r => setTimeout(r, 1200)); // 데모 딜레이

    setReviews(prev => prev.map(r =>
      r.id === selectedReview.id
        ? { ...r, replied: true, existingReply: generatedReply }
        : r
    ));
    setIsPosting(false);
    setSelectedReview(null);
    setGeneratedReply("");
    showToast("✅ 답글이 등록되었습니다!");
  };

  const filteredReviews = reviews.filter(r =>
    filter === "all" ? true : !r.replied
  );

  // ============================================================
  // RENDER: LOGIN
  // ============================================================
  if (stage === "login") {
    return (
      <div style={{
        minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
        background: "linear-gradient(135deg, #0f0f0f 0%, #1a1a2e 50%, #16213e 100%)",
        fontFamily: "'Noto Sans KR', sans-serif",
        padding: "20px",
      }}>
        <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700;900&display=swap" rel="stylesheet" />
        
        <div style={{
          background: "rgba(255,255,255,0.03)",
          backdropFilter: "blur(20px)",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: "24px",
          padding: "48px 40px",
          width: "100%", maxWidth: "400px",
          textAlign: "center",
          boxShadow: "0 32px 64px rgba(0,0,0,0.4)",
        }}>
          <div style={{
            width: "64px", height: "64px", borderRadius: "18px",
            background: "linear-gradient(135deg, #03C75A, #00a847)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: "28px", fontWeight: "900", color: "white",
            margin: "0 auto 24px", boxShadow: "0 8px 24px rgba(3,199,90,0.3)",
          }}>N</div>

          <h1 style={{ color: "white", fontSize: "22px", fontWeight: "700", margin: "0 0 8px" }}>
            리뷰 AI 답글 시스템
          </h1>
          <p style={{ color: "rgba(255,255,255,0.5)", fontSize: "14px", margin: "0 0 36px", lineHeight: "1.6" }}>
            네이버 스마트플레이스 리뷰를<br />AI로 빠르게 관리하세요
          </p>

          <button
            onClick={handleNaverLogin}
            style={{
              width: "100%", padding: "16px",
              background: "#03C75A", color: "white",
              border: "none", borderRadius: "12px",
              fontSize: "16px", fontWeight: "700",
              cursor: "pointer", letterSpacing: "0.5px",
              boxShadow: "0 4px 16px rgba(3,199,90,0.3)",
              transition: "all 0.2s",
            }}
            onMouseOver={e => e.target.style.background = "#02b350"}
            onMouseOut={e => e.target.style.background = "#03C75A"}
          >
            N  네이버로 로그인
          </button>

          <p style={{ color: "rgba(255,255,255,0.25)", fontSize: "12px", margin: "20px 0 0", lineHeight: "1.6" }}>
            네이버 개발자센터에서 발급받은<br />Client ID가 CONFIG에 설정되어 있어야 합니다
          </p>
        </div>
      </div>
    );
  }

  // ============================================================
  // RENDER: MAIN
  // ============================================================
  return (
    <div style={{
      minHeight: "100vh",
      background: "#f5f6f8",
      fontFamily: "'Noto Sans KR', sans-serif",
    }}>
      <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700;900&display=swap" rel="stylesheet" />

      {/* Toast */}
      {toast && (
        <div style={{
          position: "fixed", top: "20px", left: "50%", transform: "translateX(-50%)",
          background: toast.type === "error" ? "#ff4757" : "#2ed573",
          color: "white", padding: "12px 24px", borderRadius: "100px",
          fontSize: "14px", fontWeight: "600", zIndex: 9999,
          boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
          animation: "fadeIn 0.3s ease",
        }}>{toast.msg}</div>
      )}

      {/* Header */}
      <div style={{
        background: "white",
        borderBottom: "1px solid #eee",
        padding: "0 20px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        height: "60px", position: "sticky", top: 0, zIndex: 100,
        boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <div style={{
            width: "32px", height: "32px", borderRadius: "8px",
            background: "#03C75A", display: "flex", alignItems: "center",
            justifyContent: "center", color: "white", fontWeight: "900", fontSize: "14px",
          }}>N</div>
          <div>
            <div style={{ fontWeight: "700", fontSize: "15px", color: "#111" }}>장수한우곱창</div>
            <div style={{ fontSize: "11px", color: "#999" }}>AI 리뷰 답글 관리</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <button
            onClick={() => { fetchReviews(); }}
            style={{
              padding: "7px 14px", background: "#f0f0f0", border: "none",
              borderRadius: "8px", fontSize: "13px", cursor: "pointer", color: "#555",
            }}
          >🔄 새로고침</button>
          <button
            onClick={() => setShowSettings(!showSettings)}
            style={{
              padding: "7px 14px", background: showSettings ? "#111" : "#f0f0f0",
              border: "none", borderRadius: "8px", fontSize: "13px",
              cursor: "pointer", color: showSettings ? "white" : "#555",
            }}
          >⚙️ 설정</button>
        </div>
      </div>

      {/* Settings Panel */}
      {showSettings && (
        <div style={{
          background: "#111", color: "white", padding: "20px",
          borderBottom: "1px solid #333",
        }}>
          <div style={{ maxWidth: "800px", margin: "0 auto" }}>
            <p style={{ margin: "0 0 8px", fontSize: "13px", color: "#aaa" }}>
              🤖 AI 답글 생성 지시사항 (프롬프트 커스터마이징)
            </p>
            <textarea
              value={customPrompt}
              onChange={e => setCustomPrompt(e.target.value)}
              rows={3}
              style={{
                width: "100%", background: "#222", color: "white",
                border: "1px solid #444", borderRadius: "8px",
                padding: "10px 12px", fontSize: "13px", lineHeight: "1.6",
                resize: "vertical", boxSizing: "border-box",
              }}
            />
            <p style={{ margin: "8px 0 0", fontSize: "12px", color: "#666" }}>
              매장 특징, 원하는 톤, 이모지 사용 여부, 글자수 등을 자유롭게 지정하세요
            </p>
          </div>
        </div>
      )}

      <div style={{ maxWidth: "900px", margin: "0 auto", padding: "20px" }}>

        {/* Stats */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "12px", marginBottom: "20px" }}>
          {[
            { label: "전체 리뷰", value: reviews.length, color: "#6c5ce7" },
            { label: "미답글", value: reviews.filter(r => !r.replied).length, color: "#e17055" },
            { label: "답글 완료", value: reviews.filter(r => r.replied).length, color: "#00b894" },
          ].map(s => (
            <div key={s.label} style={{
              background: "white", borderRadius: "14px", padding: "16px 20px",
              boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
              borderLeft: `4px solid ${s.color}`,
            }}>
              <div style={{ fontSize: "24px", fontWeight: "900", color: s.color }}>{s.value}</div>
              <div style={{ fontSize: "13px", color: "#888", marginTop: "2px" }}>{s.label}</div>
            </div>
          ))}
        </div>

        {/* Filter */}
        <div style={{ display: "flex", gap: "8px", marginBottom: "16px" }}>
          {[["unreplied", "미답글만"], ["all", "전체"]].map(([val, label]) => (
            <button
              key={val}
              onClick={() => setFilter(val)}
              style={{
                padding: "8px 18px", borderRadius: "100px",
                border: filter === val ? "none" : "1px solid #ddd",
                background: filter === val ? "#111" : "white",
                color: filter === val ? "white" : "#666",
                fontSize: "13px", fontWeight: "600", cursor: "pointer",
              }}
            >{label}</button>
          ))}
        </div>

        {/* Review List */}
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {filteredReviews.length === 0 && (
            <div style={{
              background: "white", borderRadius: "14px", padding: "40px",
              textAlign: "center", color: "#aaa", fontSize: "15px",
            }}>
              🎉 모든 리뷰에 답글을 달았습니다!
            </div>
          )}
          {filteredReviews.map(review => (
            <div
              key={review.id}
              style={{
                background: "white", borderRadius: "14px",
                boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
                overflow: "hidden",
                border: selectedReview?.id === review.id ? "2px solid #111" : "2px solid transparent",
                transition: "border 0.2s",
              }}
            >
              {/* Review Header */}
              <div style={{ padding: "16px 20px 12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "8px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <PlatformBadge platform={review.platform} />
                    <span style={{ fontWeight: "700", fontSize: "15px" }}>{review.author}</span>
                    <StarRating rating={review.rating} />
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span style={{ fontSize: "12px", color: "#bbb" }}>{review.date}</span>
                    {review.replied
                      ? <span style={{ fontSize: "12px", color: "#00b894", fontWeight: "600", background: "#f0faf7", padding: "2px 8px", borderRadius: "6px" }}>✓ 답글완료</span>
                      : <span style={{ fontSize: "12px", color: "#e17055", fontWeight: "600", background: "#fff5f3", padding: "2px 8px", borderRadius: "6px" }}>미답글</span>
                    }
                  </div>
                </div>

                {/* Tags */}
                {review.tags.length > 0 && (
                  <div style={{ display: "flex", gap: "6px", marginBottom: "8px", flexWrap: "wrap" }}>
                    {review.tags.map(tag => (
                      <span key={tag} style={{
                        fontSize: "12px", color: "#555",
                        background: "#f5f5f5", padding: "2px 10px",
                        borderRadius: "100px", border: "1px solid #eee",
                      }}>{tag}</span>
                    ))}
                  </div>
                )}

                {/* Content */}
                <p style={{ margin: "0", fontSize: "14px", lineHeight: "1.7", color: "#333" }}>
                  {review.content}
                </p>

                {/* Existing Reply */}
                {review.replied && review.existingReply && (
                  <div style={{
                    marginTop: "12px", padding: "12px 14px",
                    background: "#f8f9fa", borderRadius: "10px",
                    borderLeft: "3px solid #00b894",
                  }}>
                    <div style={{ fontSize: "11px", color: "#00b894", fontWeight: "700", marginBottom: "4px" }}>사장님 답글</div>
                    <p style={{ margin: 0, fontSize: "13px", color: "#555", lineHeight: "1.6" }}>{review.existingReply}</p>
                  </div>
                )}
              </div>

              {/* Action Bar */}
              {!review.replied && (
                <div style={{
                  padding: "12px 20px",
                  background: "#fafafa",
                  borderTop: "1px solid #f0f0f0",
                  display: "flex", justifyContent: "flex-end",
                }}>
                  <button
                    onClick={() => {
                      setSelectedReview(review);
                      setGeneratedReply("");
                      generateReply(review);
                    }}
                    style={{
                      padding: "9px 20px",
                      background: "linear-gradient(135deg, #111, #333)",
                      color: "white", border: "none",
                      borderRadius: "10px", fontSize: "13px",
                      fontWeight: "700", cursor: "pointer",
                      display: "flex", alignItems: "center", gap: "6px",
                    }}
                  >
                    ✨ AI 답글 생성
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Reply Modal */}
      {selectedReview && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
          display: "flex", alignItems: "flex-end", justifyContent: "center",
          zIndex: 1000, padding: "0",
        }}
          onClick={e => { if (e.target === e.currentTarget) { setSelectedReview(null); setGeneratedReply(""); } }}
        >
          <div style={{
            background: "white", width: "100%", maxWidth: "600px",
            borderRadius: "20px 20px 0 0", padding: "24px 24px 36px",
            maxHeight: "85vh", overflowY: "auto",
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <h3 style={{ margin: 0, fontSize: "17px", fontWeight: "700" }}>AI 답글 생성</h3>
              <button
                onClick={() => { setSelectedReview(null); setGeneratedReply(""); }}
                style={{ background: "none", border: "none", fontSize: "20px", cursor: "pointer", color: "#999" }}
              >×</button>
            </div>

            {/* Original Review */}
            <div style={{
              background: "#f8f9fa", borderRadius: "12px", padding: "14px",
              marginBottom: "16px", fontSize: "14px", color: "#555", lineHeight: "1.7",
            }}>
              <div style={{ fontWeight: "700", color: "#111", marginBottom: "6px", display: "flex", alignItems: "center", gap: "8px" }}>
                <PlatformBadge platform={selectedReview.platform} />
                {selectedReview.author} · <StarRating rating={selectedReview.rating} />
              </div>
              {selectedReview.content}
            </div>

            {/* Generated Reply */}
            <div style={{ marginBottom: "16px" }}>
              <div style={{ fontSize: "13px", fontWeight: "700", color: "#111", marginBottom: "8px" }}>
                생성된 답글
              </div>
              {isGenerating ? (
                <div style={{
                  background: "#f8f9fa", borderRadius: "12px", padding: "20px",
                  textAlign: "center", color: "#aaa", fontSize: "14px",
                }}>
                  <div style={{ fontSize: "24px", marginBottom: "8px" }}>✨</div>
                  AI가 답글을 생성하고 있습니다...
                </div>
              ) : (
                <textarea
                  value={generatedReply}
                  onChange={e => setGeneratedReply(e.target.value)}
                  rows={6}
                  style={{
                    width: "100%", border: "1px solid #e0e0e0",
                    borderRadius: "12px", padding: "14px",
                    fontSize: "14px", lineHeight: "1.7", color: "#333",
                    resize: "vertical", boxSizing: "border-box",
                    fontFamily: "'Noto Sans KR', sans-serif",
                  }}
                  placeholder="AI 답글 생성 버튼을 누르면 여기에 답글이 나타납니다..."
                />
              )}
              {generatedReply && (
                <div style={{ fontSize: "12px", color: "#aaa", textAlign: "right", marginTop: "4px" }}>
                  {generatedReply.length}자 · 직접 수정 가능합니다
                </div>
              )}
            </div>

            {/* Action Buttons */}
            <div style={{ display: "flex", gap: "10px" }}>
              <button
                onClick={() => generateReply(selectedReview)}
                disabled={isGenerating}
                style={{
                  flex: 1, padding: "14px",
                  background: "#f0f0f0", border: "none",
                  borderRadius: "12px", fontSize: "14px",
                  fontWeight: "600", cursor: "pointer", color: "#555",
                }}
              >🔄 재생성</button>
              <button
                onClick={postReply}
                disabled={!generatedReply || isGenerating || isPosting}
                style={{
                  flex: 2, padding: "14px",
                  background: generatedReply && !isGenerating ? "linear-gradient(135deg, #03C75A, #00a847)" : "#ccc",
                  border: "none", borderRadius: "12px",
                  fontSize: "14px", fontWeight: "700",
                  cursor: generatedReply ? "pointer" : "not-allowed",
                  color: "white",
                  boxShadow: generatedReply ? "0 4px 16px rgba(3,199,90,0.3)" : "none",
                }}
              >{isPosting ? "등록 중..." : "✓ 답글 등록"}</button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateX(-50%) translateY(-10px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }
        * { box-sizing: border-box; }
        textarea:focus { outline: none; border-color: #111 !important; }
      `}</style>
    </div>
  );
}
