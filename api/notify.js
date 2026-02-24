import axios from "axios";
import crypto from "crypto";

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ALLOWED_USER_IDS = process.env.ALLOWED_USER_ID
  ? process.env.ALLOWED_USER_ID.split(",").map((id) => Number(id.trim()))
  : [];
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

// GitHub Webhook signature 검증
function verifySignature(payload, signature) {
  if (!WEBHOOK_SECRET || !signature) {
    return false;
  }
  const hmac = crypto.createHmac("sha256", WEBHOOK_SECRET);
  const digest = "sha256=" + hmac.update(payload).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
}

async function sendTelegram(chatId, text) {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    await axios.post(url, {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
    });
    console.log(`[NOTIFY] Message sent to chat ${chatId}`);
  } catch (error) {
    console.error(
      `[NOTIFY] Failed to send message to chat ${chatId}:`,
      error.response?.data || error.message,
    );
  }
}

export default async function handler(req, res) {
  const timestamp = new Date().toISOString();
  console.log(`[NOTIFY] ${timestamp} - GitHub Webhook received`);

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // GitHub Webhook signature 검증
  const signature = req.headers["x-hub-signature-256"];
  const rawBody = JSON.stringify(req.body);

  if (!verifySignature(rawBody, signature)) {
    console.warn(`[NOTIFY] Unauthorized request - invalid signature`);
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { action, workflow_run } = req.body;

  // workflow_run completed 이벤트만 처리
  if (action !== "completed") {
    console.log(`[NOTIFY] Ignoring action: ${action}`);
    return res.status(200).json({ ok: true, message: "Not a completed event" });
  }

  // release 브랜치 배포만 알림
  const branch = workflow_run?.head_branch;
  if (branch !== "release") {
    console.log(`[NOTIFY] Ignoring branch: ${branch}`);
    return res.status(200).json({ ok: true, message: "Not release branch" });
  }

  const conclusion = workflow_run?.conclusion; // success, failure, cancelled, etc.
  const workflowName = workflow_run?.name || "Unknown Workflow";
  const runUrl = workflow_run?.html_url;

  console.log(
    `[NOTIFY] release 배포 완료 - conclusion=${conclusion}, workflow=${workflowName}`,
  );

  // 성공/실패에 따른 메시지 구성
  let statusEmoji, statusText;

  if (conclusion === "success") {
    statusEmoji = "✅";
    statusText = "배포 성공";
  } else if (conclusion === "failure") {
    statusEmoji = "❌";
    statusText = "배포 실패";
  } else if (conclusion === "cancelled") {
    statusEmoji = "⚠️";
    statusText = "배포 취소됨";
  } else {
    statusEmoji = "ℹ️";
    statusText = `배포 ${conclusion}`;
  }

  const text =
    `${statusEmoji} <b>${statusText}</b>\n\n` +
    `📋 워크플로우: <code>${workflowName}</code>\n` +
    `🌿 브랜치: <code>${branch}</code>\n` +
    (runUrl ? `\n🔗 <a href="${runUrl}">GitHub Actions 로그 보기</a>` : "");

  // 모든 허용된 사용자에게 알림 전송
  await Promise.all(
    ALLOWED_USER_IDS.map((chatId) => sendTelegram(chatId, text)),
  );

  return res.status(200).json({ ok: true });
}
