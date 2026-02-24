import axios from "axios";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPO;
const TRIGGER_SECRET = process.env.TRIGGER_SECRET;

async function mergePullRequest(prNumber, prTitle) {
  console.log(`[DEPLOY] Merging PR #${prNumber}: ${prTitle}`);
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
  console.log(`[DEPLOY] PR #${prNumber} merged. SHA: ${response.data.sha}`);
  return { success: true, sha: response.data.sha };
}

async function mergeMainIntoRelease() {
  console.log(`[DEPLOY] Merging main into release`);
  const response = await axios.post(
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
  console.log(`[DEPLOY] Merged main into release. SHA: ${response.data.sha}`);
  return { success: true };
}

export default async function handler(req, res) {
  console.log(`[DEPLOY] ${new Date().toISOString()} - deploy.js 실행됨`);

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Secret 검증
  const incomingSecret = req.headers["x-trigger-secret"] || req.body?.secret;
  if (!TRIGGER_SECRET || incomingSecret !== TRIGGER_SECRET) {
    console.warn(`[DEPLOY] Unauthorized request - invalid secret`);
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { pr_number, pr_label } = req.body;

  // pr_label: "123 | #123 PR제목 ..." 형식에서 번호 추출
  // pr_number: 직접 숫자로 전달된 경우
  const parsedNumber =
    pr_number || (pr_label ? pr_label.split("|")[0].trim() : null);

  if (!parsedNumber) {
    return res.status(400).json({ error: "pr_number or pr_label is required" });
  }

  const prTitle = pr_label
    ? pr_label.split("|")[1]?.trim()
    : `PR #${parsedNumber}`;
  console.log(`[DEPLOY] Starting deploy for PR #${parsedNumber}: ${prTitle}`);

  try {
    // Step 1: PR 머지
    await mergePullRequest(Number(parsedNumber), prTitle);

    // Step 2: main → release 머지
    try {
      await mergeMainIntoRelease();
    } catch (e) {
      // 이미 최신 상태면 무시
      if (e.response?.status === 409) {
        const msg = e.response.data.message || "";
        if (msg.includes("already up to date") || msg.includes("up-to-date")) {
          console.log(`[DEPLOY] Release already up to date with main`);
        } else {
          throw e;
        }
      } else {
        throw e;
      }
    }

    console.log(`[DEPLOY] Deploy complete for PR #${parsedNumber}`);
    return res.status(200).json({
      ok: true,
      message: `✅ PR #${parsedNumber} 머지 완료\nmain → release 배포 시작됨`,
    });
  } catch (error) {
    console.error(`[DEPLOY] Error:`, error.response?.data || error.message);

    const message =
      error.response?.status === 409
        ? `❌ 머지 충돌 발생 - 수동 해결 필요\n${error.response.data.message}`
        : `❌ 배포 실패: ${error.response?.data?.message || error.message}`;

    return res.status(500).json({ ok: false, message });
  }
}
