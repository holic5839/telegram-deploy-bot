import axios from "axios";

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPO;
const ALLOWED_USER_IDS = process.env.ALLOWED_USER_ID
  ? process.env.ALLOWED_USER_ID.split(",").map((id) => Number(id.trim()))
  : [];
const CI_LOG_URL = process.env.CI_LOG_URL || "";

// 초기 설정 정보 로그
console.log(`[INIT] Telegram Deploy Bot initialized`);
console.log(`[INIT] Repository: ${REPO}`);
console.log(`[INIT] Allowed User IDs: ${ALLOWED_USER_IDS.join(", ")}`);
console.log(`[INIT] CI Log URL: ${CI_LOG_URL}`);
console.log(`[INIT] Telegram Token: ${TELEGRAM_TOKEN ? "Set" : "Not Set"}`);
console.log(`[INIT] GitHub Token: ${GITHUB_TOKEN ? "Set" : "Not Set"}`);
console.log(`[INIT] Environment loaded successfully`);

async function sendTelegram(chatId, text, replyMarkup) {
  console.log(
    `[TELEGRAM] Sending message to chat ${chatId}: ${text.substring(0, 100)}...`
  );
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    const response = await axios.post(url, {
      chat_id: chatId,
      text,
      reply_markup: replyMarkup,
    });
    console.log(`[TELEGRAM] Message sent successfully to chat ${chatId}`);
    return { success: true };
  } catch (error) {
    console.error(
      `[TELEGRAM] API error for chat ${chatId}:`,
      error.response?.data || error.message
    );
    return { success: false, error: error.message };
  }
}

async function getBranches() {
  console.log(`[GITHUB] Fetching branches from repository: ${REPO}`);
  try {
    let allBranches = [];
    let page = 1;
    const perPage = 100; // GitHub API 최대값

    while (true) {
      console.log(`[GITHUB] Fetching branches page ${page}`);
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
      console.log(`[GITHUB] Page ${page}: Found ${branches.length} branches`);

      // 더 이상 브랜치가 없으면 중단
      if (branches.length < perPage) {
        break;
      }

      page++;
    }

    // dev, master, release, build 브랜치는 제외하고 반환
    const excludedBranches = [
      "dev",
      "master",
      "release",
      "build",
      "pre",
      "release-kaist",
    ];
    const filteredBranches = allBranches.filter(
      (name) => !excludedBranches.includes(name)
    );
    console.log(
      `[GITHUB] Total branches: ${allBranches.length}, Filtered branches: ${filteredBranches.length}`
    );
    console.log(`[GITHUB] Available branches: ${filteredBranches.join(", ")}`);
    return filteredBranches;
  } catch (error) {
    console.error("[GITHUB] API error:", error.response?.data || error.message);
    throw new Error("브랜치 목록을 가져올 수 없습니다.");
  }
}

async function mergeBranch(branch) {
  console.log(`[MERGE] Starting merge process for branch: ${branch}`);
  try {
    // dev 브랜치의 최신 상태 확인
    console.log(`[MERGE] Checking dev branch status`);
    const devBranchInfo = await axios.get(
      `https://api.github.com/repos/${REPO}/branches/dev`,
      {
        headers: { Authorization: `token ${GITHUB_TOKEN}` },
      }
    );

    console.log(
      `[MERGE] Dev branch is up to date. Latest commit: ${devBranchInfo.data.commit.sha}`
    );

    // 타겟 브랜치의 상태도 확인
    console.log(`[MERGE] Checking target branch ${branch} status`);
    const targetBranchInfo = await axios.get(
      `https://api.github.com/repos/${REPO}/branches/${branch}`,
      {
        headers: { Authorization: `token ${GITHUB_TOKEN}` },
      }
    );

    console.log(
      `[MERGE] Target branch ${branch} latest commit: ${targetBranchInfo.data.commit.sha}`
    );

    // GitHub API를 통한 직접 merge (PR 없이)
    console.log(`[MERGE] Executing merge: ${branch} -> dev`);
    const mergeResponse = await axios.post(
      `https://api.github.com/repos/${REPO}/merges`,
      {
        base: "dev",
        head: branch,
        commit_message: `Direct merge of ${branch} into dev via Telegram bot`,
      },
      {
        headers: { Authorization: `token ${GITHUB_TOKEN}` },
      }
    );

    console.log(
      `[MERGE] Successfully merged ${branch} into dev. New commit: ${mergeResponse.data.sha}`
    );
    return { success: true };
  } catch (e) {
    console.error(
      `[MERGE] Merge error for ${branch}:`,
      e.response?.data || e.message
    );

    if (e.response?.status === 409) {
      // 머지 충돌 또는 이미 머지됨
      const errorMessage = e.response.data.message;
      console.log(`[MERGE] Conflict detected for ${branch}: ${errorMessage}`);
      if (
        errorMessage.includes("already up to date") ||
        errorMessage.includes("up-to-date")
      ) {
        console.log(`[MERGE] Branch ${branch} is already up to date`);
        return {
          success: true,
          message: "이미 최신 상태입니다.",
        };
      }
      return {
        success: false,
        conflict: true,
        message: errorMessage,
      };
    }

    if (e.response?.status === 422) {
      // 유효하지 않은 요청 (존재하지 않는 브랜치 등)
      console.log(
        `[MERGE] Invalid request for ${branch}: ${e.response.data.message}`
      );
      return {
        success: false,
        conflict: false,
        message: e.response.data.message || "브랜치를 찾을 수 없습니다.",
      };
    }

    return { success: false, conflict: false, message: e.message };
  }
}

