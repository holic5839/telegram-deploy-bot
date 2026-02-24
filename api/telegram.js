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

// Telegram callback_data 최대 64바이트 제한을 위한 PR 번호 매핑 캐시
const prCache = new Map();

async function sendTelegram(chatId, text, replyMarkup) {
  console.log(
    `[TELEGRAM] Sending message to chat ${chatId}: ${text.substring(0, 100)}...`,
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
      error.response?.data || error.message,
    );
    return { success: false, error: error.message };
  }
}

async function getPullRequests() {
  console.log(`[GITHUB] Fetching open pull requests from repository: ${REPO}`);
  try {
    let allPRs = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      console.log(`[GITHUB] Fetching PRs page ${page}`);
      const res = await axios.get(
        `https://api.github.com/repos/${REPO}/pulls`,
        {
          headers: { Authorization: `token ${GITHUB_TOKEN}` },
          params: {
            state: "open",
            per_page: perPage,
            page: page,
          },
        },
      );

      const prs = res.data;
      allPRs = allPRs.concat(prs);
      console.log(`[GITHUB] Page ${page}: Found ${prs.length} PRs`);

      if (prs.length < perPage) {
        break;
      }

      page++;
    }

    console.log(`[GITHUB] Total open PRs: ${allPRs.length}`);
    return allPRs;
  } catch (error) {
    console.error("[GITHUB] API error:", error.response?.data || error.message);
    throw new Error("PR 목록을 가져올 수 없습니다.");
  }
}

async function mergePullRequest(prNumber, prTitle) {
  console.log(`[MERGE] Merging PR #${prNumber}: ${prTitle}`);
  try {
    const response = await axios.put(
      `https://api.github.com/repos/${REPO}/pulls/${prNumber}/merge`,
      {
        commit_title: `Merge pull request #${prNumber}: ${prTitle}`,
        merge_method: "merge",
      },
      {
        headers: { Authorization: `token ${GITHUB_TOKEN}` },
      },
    );
    console.log(
      `[MERGE] PR #${prNumber} merged successfully. SHA: ${response.data.sha}`,
    );
    return { success: true, sha: response.data.sha };
  } catch (e) {
    console.error(
      `[MERGE] PR merge error for #${prNumber}:`,
      e.response?.data || e.message,
    );

    if (e.response?.status === 405) {
      return {
        success: false,
        conflict: false,
        message: e.response.data.message || "PR을 머지할 수 없는 상태입니다.",
      };
    }

    if (e.response?.status === 409) {
      return {
        success: false,
        conflict: true,
        message: e.response.data.message || "머지 충돌이 발생했습니다.",
      };
    }

    if (e.response?.status === 422) {
      return {
        success: false,
        conflict: false,
        message: e.response.data.message || "PR을 머지할 수 없습니다.",
      };
    }

    return { success: false, conflict: false, message: e.message };
  }
}

