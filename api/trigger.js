import axios from "axios";

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPO;
const ALLOWED_USER_IDS = process.env.ALLOWED_USER_ID
  ? process.env.ALLOWED_USER_ID.split(",").map((id) => Number(id.trim()))
  : [];
const TRIGGER_SECRET = process.env.TRIGGER_SECRET;

// telegram.js와 공유되는 prCache (각 요청마다 독립적이므로 여기선 무상태로 처리)

async function sendTelegram(chatId, text, replyMarkup) {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    await axios.post(url, {
      chat_id: chatId,
      text,
      reply_markup: replyMarkup,
    });
    console.log(`[TRIGGER] Message sent to chat ${chatId}`);
    return { success: true };
  } catch (error) {
    console.error(
      `[TRIGGER] Failed to send message to chat ${chatId}:`,
      error.response?.data || error.message,
    );
    return { success: false, error: error.message };
  }
}

async function getPullRequests() {
  let allPRs = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const res = await axios.get(`https://api.github.com/repos/${REPO}/pulls`, {
      headers: { Authorization: `token ${GITHUB_TOKEN}` },
      params: { state: "open", per_page: perPage, page },
    });
    allPRs = allPRs.concat(res.data);
    if (res.data.length < perPage) break;
    page++;
  }

  return allPRs;
}

export default async function handler(req, res) {
  console.log(`[TRIGGER] ${new Date().toISOString()} - trigger.js 실행됨`);

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Secret 검증
  const incomingSecret = req.headers["x-trigger-secret"] || req.body?.secret;
  if (!TRIGGER_SECRET || incomingSecret !== TRIGGER_SECRET) {
    console.warn(`[TRIGGER] Unauthorized request - invalid secret`);
    return res.status(401).json({ error: "Unauthorized" });
  }

  // 특정 chatId 지정 or 전체 허용 유저에게 전송
  const targetChatIds = req.body?.chat_id
    ? [Number(req.body.chat_id)]
    : ALLOWED_USER_IDS;

  if (targetChatIds.length === 0) {
    return res.status(400).json({ error: "No target chat IDs" });
  }

  try {
    console.log(`[TRIGGER] Fetching open PRs`);
    const prs = await getPullRequests();

    if (prs.length === 0) {
      await Promise.all(
        targetChatIds.map((chatId) =>
          sendTelegram(chatId, "ℹ️ 현재 열려있는 Pull Request가 없습니다."),
        ),
      );
      return res.status(200).json({ ok: true, message: "No open PRs" });
    }

    const buttons = prs.map((pr) => [
      {
        text: `#${pr.number} ${pr.title} (${pr.head.ref} → ${pr.base.ref})`,
        callback_data: `pr_${pr.number}`,
      },
    ]);

    await Promise.all(
      targetChatIds.map((chatId) =>
        sendTelegram(chatId, "🔽 머지할 Pull Request를 선택하세요:", {
          inline_keyboard: buttons,
        }),
      ),
    );

    console.log(
      `[TRIGGER] PR selection menu sent to ${targetChatIds.join(", ")}`,
    );
    return res.status(200).json({ ok: true, pr_count: prs.length });
  } catch (error) {
    console.error(`[TRIGGER] Error:`, error.message);
    await Promise.all(
      targetChatIds.map((chatId) =>
        sendTelegram(chatId, "❌ PR 목록을 가져오는데 실패했습니다."),
      ),
    );
    return res.status(500).json({ error: error.message });
  }
}
