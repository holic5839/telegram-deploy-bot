import axios from "axios";

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPO;
const ALLOWED_USER_ID = Number(process.env.ALLOWED_USER_ID);
const CI_LOG_URL = process.env.CI_LOG_URL || "";

async function sendTelegram(chatId, text, replyMarkup) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  await axios.post(url, { chat_id: chatId, text, reply_markup: replyMarkup });
}

async function getBranches() {
  const res = await axios.get(`https://api.github.com/repos/${REPO}/branches`, {
    headers: { Authorization: `token ${GITHUB_TOKEN}` },
  });
  // dev 브랜치는 제외하고 반환
  return res.data.map((b) => b.name).filter((n) => n !== "dev");
}

async function mergeBranch(branch) {
  try {
    await axios.post(
      `https://api.github.com/repos/${REPO}/merges`,
      {
        base: "dev",
        head: branch,
        commit_message: `Telegram triggered merge of ${branch}`,
      },
      {
        headers: { Authorization: `token ${GITHUB_TOKEN}` },
      }
    );
    return { success: true };
  } catch (e) {
    if (e.response?.status === 409) {
      return {
        success: false,
        conflict: true,
        message: e.response.data.message,
      };
    }
    return { success: false, conflict: false, message: e.message };
  }
}

export default async function handler(req, res) {
  const body = req.body;
  const message = body.message;
  const callback = body.callback_query;

  if (message?.text === "/deploy") {
    const chatId = message.chat.id;
    if (chatId !== ALLOWED_USER_ID) {
      await sendTelegram(chatId, "⚠️ 권한이 없습니다.");
      return res.status(403).end();
    }

    const branches = await getBranches();
    const buttons = branches.map((b) => [
      { text: b, callback_data: `deploy_${b}` },
    ]);

    await sendTelegram(chatId, "🔽 배포할 브랜치를 선택하세요:", {
      inline_keyboard: buttons,
    });
    return res.status(200).end();
  }

  if (callback) {
    const chatId = callback.message.chat.id;
    if (chatId !== ALLOWED_USER_ID) return res.status(403).end();

    const data = callback.data;
    if (data.startsWith("deploy_")) {
      const branch = data.replace("deploy_", "");
      const result = await mergeBranch(branch);

      if (result.success) {
        await sendTelegram(
          chatId,
          `✅ [${branch}] 브랜치를 dev에 머지하고 배포를 시작했습니다.\n🔗 CI 로그: ${CI_LOG_URL}`
        );
      } else if (result.conflict) {
        await sendTelegram(
          chatId,
          `❌ 병합 충돌 발생! [${branch}] → dev 수동 병합 필요\n오류: ${result.message}`
        );
      } else {
        await sendTelegram(chatId, `❌ 오류 발생: ${result.message}`);
      }
      return res.status(200).end();
    }
  }

  return res.status(200).end();
}