export default async function handler(req, res) {
  const timestamp = new Date().toISOString();
  console.log(`[HANDLER] ${timestamp} - telegram.js 실행됨`);
  console.log(`[HANDLER] Request method: ${req.method}`);
  console.log(`[HANDLER] Request headers:`, req.headers);

  try {
    // GET 요청 처리 (상태 확인용)
    if (req.method === "GET") {
      console.log(`[HANDLER] GET request - Health check`);
      return res.status(200).json({
        status: "OK",
        message: "Telegram Deploy Bot is running",
        timestamp: new Date().toISOString(),
      });
    }

    // HTTP 메서드 검증
    if (req.method !== "POST") {
      console.log(`[HANDLER] Invalid method: ${req.method}`);
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = req.body;
    console.log(`[HANDLER] Request body:`, JSON.stringify(body, null, 2));

    const message = body.message;
    const callback = body.callback_query;

    if (message?.text === "/deploy") {
      const chatId = message.chat.id;
      const username = message.from?.username || "unknown";
      const firstName = message.from?.first_name || "unknown";
      console.log(
        `[USER] Deploy command from user: ${username} (${firstName}), Chat ID: ${chatId}`
      );

      if (!ALLOWED_USER_IDS.includes(chatId)) {
        console.log(`[AUTH] Unauthorized user: ${chatId} (${username})`);
        console.log(`[AUTH] Allowed users: ${ALLOWED_USER_IDS.join(", ")}`);
        const result = await sendTelegram(chatId, "⚠️ 권한이 없습니다.");
        if (!result.success) {
          console.error(
            `[AUTH] Failed to send unauthorized message:`,
            result.error
          );
        }
        return res.status(200).json({ ok: true });
      }

      console.log(`[AUTH] Authorized user: ${chatId} (${username})`);

      try {
        console.log(`[WORKFLOW] Starting branch selection process`);
        const branches = await getBranches();
        const buttons = branches.map((b) => [
          { text: b, callback_data: `deploy_${b}` },
        ]);

        console.log(
          `[WORKFLOW] Sending branch selection menu with ${buttons.length} options`
        );
        const result = await sendTelegram(
          chatId,
          "🔽 배포할 브랜치를 선택하세요:",
          {
            inline_keyboard: buttons,
          }
        );

        if (!result.success) {
          console.error(
            `[WORKFLOW] Failed to send branch selection message:`,
            result.error
          );
          return res.status(500).json({ error: "Failed to send message" });
        }
        console.log(`[WORKFLOW] Branch selection menu sent successfully`);
      } catch (error) {
        console.error(`[WORKFLOW] Error fetching branches:`, error.message);
        const result = await sendTelegram(
          chatId,
          "❌ 브랜치 목록을 가져오는데 실패했습니다."
        );
        if (!result.success) {
          console.error(
            `[WORKFLOW] Failed to send error message:`,
            result.error
          );
        }
      }

      return res.status(200).json({ ok: true });
    }

    if (callback) {
      const chatId = callback.message.chat.id;
      const username = callback.from?.username || "unknown";
      const firstName = callback.from?.first_name || "unknown";
      console.log(
        `[USER] Callback from user: ${username} (${firstName}), Chat ID: ${chatId}`
      );
      console.log(`[USER] Callback data: ${callback.data}`);

      if (!ALLOWED_USER_IDS.includes(chatId)) {
        console.log(
          `[AUTH] Unauthorized callback from user: ${chatId} (${username})`
        );
        return res.status(200).json({ ok: true });
      }

      const data = callback.data;
      if (data.startsWith("deploy_")) {
        const branch = data.replace("deploy_", "");
        console.log(`[WORKFLOW] User selected branch: ${branch}`);

        try {
          console.log(
            `[WORKFLOW] Starting merge process for branch: ${branch}`
          );
          const result = await mergeBranch(branch);

          let messageResult;
          if (result.success) {
            console.log(`[WORKFLOW] Merge successful for branch: ${branch}`);
            messageResult = await sendTelegram(
              chatId,
              `✅ [${branch}] 브랜치를 dev에 머지하고 배포를 시작했습니다.\n🔗 CI 로그: ${CI_LOG_URL}`
            );
          } else if (result.conflict) {
            console.log(`[WORKFLOW] Merge conflict for branch: ${branch}`);
            messageResult = await sendTelegram(
              chatId,
              `❌ 병합 충돌 발생! [${branch}] → dev 수동 병합 필요\n오류: ${result.message}`
            );
          } else {
            console.log(
              `[WORKFLOW] Merge failed for branch: ${branch} - ${result.message}`
            );
            messageResult = await sendTelegram(
              chatId,
              `❌ 오류 발생: ${result.message}`
            );
          }

          if (!messageResult.success) {
            console.error(
              `[WORKFLOW] Failed to send merge result message:`,
              messageResult.error
            );
          }
        } catch (error) {
          console.error(
            `[WORKFLOW] Error during merge process:`,
            error.message
          );
          const result = await sendTelegram(
            chatId,
            `❌ 처리 중 오류 발생: ${error.message}`
          );
          if (!result.success) {
            console.error(
              `[WORKFLOW] Failed to send error message:`,
              result.error
            );
          }
        }
      } else {
        console.log(`[WORKFLOW] Unknown callback data: ${data}`);
      }

      return res.status(200).json({ ok: true });
    }

    console.log(`[HANDLER] No matching conditions - returning OK`);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error(`[HANDLER] Handler error:`, error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