async function mergeMainIntoRelease() {
  console.log(`[MERGE] Merging main into release branch`);
  try {
    const mergeResponse = await axios.post(
      `https://api.github.com/repos/${REPO}/merges`,
      {
        base: "release",
        head: "main",
        commit_message: "Merge main into release via Telegram deploy bot",
      },
      {
        headers: { Authorization: `token ${GITHUB_TOKEN}` },
      },
    );
    console.log(
      `[MERGE] Successfully merged main into release. New commit: ${mergeResponse.data.sha}`,
    );
    return { success: true };
  } catch (e) {
    console.error(
      `[MERGE] main -> release merge error:`,
      e.response?.data || e.message,
    );

    if (e.response?.status === 409) {
      const errorMessage = e.response.data.message;
      if (
        errorMessage.includes("already up to date") ||
        errorMessage.includes("up-to-date")
      ) {
        console.log(`[MERGE] release branch is already up to date with main`);
        return {
          success: true,
          message: "release 브랜치가 이미 최신 상태입니다.",
        };
      }
      return {
        success: false,
        conflict: true,
        message: errorMessage,
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
        `[USER] Deploy command from user: ${username} (${firstName}), Chat ID: ${chatId}`,
      );

      if (!ALLOWED_USER_IDS.includes(chatId)) {
        console.log(`[AUTH] Unauthorized user: ${chatId} (${username})`);
        console.log(`[AUTH] Allowed users: ${ALLOWED_USER_IDS.join(", ")}`);
        const result = await sendTelegram(chatId, "⚠️ 권한이 없습니다.");
        if (!result.success) {
          console.error(
            `[AUTH] Failed to send unauthorized message:`,
            result.error,
          );
        }
        return res.status(200).json({ ok: true });
      }

      console.log(`[AUTH] Authorized user: ${chatId} (${username})`);

      try {
        console.log(`[WORKFLOW] Fetching open pull requests`);
        const prs = await getPullRequests();

        if (prs.length === 0) {
          console.log(`[WORKFLOW] No open PRs found`);
          const result = await sendTelegram(
            chatId,
            "ℹ️ 현재 열려있는 Pull Request가 없습니다.",
          );
          if (!result.success) {
            console.error(
              `[WORKFLOW] Failed to send empty PR message:`,
              result.error,
            );
          }
          return res.status(200).json({ ok: true });
        }

        // PR 정보를 캐시에 저장 (callback_data는 64바이트 제한)
        prs.forEach((pr) => {
          prCache.set(String(pr.number), {
            title: pr.title,
            baseBranch: pr.base.ref,
            headBranch: pr.head.ref,
          });
        });

        const buttons = prs.map((pr) => [
          {
            text: `#${pr.number} ${pr.title} (${pr.head.ref} → ${pr.base.ref})`,
            callback_data: `pr_${pr.number}`,
          },
        ]);

        console.log(
          `[WORKFLOW] Sending PR selection menu with ${buttons.length} options`,
        );
        const result = await sendTelegram(
          chatId,
          "🔽 머지할 Pull Request를 선택하세요:",
          {
            inline_keyboard: buttons,
          },
        );

        if (!result.success) {
          console.error(
            `[WORKFLOW] Failed to send PR selection message:`,
            result.error,
          );
          return res.status(500).json({ error: "Failed to send message" });
        }
        console.log(`[WORKFLOW] PR selection menu sent successfully`);
      } catch (error) {
        console.error(`[WORKFLOW] Error fetching PRs:`, error.message);
        const result = await sendTelegram(
          chatId,
          "❌ PR 목록을 가져오는데 실패했습니다.",
        );
        if (!result.success) {
          console.error(
            `[WORKFLOW] Failed to send error message:`,
            result.error,
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
        `[USER] Callback from user: ${username} (${firstName}), Chat ID: ${chatId}`,
      );
      console.log(`[USER] Callback data: ${callback.data}`);

      if (!ALLOWED_USER_IDS.includes(chatId)) {
        console.log(
          `[AUTH] Unauthorized callback from user: ${chatId} (${username})`,
        );
        return res.status(200).json({ ok: true });
      }

      const data = callback.data;

      if (data.startsWith("pr_")) {
        const prNumber = data.replace("pr_", "");
        const cached = prCache.get(prNumber);
        const prTitle = cached?.title || `PR #${prNumber}`;
        console.log(`[WORKFLOW] User selected PR #${prNumber}: ${prTitle}`);

        try {
          // Step 1: PR 머지 (GitHub 웹에서 Merge 버튼을 누른 것과 동일)
          console.log(`[WORKFLOW] Step 1: Merging PR #${prNumber}`);
          await sendTelegram(chatId, `⏳ PR #${prNumber} 머지 중입니다...`);

          const mergeResult = await mergePullRequest(Number(prNumber), prTitle);

          if (!mergeResult.success) {
            console.log(`[WORKFLOW] PR merge failed: ${mergeResult.message}`);
            const errMsg = mergeResult.conflict
              ? `❌ PR #${prNumber} 머지 충돌 발생!\n수동 해결이 필요합니다.\n오류: ${mergeResult.message}`
              : `❌ PR #${prNumber} 머지 실패\n오류: ${mergeResult.message}`;
            await sendTelegram(chatId, errMsg);
            return res.status(200).json({ ok: true });
          }

          console.log(
            `[WORKFLOW] Step 1 complete: PR #${prNumber} merged successfully`,
          );

          // Step 2: main 브랜치를 release에 머지 (git checkout release && git merge main && git push)
          console.log(`[WORKFLOW] Step 2: Merging main into release branch`);
          await sendTelegram(
            chatId,
            `✅ PR #${prNumber} 머지 완료!\n⏳ main → release 브랜치 머지 중입니다...`,
          );

          const releaseResult = await mergeMainIntoRelease();

          if (!releaseResult.success) {
            console.log(
              `[WORKFLOW] main -> release merge failed: ${releaseResult.message}`,
            );
            const errMsg = releaseResult.conflict
              ? `❌ main → release 머지 충돌 발생!\n수동 해결이 필요합니다.\n오류: ${releaseResult.message}`
              : `❌ main → release 머지 실패\n오류: ${releaseResult.message}`;
            await sendTelegram(chatId, errMsg);
            return res.status(200).json({ ok: true });
          }

          const releaseMsg = releaseResult.message
            ? `ℹ️ ${releaseResult.message}`
            : `✅ main → release 머지 및 푸시 완료!`;

          console.log(`[WORKFLOW] Step 2 complete: main merged into release`);

          await sendTelegram(
            chatId,
            `🚀 배포 완료!\n\n` +
              `• PR #${prNumber} (${prTitle}) 머지됨\n` +
              `• ${releaseMsg}\n` +
              (CI_LOG_URL ? `🔗 CI 로그: ${CI_LOG_URL}` : ""),
          );
        } catch (error) {
          console.error(
            `[WORKFLOW] Error during deploy process:`,
            error.message,
          );
          const result = await sendTelegram(
            chatId,
            `❌ 처리 중 오류 발생: ${error.message}`,
          );
          if (!result.success) {
            console.error(
              `[WORKFLOW] Failed to send error message:`,
              result.error,
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
