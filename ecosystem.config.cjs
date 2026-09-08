/**
 * PM2 설정 — 매일 09:00 / 18:00 자동 실행
 *
 * 등록:   pm2 start ecosystem.config.cjs
 * 저장:   pm2 save                (부팅 후 자동 복구)
 * 상태:   pm2 list
 * 로그:   pm2 logs naver-review-bot
 * 수동실행: pm2 restart naver-review-bot
 * 중지:   pm2 stop naver-review-bot
 */
const path = require("node:path");

module.exports = {
  apps: [
    {
      name: "naver-review-bot",
      script: "auto-reply.js",
      cwd: __dirname,
      interpreter: "node",

      // 한 번 실행하고 끝나는 스크립트이므로 자동 재시작은 끈다
      autorestart: false,
      watch: false,

      // 매일 01:00, 09:00 에 실행 (노트북 시간 기준)
      //
      // ⚠️ 2026-09-07 — 이 값을 함부로 바꾸지 마세요.
      //    사장님이 정하신 시각입니다. 새벽 1시는 마감 뒤 리뷰를 받고,
      //    아침 9시는 밤사이 올라온 리뷰를 받습니다.
      //    저장소에는 9,18 로 적혀 있었는데 노트북에서만 1시로 고쳐져 있어서
      //    「파일과 실제가 다른」 상태로 오래 지냈습니다. 이제 저장소를 맞춥니다.
      cron_restart: "0 1,9 * * *",

      time: true,
      out_file: path.join(__dirname, "logs", "out.log"),
      error_file: path.join(__dirname, "logs", "err.log"),
      merge_logs: true,
    },
  ],
};
