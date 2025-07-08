import axios from "axios";

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPO;
const ALLOWED_USER_IDS = process.env.ALLOWED_USER_ID
  ? process.env.ALLOWED_USER_ID.split(",").map((id) => Number(id.trim()))
  : [];
const CI_LOG_URL = process.env.CI_LOG_URL || "";

async function sendTelegram(chatId, text, replyMarkup) {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    await axios.post(url, { chat_id: chatId, text, reply_markup: replyMarkup });
    return { success: true };
  } catch (error) {
    console.error("Telegram API error:", error.response?.data || error.message);
    return { success: false, error: error.message };
  }
}

async function getBranches() {
  try {
    let allBranches = [];
    let page = 1;
    const perPage = 100; // GitHub API 최대값

    while (true) {
      const res = await axios.get(
        `https://api.github.com/repos/${REPO}/branches`,
        {
          headers: { Authorization: `token ${GITHUB_TOKEN}` },
          params: {
            per_page: perPage,
            page: page,
          },
        }
      );

      const branches = res.data.map((b) => b.name);
      allBranches = allBranches.concat(branches);

      // 더 이상 브랜치가 없으면 중단
      if (branches.length < perPage) {
        break;
      }

      page++;
    }

    // dev, master, release, build 브랜치는 제외하고 반환
    const excludedBranches = ["dev", "master", "release", "build"];
    return allBranches.filter((name) => !excludedBranches.includes(name));
  } catch (error) {
    console.error("GitHub API error:", error.response?.data || error.message);
    throw new Error("브랜치 목록을 가져올 수 없습니다.");
  }
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
  console.log("telegram.js 실행됨");
  try {
    // GET 요청 처리 (상태 확인용)
    if (req.method === "GET") {
      return res.status(200).json({
        status: "OK",
        message: "Telegram Deploy Bot is running",
        timestamp: new Date().toISOString(),
      });
    }

    // HTTP 메서드 검증
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = req.body;
    const message = body.message;
    const callback = body.callback_query;

    if (message?.text === "/deploy") {
      const chatId = message.chat.id;
      console.log("Chat ID:", chatId);
      if (!ALLOWED_USER_IDS.includes(chatId)) {
        const result = await sendTelegram(chatId, "⚠️ 권한이 없습니다.");
        if (!result.success) {
          console.error("Failed to send unauthorized message:", result.error);
        }
        return res.status(200).json({ ok: true });
      }

      try {
        const branches = await getBranches();
        const buttons = branches.map((b) => [
          { text: b, callback_data: `deploy_${b}` },
        ]);

        const result = await sendTelegram(
          chatId,
          "🔽 배포할 브랜치를 선택하세요:",
          {
            inline_keyboard: buttons,
          }
        );

        if (!result.success) {
          console.error(
            "Failed to send branch selection message:",
            result.error
          );
          return res.status(500).json({ error: "Failed to send message" });
        }
      } catch (error) {
        console.error("Error fetching branches:", error.message);
        const result = await sendTelegram(
          chatId,
          "❌ 브랜치 목록을 가져오는데 실패했습니다."
        );
        if (!result.success) {
          console.error("Failed to send error message:", result.error);
        }
      }

      return res.status(200).json({ ok: true });
    }

    if (callback) {
      const chatId = callback.message.chat.id;
      if (!ALLOWED_USER_IDS.includes(chatId)) {
        return res.status(200).json({ ok: true });
      }

      const data = callback.data;
      if (data.startsWith("deploy_")) {
        const branch = data.replace("deploy_", "");

        try {
          const result = await mergeBranch(branch);

          let messageResult;
          if (result.success) {
            messageResult = await sendTelegram(
              chatId,
              `✅ [${branch}] 브랜치를 dev에 머지하고 배포를 시작했습니다.\n🔗 CI 로그: ${CI_LOG_URL}`
            );
          } else if (result.conflict) {
            messageResult = await sendTelegram(
              chatId,
              `❌ 병합 충돌 발생! [${branch}] → dev 수동 병합 필요\n오류: ${result.message}`
            );
          } else {
            messageResult = await sendTelegram(
              chatId,
              `❌ 오류 발생: ${result.message}`
            );
          }

          if (!messageResult.success) {
            console.error(
              "Failed to send merge result message:",
              messageResult.error
            );
          }
        } catch (error) {
          console.error("Error during merge process:", error.message);
          const result = await sendTelegram(
            chatId,
            `❌ 처리 중 오류 발생: ${error.message}`
          );
          if (!result.success) {
            console.error("Failed to send error message:", result.error);
          }
        }
      }

      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Handler error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
